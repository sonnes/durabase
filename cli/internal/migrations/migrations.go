package migrations

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/sonnes/durabase/cli/internal/schema"
	"github.com/sonnes/durabase/cli/internal/sqltext"
)

var (
	fileName = regexp.MustCompile(`^(\d{4,})_([a-z0-9_]+)\.sql$`)
	name     = regexp.MustCompile(`^[a-z0-9_]+$`)
)

// ValidName tells if a name can be the name of a migration.
func ValidName(s string) bool {
	return name.MatchString(s)
}

// File is one migration.
type File struct {
	Version    int
	Name       string
	Path       string
	Statements []string
}

// List reads the migrations in dir, in version order. A missing dir has no
// migrations.
func List(dir string) ([]File, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var files []File
	for _, e := range entries {
		isSQL := !e.IsDir() && strings.HasSuffix(e.Name(), ".sql")
		if !isSQL {
			continue
		}
		f, err := read(dir, e.Name())
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	slices.SortFunc(files, func(a, b File) int {
		return a.Version - b.Version
	})
	for i := 1; i < len(files); i++ {
		if files[i].Version == files[i-1].Version {
			return nil, fmt.Errorf("two migrations have the version %d", files[i].Version)
		}
	}
	return files, nil
}

func read(dir, base string) (File, error) {
	m := fileName.FindStringSubmatch(base)
	if m == nil {
		return File{}, fmt.Errorf("%s: a migration file name must be NNNN_name.sql", base)
	}
	version, err := strconv.Atoi(m[1])
	if err != nil {
		return File{}, err
	}

	path := filepath.Join(dir, base)
	text, err := os.ReadFile(path)
	if err != nil {
		return File{}, err
	}
	return File{
		Version:    version,
		Name:       m[2],
		Path:       path,
		Statements: sqltext.Split(string(text)),
	}, nil
}

// Replay runs each migration on db, one transaction for each migration.
func Replay(ctx context.Context, db *sql.DB, files []File) error {
	for _, f := range files {
		err := schema.Exec(ctx, db, f.Statements)
		if err != nil {
			return fmt.Errorf("replay %s: %w", filepath.Base(f.Path), err)
		}
	}
	return nil
}

// Next returns the version of the next migration.
func Next(files []File) int {
	if len(files) == 0 {
		return 1
	}
	return files[len(files)-1].Version + 1
}

// Write writes a new migration file and returns its path. Each line of
// header becomes a comment at the top of the file.
func Write(dir string, version int, migration string, header, statements []string) (string, error) {
	err := os.MkdirAll(dir, 0o750)
	if err != nil {
		return "", err
	}

	path := filepath.Join(dir, fmt.Sprintf("%04d_%s.sql", version, migration))
	_, err = os.Stat(path)
	if err == nil {
		return "", fmt.Errorf("%s exists", path)
	}

	var b strings.Builder
	for _, h := range header {
		b.WriteString("-- " + h + "\n")
	}
	if len(header) > 0 {
		b.WriteString("\n")
	}
	for _, s := range statements {
		b.WriteString(strings.TrimSuffix(strings.TrimSpace(s), ";") + ";\n\n")
	}
	text := strings.TrimRight(b.String(), "\n") + "\n"
	return path, os.WriteFile(path, []byte(text), 0o600)
}

// LoadSchema runs the schema files in dir on db, in name order, and returns
// their paths.
func LoadSchema(ctx context.Context, db *sql.DB, dir string) ([]string, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no .sql files in %s", dir)
	}
	slices.Sort(paths)

	statements, err := readStatements(paths)
	if err != nil {
		return nil, err
	}
	err = schema.Exec(ctx, db, statements)
	if err != nil {
		return nil, fmt.Errorf("load the schema files: %w", err)
	}
	return paths, nil
}

func readStatements(paths []string) ([]string, error) {
	var statements []string
	for _, p := range paths {
		text, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		statements = append(statements, sqltext.Split(string(text))...)
	}
	return statements, nil
}
