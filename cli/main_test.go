package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const schemaSQL = `
create table orders (
  id text primary key,
  state text not null check (state in ('pending', 'paid')),
  notes text,
  seq integer not null default 0
);
create table order_items (
  id integer primary key,
  order_id text not null references orders (id),
  title text not null
);`

func TestDiffThenGen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "schema"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "schema", "orders.sql"), []byte(schemaSQL), 0o600))

	require.NoError(t, run(ctx, []string{"db", "diff", "-f", "init", "-dir", dir}))
	assert.FileExists(t, filepath.Join(dir, "migrations", "0001_init.sql"))

	// A second diff finds no change and writes no file.
	require.NoError(t, run(ctx, []string{"db", "diff", "-f", "again", "-dir", dir}))
	assert.NoFileExists(t, filepath.Join(dir, "migrations", "0002_again.sql"))

	out := filepath.Join(dir, "worker", "durabase.gen.ts")
	require.NoError(t, run(ctx, []string{
		"gen",
		"-dir", dir,
		"-out", out,
		"-functions", filepath.Join(dir, "functions"),
	}))

	text, err := os.ReadFile(out)
	require.NoError(t, err)
	for _, want := range []string{
		`import type * as functions from "../functions";`,
		`state: "pending" | "paid";`,
		`notes: string | null;`,
		`seq?: number;`,
		`id?: number;`,
		`order_items: "many";`,
		`orders: "one";`,
		`name: "init",`,
	} {
		assert.Contains(t, string(text), want)
	}
}

func TestRun(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{name: "help", args: []string{"help"}},
		{name: "no args", args: nil},
		{name: "version", args: []string{"version"}},
		{name: "unknown", args: []string{"nope"}, wantErr: "unknown command: nope"},
		{name: "diff with no name", args: []string{"db", "diff"}, wantErr: "give the migration a name"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := run(context.Background(), tt.args)
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.ErrorContains(t, err, tt.wantErr)
		})
	}
}
