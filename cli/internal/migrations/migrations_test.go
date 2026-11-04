package migrations

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidName(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{name: "order_notes", want: true},
		{name: "v2", want: true},
		{name: "", want: false},
		{name: "Order", want: false},
		{name: "a-b", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ValidName(tt.name))
		})
	}
}

func TestWriteThenList(t *testing.T) {
	dir := t.TempDir()

	path, err := Write(dir, 1, "init", []string{"note"}, []string{"create table a (x text);"})
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(dir, "0001_init.sql"), path)

	_, err = Write(dir, 2, "more", nil, []string{"create table b (y text)"})
	require.NoError(t, err)

	files, err := List(dir)
	require.NoError(t, err)
	require.Len(t, files, 2)
	assert.Equal(t, "init", files[0].Name)
	assert.Equal(t, []string{"create table a (x text)"}, files[0].Statements)
	assert.Equal(t, 3, Next(files))
}

func TestWriteRefusesAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	_, err := Write(dir, 1, "init", nil, []string{"select 1"})
	require.NoError(t, err)

	_, err = Write(dir, 1, "init", nil, []string{"select 2"})
	require.Error(t, err)
}

func TestList(t *testing.T) {
	tests := []struct {
		name    string
		files   []string
		wantErr string
	}{
		{
			name:    "bad name",
			files:   []string{"init.sql"},
			wantErr: "must be NNNN_name.sql",
		},
		{
			name:    "two versions",
			files:   []string{"0001_a.sql", "0001_b.sql"},
			wantErr: "two migrations have the version 1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, f := range tt.files {
				require.NoError(t, os.WriteFile(filepath.Join(dir, f), []byte("select 1;"), 0o600))
			}
			_, err := List(dir)
			require.ErrorContains(t, err, tt.wantErr)
		})
	}
}

func TestListMissingDir(t *testing.T) {
	files, err := List(filepath.Join(t.TempDir(), "nope"))
	require.NoError(t, err)
	assert.Empty(t, files)
}
