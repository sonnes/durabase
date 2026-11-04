package schema

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"durabase/cli/internal/sqltext"
)

// Column is one column of a table, from PRAGMA table_xinfo.
type Column struct {
	Name    string
	Type    string  // the declared type, in upper case
	NotNull bool    // the column has NOT NULL
	Default *string // in the normal form of [sqltext.Normalize]
	PK      int     // the position in the primary key, 0 if none
	Hidden  int     // 2 or 3 for a generated column
}

// Generated tells if the column is a generated column.
func (c Column) Generated() bool {
	return c.Hidden == 2 || c.Hidden == 3
}

// ForeignKey is one foreign key of a table.
type ForeignKey struct {
	Table string   // the table that the key points to
	From  []string // the columns of this table
	To    []string // the columns of the other table
}

// Table is a table, with the parts that durabase gen uses.
type Table struct {
	Name        string
	SQL         string // the CREATE TABLE statement
	Columns     []Column
	ForeignKeys []ForeignKey
	Checks      []string // CHECK expressions, in normal form
	Options     string   // "strict", "without rowid", in normal form
}

// Column returns the column with this name, or nil.
func (t *Table) Column(name string) *Column {
	for i := range t.Columns {
		if strings.EqualFold(t.Columns[i].Name, name) {
			return &t.Columns[i]
		}
	}
	return nil
}

// Object is an index, a view or a trigger.
type Object struct {
	Type  string // "index", "view" or "trigger"
	Name  string
	Table string
	SQL   string
}

// Snapshot is the full schema of one database.
type Snapshot struct {
	Tables  map[string]*Table
	Objects map[string]Object // the key is type + ":" + name
}

// TableNames returns the names of the tables in order.
func (s *Snapshot) TableNames() []string {
	names := make([]string, 0, len(s.Tables))
	for name := range s.Tables {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// internal tells if a table belongs to SQLite, Cloudflare or durabase.
func internal(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, "sqlite_") ||
		strings.HasPrefix(n, "_cf_") ||
		strings.HasPrefix(n, "_durabase_")
}

// Read returns the snapshot of the database.
func Read(ctx context.Context, db *sql.DB) (*Snapshot, error) {
	objects, err := readObjects(ctx, db)
	if err != nil {
		return nil, err
	}

	snap := &Snapshot{
		Tables:  map[string]*Table{},
		Objects: map[string]Object{},
	}
	for _, o := range objects {
		if o.Type != "table" {
			snap.Objects[o.Type+":"+o.Name] = o
			continue
		}
		t, err := readTable(ctx, db, o.Name, o.SQL)
		if err != nil {
			return nil, fmt.Errorf("read table %s: %w", o.Name, err)
		}
		snap.Tables[o.Name] = t
	}
	return snap, nil
}

func readObjects(ctx context.Context, db *sql.DB) (objects []Object, err error) {
	rows, err := db.QueryContext(
		ctx,
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL",
	)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()

	for rows.Next() {
		var o Object
		err := rows.Scan(&o.Type, &o.Name, &o.Table, &o.SQL)
		if err != nil {
			return nil, err
		}
		if !internal(o.Table) {
			objects = append(objects, o)
		}
	}
	return objects, rows.Err()
}

func readTable(ctx context.Context, db *sql.DB, name, createSQL string) (*Table, error) {
	q := sqltext.QuoteIdent(name)

	columns, err := readColumns(ctx, db, q)
	if err != nil {
		return nil, err
	}
	fks, err := readForeignKeys(ctx, db, q)
	if err != nil {
		return nil, err
	}

	checks, options := parseCreate(createSQL)
	return &Table{
		Name:        name,
		SQL:         createSQL,
		Columns:     columns,
		ForeignKeys: fks,
		Checks:      checks,
		Options:     options,
	}, nil
}

func readColumns(ctx context.Context, db *sql.DB, q string) (columns []Column, err error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_xinfo("+q+")")
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()

	for rows.Next() {
		var (
			cid     int
			c       Column
			notNull int
			dflt    sql.NullString
		)
		err := rows.Scan(&cid, &c.Name, &c.Type, &notNull, &dflt, &c.PK, &c.Hidden)
		if err != nil {
			return nil, err
		}
		c.Type = strings.Join(strings.Fields(strings.ToUpper(c.Type)), " ")
		c.NotNull = notNull == 1
		if dflt.Valid {
			d := sqltext.Normalize(dflt.String)
			c.Default = &d
		}
		columns = append(columns, c)
	}
	return columns, rows.Err()
}

func readForeignKeys(ctx context.Context, db *sql.DB, q string) (fks []ForeignKey, err error) {
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_list("+q+")")
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()

	byID := map[int]*ForeignKey{}
	var ids []int
	for rows.Next() {
		var (
			id, seq                     int
			table, from                 string
			to                          sql.NullString
			onUpdate, onDelete, matchBy string
		)
		err := rows.Scan(&id, &seq, &table, &from, &to, &onUpdate, &onDelete, &matchBy)
		if err != nil {
			return nil, err
		}
		fk, ok := byID[id]
		if !ok {
			fk = &ForeignKey{Table: table}
			byID[id] = fk
			ids = append(ids, id)
		}
		fk.From = append(fk.From, from)
		fk.To = append(fk.To, to.String)
	}

	slices.Sort(ids)
	fks = make([]ForeignKey, 0, len(ids))
	for _, id := range ids {
		fks = append(fks, *byID[id])
	}
	return fks, rows.Err()
}
