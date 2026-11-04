package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/sonnes/durabase/cli/internal/migrations"
	"github.com/sonnes/durabase/cli/internal/schema"
)

// replay returns the migrations of the project and a database with them run.
func replay(ctx context.Context, dir string) ([]migrations.File, *sql.DB, error) {
	files, err := migrations.List(filepath.Join(dir, "migrations"))
	if err != nil {
		return nil, nil, err
	}
	db, err := schema.Open(ctx)
	if err != nil {
		return nil, nil, err
	}
	err = migrations.Replay(ctx, db, files)
	if err != nil {
		return nil, nil, errors.Join(err, db.Close())
	}
	return files, db, nil
}

func okf(format string, a ...any) {
	fmt.Printf("✓ "+format+"\n", a...)
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}
