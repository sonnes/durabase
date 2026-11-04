package gen

import (
	"regexp"
	"strings"

	"github.com/sonnes/durabase/cli/internal/schema"
	"github.com/sonnes/durabase/cli/internal/sqltext"
)

// relationships returns, for each table, the tables that it can embed:
// "one" for the table that a foreign key points to, "many" for a table with a
// foreign key that points here. If two foreign keys join the same tables, the
// first one counts.
func relationships(snap *schema.Snapshot) map[string]map[string]string {
	out := map[string]map[string]string{}
	add := func(from, to, kind string) {
		if out[from] == nil {
			out[from] = map[string]string{}
		}
		if _, ok := out[from][to]; !ok {
			out[from][to] = kind
		}
	}
	for _, name := range snap.TableNames() {
		for _, fk := range snap.Tables[name].ForeignKeys {
			parent := actualName(snap, fk.Table)
			add(name, parent, "one")
			add(parent, name, "many")
		}
	}
	return out
}

func actualName(snap *schema.Snapshot, name string) string {
	for n := range snap.Tables {
		if strings.EqualFold(n, name) {
			return n
		}
	}
	return name
}

var inList = regexp.MustCompile(`^([a-z_][a-z0-9_$]*) in\((.*)\)$`)

// checkUnions returns the literal values of each CHECK in the form
// "column IN (...)", as TypeScript types.
func checkUnions(t *schema.Table) map[string]string {
	out := map[string]string{}
	for _, check := range t.Checks {
		m := inList.FindStringSubmatch(check)
		if m == nil {
			continue
		}
		col := t.Column(m[1])
		if col == nil {
			continue
		}
		values, ok := literals(m[2])
		if ok {
			out[col.Name] = strings.Join(values, " | ")
		}
	}
	return out
}

// literals returns the values of a list such as 'a', 'b', 3 as TypeScript
// literals. ok is false if the list has anything else.
func literals(list string) (values []string, ok bool) {
	for _, tok := range sqltext.Code(list) {
		switch {
		case tok.Kind == sqltext.String:
			v := strings.ReplaceAll(tok.Text[1:len(tok.Text)-1], "''", "'")
			values = append(values, quote(v))
		case tok.Kind == sqltext.Number:
			values = append(values, tok.Text)
		case tok.Kind == sqltext.Punct && tok.Text == ",":
		default:
			return nil, false
		}
	}
	return values, len(values) > 0
}

func rowType(c schema.Column, unions map[string]string) string {
	t := unions[c.Name]
	if t == "" {
		t = affinity(c.Type)
	}
	isNullable := !c.NotNull && c.PK == 0
	if isNullable {
		t += " | null"
	}
	return t
}

// affinity returns the TypeScript type for a declared SQLite type, with the
// rules of https://www.sqlite.org/datatype3.html#determination_of_column_affinity.
func affinity(declared string) string {
	d := strings.ToUpper(declared)
	switch {
	case strings.Contains(d, "INT"):
		return "number"
	case strings.Contains(d, "CHAR"), strings.Contains(d, "CLOB"), strings.Contains(d, "TEXT"):
		return "string"
	case strings.Contains(d, "BLOB"):
		return "ArrayBuffer"
	case d == "":
		return "string | number | ArrayBuffer"
	default:
		return "number"
	}
}

// optionalOnInsert tells if an insert can leave the column out: it has a
// default, it can be NULL, or it is the rowid.
func optionalOnInsert(t *schema.Table, c schema.Column) bool {
	hasDefault := c.Default != nil
	isNullable := !c.NotNull && c.PK == 0
	if hasDefault || isNullable {
		return true
	}

	pkColumns := 0
	for _, col := range t.Columns {
		if col.PK > 0 {
			pkColumns++
		}
	}
	isRowid := c.PK > 0 &&
		pkColumns == 1 &&
		c.Type == "INTEGER" &&
		!strings.Contains(t.Options, "without rowid")
	return isRowid
}

var identifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

func key(name string) string {
	if identifier.MatchString(name) {
		return name
	}
	return quote(name)
}
