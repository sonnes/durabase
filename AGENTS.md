# durabase

durabase brings the developer experience of Supabase to Cloudflare Durable Objects. `cli/` holds the `durabase` CLI, in Go. `packages/sdk/` holds `@durabase/sdk`, in TypeScript.

## Go

These rules apply to `cli/`.

### TDD

Write the test before the code. Run the test, and make sure that it fails. Then write the minimum code that makes the test pass.

- Use `github.com/stretchr/testify`: `require` for a fatal assertion, `assert` for a non-fatal assertion.
- Write table-driven tests.

### Build

Use `make` in `cli/` for each build, test and lint step. The Makefile pins the version of golangci-lint, and `.golangci.yml` holds the lint rules. A direct `go test`, `go vet` or `golangci-lint` call gives different results. Before a commit, run `make check`.

| Target | Purpose |
|---|---|
| `make setup` | Prepare the project and update the dependencies |
| `make build` | Build all packages (writes no binary) |
| `make install` | Build the binary into `cli/bin/durabase` |
| `make test` | Run all tests, with the race detector and coverage |
| `make check` | Tidy and lint (`make tidy` and `make lint`) |
| `make lint` | Run golangci-lint with auto-fix |
| `make tidy` | Run `go mod tidy` |

### Style

Write vertical code that is easy to read. More lines are better than longer lines.

- Keep each package small, with one job. Do not make circular dependencies.
- For a long function call, put each argument on its own line, with a comma after the last argument.
- Use a variable for a part of a deeply nested expression.
- Give a long condition a name, such as `isTrigger := ...`.
- Return early, so the logic stays flat.
- Write a struct literal with one field on each line.
- Give each function that does I/O a `context.Context` as its first parameter.
- Check the error of each `Close`. In a function that returns an error, use `defer func() { err = errors.Join(err, rows.Close()) }()`.

### Documentation

- Write a GoDoc comment for each exported function and type. Use `[pkg.Type]` links.
- Put the package comment in `doc.go`.

## TypeScript

These rules apply to `packages/sdk/`.

- `pnpm test` runs the tests in workerd, with the Durable Object of `test/wrangler.jsonc`.
- `pnpm typecheck` also compiles `test/types.check.ts`, which holds the type tests. A type test that must fail has `// @ts-expect-error`.
- After a change to `test/durabase/schema/`, run the CLI to write the migration and `test/durabase.gen.ts`.
