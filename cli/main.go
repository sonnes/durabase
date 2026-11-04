package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
)

const version = "0.1.0"

const usage = `durabase writes migrations and types for a durabase project.

Usage:
  durabase db diff -f <name> [-dir durabase]
  durabase gen [-dir durabase] [-out durabase/durabase.gen.ts] [-functions <dir>]
  durabase version

The project folder (-dir) holds schema/*.sql, the desired state that you
edit, and migrations/*.sql, which durabase writes.
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err := run(ctx, os.Args[1:])
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "✗", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	isDiff := len(args) >= 2 && args[0] == "db" && args[1] == "diff"
	switch {
	case isDiff:
		return dbDiff(ctx, args[2:])
	case len(args) >= 1 && args[0] == "gen":
		return genTypes(ctx, args[1:])
	case len(args) >= 1 && args[0] == "version":
		fmt.Println(version)
		return nil
	}

	fmt.Print(usage)
	isHelp := len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help"
	if isHelp {
		return nil
	}
	return errors.New("unknown command: " + strings.Join(args, " "))
}
