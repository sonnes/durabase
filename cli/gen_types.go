package main

import (
	"context"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"

	"github.com/sonnes/durabase/cli/internal/gen"
	"github.com/sonnes/durabase/cli/internal/schema"
)

// genTypes writes durabase.gen.ts from the migrations.
func genTypes(ctx context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("gen", flag.ContinueOnError)
	dir := fs.String("dir", "durabase", "the project folder")
	out := fs.String("out", "", "the output file (default <dir>/durabase.gen.ts)")
	functions := fs.String("functions", "", "the folder of the functions, with an index.ts")
	err = fs.Parse(args)
	if err != nil {
		return err
	}
	if *out == "" {
		*out = filepath.Join(*dir, "durabase.gen.ts")
	}

	files, db, err := replay(ctx, *dir)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, db.Close()) }()

	snap, err := schema.Read(ctx, db)
	if err != nil {
		return err
	}
	opts, err := genOptions(*out, *functions)
	if err != nil {
		return err
	}

	text := gen.TypeScript(snap, files, opts)
	err = os.MkdirAll(filepath.Dir(*out), 0o750)
	if err != nil {
		return err
	}
	err = os.WriteFile(*out, []byte(text), 0o600)
	if err != nil {
		return err
	}
	okf("Wrote %s (%s, %s)", *out, plural(len(snap.Tables), "table"), plural(len(files), "migration"))
	return nil
}

// genOptions returns the import path of the functions, relative to the
// output file.
func genOptions(out, functions string) (gen.Options, error) {
	if functions == "" {
		return gen.Options{}, nil
	}
	rel, err := filepath.Rel(filepath.Dir(out), functions)
	if err != nil {
		return gen.Options{}, err
	}
	rel = filepath.ToSlash(rel)
	if !strings.HasPrefix(rel, ".") {
		rel = "./" + rel
	}
	return gen.Options{FunctionsImport: rel}, nil
}
