package gen

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/sonnes/durabase/cli/internal/migrations"
	"github.com/sonnes/durabase/cli/internal/schema"
	"github.com/sonnes/durabase/cli/internal/sqltext"
)

func TestAffinity(t *testing.T) {
	tests := []struct {
		declared string
		want     string
	}{
		{declared: "INTEGER", want: "number"},
		{declared: "BIGINT", want: "number"},
		{declared: "VARCHAR(20)", want: "string"},
		{declared: "text", want: "string"},
		{declared: "BLOB", want: "ArrayBuffer"},
		{declared: "REAL", want: "number"},
		{declared: "", want: "string | number | ArrayBuffer"},
	}

	for _, tt := range tests {
		t.Run(tt.declared, func(t *testing.T) {
			assert.Equal(t, tt.want, affinity(tt.declared))
		})
	}
}

func TestLiterals(t *testing.T) {
	tests := []struct {
		list   string
		want   []string
		wantOK bool
	}{
		{list: "'a','it''s'", want: []string{`"a"`, `"it's"`}, wantOK: true},
		{list: "1,2", want: []string{"1", "2"}, wantOK: true},
		{list: "'a',lower(x)", wantOK: false},
		{list: "", wantOK: false},
	}

	for _, tt := range tests {
		t.Run(tt.list, func(t *testing.T) {
			values, ok := literals(tt.list)
			assert.Equal(t, tt.wantOK, ok)
			if tt.wantOK {
				assert.Equal(t, tt.want, values)
			}
		})
	}
}

func TestTypeScript(t *testing.T) {
	ctx := context.Background()
	db, err := schema.Open(ctx)
	require.NoError(t, err)
	defer func() { assert.NoError(t, db.Close()) }()

	statements := sqltext.Split(`
create table orders (id text primary key, state text not null check (state in ('pending', 'paid')));
create table order_items (id integer primary key, order_id text not null references orders (id));`)
	require.NoError(t, schema.Exec(ctx, db, statements))
	snap, err := schema.Read(ctx, db)
	require.NoError(t, err)

	files := []migrations.File{
		{
			Version:    1,
			Name:       "init",
			Statements: statements,
		},
	}
	text := TypeScript(snap, files, Options{FunctionsImport: "../functions"})

	for _, want := range []string{
		`import type * as functions from "../functions";`,
		`export type Tables = {`,
		`state: "pending" | "paid";`,
		`id?: number;`,
		`order_items: "many";`,
		`orders: "one";`,
		`functions: FunctionsOf<typeof functions>;`,
		`name: "init",`,
	} {
		assert.Contains(t, text, want)
	}
}

func TestQuote(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: `a "b"`, want: `"a \"b\""`},
		{input: `back\slash`, want: `"back\\slash"`},
		{input: "two\nlines", want: `"two\nlines"`},
		{input: "tab\t", want: `"tab\u0009"`},
		{input: "x >= 1 & y < 2", want: `"x >= 1 & y < 2"`},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.want, quote(tt.input))
		})
	}
}
