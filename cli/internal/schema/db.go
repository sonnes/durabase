package schema

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	// The SQLite driver, in Go with no cgo, so the CLI builds for each
	// platform from one machine.
	_ "modernc.org/sqlite"
)

// Open returns a new empty in-memory database.
func Open(ctx context.Context) (*sql.DB, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, err
	}

	// Each connection to ":memory:" is a different database. Keep one.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	_, err = db.ExecContext(ctx, "PRAGMA foreign_keys = ON")
	if err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return db, nil
}

// Exec runs the statements in one transaction, as the Durable Object does
// for one migration.
func Exec(ctx context.Context, db *sql.DB, statements []string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	for _, s := range statements {
		_, err := tx.ExecContext(ctx, s)
		if err != nil {
			err = fmt.Errorf("%w\nin: %s", err, s)
			return errors.Join(err, tx.Rollback())
		}
	}
	return tx.Commit()
}
