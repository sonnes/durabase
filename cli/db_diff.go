package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/sonnes/durabase/cli/internal/diff"
	"github.com/sonnes/durabase/cli/internal/migrations"
	"github.com/sonnes/durabase/cli/internal/policies"
	"github.com/sonnes/durabase/cli/internal/schema"
)

// dbDiff writes the migration that changes the migrations into the schema
// files.
func dbDiff(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("db diff", flag.ContinueOnError)
	name := fs.String("f", "", "the name of the new migration, such as order_notes")
	dir := fs.String("dir", "durabase", "the project folder")
	err = fs.Parse(args)
	if err != nil {
		return err
	}
	if !migrations.ValidName(*name) {
		return errors.New("give the migration a name with -f, in lower case: a-z, 0-9 and _")
	}

	files, current, err := replay(ctx, *dir)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, current.Close()) }()

	desired, err := schema.Open(ctx)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, desired.Close()) }()

	schemaDir := filepath.Join(*dir, "schema")
	paths, err := migrations.LoadSchema(ctx, desired, schemaDir)
	if err != nil {
		return err
	}
	snap, err := schema.Read(ctx, desired)
	if err != nil {
		return err
	}
	okf("Read %s/ (%s, %s)", schemaDir, plural(len(paths), "file"), plural(len(snap.Tables), "table"))
	okf("Replayed %s in memory", plural(len(files), "migration"))

	res, err := diff.Plan(ctx, current, desired)
	if err != nil {
		return err
	}

	policyStatements, err := diffPolicies(ctx, *dir, snap, current)
	if err != nil {
		return err
	}
	res.Statements = append(res.Statements, policyStatements...)

	if res.Empty() {
		okf("No changes. The schema files, the policies and the migrations agree.")
		return nil
	}
	return writeMigration(*dir, *name, files, res)
}

// diffPolicies reads policies.yaml of the project, checks it against snap,
// and returns the statements that store its rules.
func diffPolicies(ctx context.Context, dir string, snap *schema.Snapshot, current *sql.DB) ([]string, error) {
	path := filepath.Join(dir, "policies.yaml")
	rules, err := policies.Load(path, snap)
	if err != nil {
		return nil, err
	}
	if rules != nil {
		count := fmt.Sprintf("%d policies", len(rules))
		if len(rules) == 1 {
			count = "1 policy"
		}
		okf("Read %s (%s)", path, count)
	}
	return policies.Diff(ctx, current, rules)
}

func writeMigration(dir, name string, files []migrations.File, res diff.Result) error {
	for _, s := range res.Statements {
		fmt.Println("+", oneLine(s))
	}
	header := make([]string, 0, len(res.Warnings))
	for _, w := range res.Warnings {
		fmt.Fprintln(os.Stderr, "! "+w)
		header = append(header, "Warning: "+w)
	}

	path, err := migrations.Write(
		filepath.Join(dir, "migrations"),
		migrations.Next(files),
		name,
		header,
		res.Statements,
	)
	if err != nil {
		return err
	}
	okf("Wrote %s", path)
	return nil
}
