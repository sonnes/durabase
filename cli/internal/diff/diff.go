package diff

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/sqldef/sqldef/v3/database"
	"github.com/sqldef/sqldef/v3/parser"
	sqldefschema "github.com/sqldef/sqldef/v3/schema"

	"durabase/cli/internal/schema"
	"durabase/cli/internal/sqltext"
)

// Result is the migration.
type Result struct {
	Statements []string
	Warnings   []string // the changes that remove data
}

// Empty tells if the schema files and the migrations agree.
func (r Result) Empty() bool {
	return len(r.Statements) == 0
}

// Plan returns the statements that change current into desired. It runs the
// statements on current.
func Plan(ctx context.Context, current, desired *sql.DB) (Result, error) {
	var res Result
	cur, err := schema.Read(ctx, current)
	if err != nil {
		return res, err
	}
	des, err := schema.Read(ctx, desired)
	if err != nil {
		return res, err
	}

	ddls, err := sqldefschema.GenerateIdempotentDDLs(
		sqldefschema.GeneratorModeSQLite3,
		database.NewParser(parser.ParserModeSQLite3),
		schema.Export(des),
		schema.Export(cur),
		database.GeneratorConfig{EnableDrop: true},
		"",
	)
	if err != nil {
		return res, fmt.Errorf("sqldef: %w", err)
	}

	for _, d := range ddls {
		d = tidy(strings.TrimSuffix(strings.TrimSpace(d), ";"))
		if d == "" {
			continue
		}
		res.Statements = append(res.Statements, d)
		if w := warning(d); w != "" {
			res.Warnings = append(res.Warnings, w)
		}
	}

	err = schema.Exec(ctx, current, res.Statements)
	if err != nil {
		return res, fmt.Errorf("SQLite refuses the migration: %w", err)
	}
	return res, nil
}

// tidy removes the space at the end of each line, and each empty line.
// sqldef removes the comments of the schema files, but not their lines.
func tidy(statement string) string {
	var lines []string
	for line := range strings.SplitSeq(statement, "\n") {
		line = strings.TrimRight(line, " \t\r")
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

func warning(statement string) string {
	n := sqltext.Normalize(statement)
	switch {
	case strings.HasPrefix(n, "drop table"):
		return "this migration drops a table, with its data: " + statement
	case strings.Contains(n, " drop column "):
		return "this migration drops a column, with its data: " + statement
	}
	return ""
}
