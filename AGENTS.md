# durabase

durabase brings the developer experience of Supabase to Cloudflare Durable Objects. `cli/` holds the `durabase` CLI, in Go. `packages/sdk/` holds `@durabaseio/sdk`, in TypeScript.

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

- `pnpm test` runs the tests in workerd, with the Durable Objects and the R2 bucket of `test/wrangler.jsonc`.
- `pnpm typecheck` also compiles `test/types.check.ts`, which holds the type tests. A type test that must fail has `// @ts-expect-error`.
- After a change to `test/durabase/schema/`, run the CLI to write the migration and `test/durabase.gen.ts`.
- The SDK owns the schema of the Mailbox DO, in `src/mailbox/schema/mailbox.sql`. After a change to this file, run these commands in `packages/sdk/`:
  ```bash
  ../../cli/bin/durabase db diff -dir src/mailbox -f <name>
  ../../cli/bin/durabase gen -dir src/mailbox -out src/mailbox/mailbox.gen.ts -functions src/mailbox/functions
  ```
- Do not change a migration in `src/mailbox/migrations/` after a release. Each project that has a mailbox applies these migrations.

## Release

The npm packages are `@durabaseio/sdk` and one `@durabaseio/cli-<platform>-<arch>` package for each platform. They all have the version of `packages/sdk/package.json`. In this shell, `npm` can be an alias for `pnpm`. Use `command npm` for each publish.

1. Set the new version in `packages/sdk/package.json`, in `version` and in each `optionalDependencies` entry.
2. Run `node scripts/build-npm.mjs`. It builds the CLI for each platform into `dist/npm/`.
3. Publish each CLI package: `command npm publish dist/npm/cli-<platform>-<arch>`.
4. Run `pnpm install`, so that the lockfile gets the new versions.
5. In `packages/sdk/`, run `command npm publish`.
6. Tag the commit `v<version>`.
