#!/usr/bin/env node
// Builds one npm package of the durabase CLI for each platform, into
// dist/npm/cli-<platform>-<arch>/. @durabaseio/sdk lists each package as an
// optional dependency, so npm installs only the package of the platform.
// The version of each package is the version of @durabaseio/sdk.
//
//   node scripts/build-npm.mjs
//   command npm publish dist/npm/cli-darwin-arm64

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8"));
const version = sdk.version;

// The platform and the arch of Node, and the GOOS and the GOARCH of Go.
export const TARGETS = [
  { platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" },
  { platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" },
  { platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64" },
  { platform: "linux", arch: "x64", goos: "linux", goarch: "amd64" },
  { platform: "win32", arch: "x64", goos: "windows", goarch: "amd64" },
];

const out = join(root, "dist/npm");
rmSync(out, { recursive: true, force: true });

for (const t of TARGETS) {
  const name = `@durabaseio/cli-${t.platform}-${t.arch}`;
  const dir = join(out, `cli-${t.platform}-${t.arch}`);
  const exe = t.platform === "win32" ? "durabase.exe" : "durabase";
  mkdirSync(join(dir, "bin"), { recursive: true });

  execFileSync(
    "go",
    ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", join(dir, "bin", exe), "."],
    { cwd: join(root, "cli"), stdio: "inherit", env: { ...process.env, GOOS: t.goos, GOARCH: t.goarch, CGO_ENABLED: "0" } },
  );

  const pkg = {
    name,
    version,
    description: `The durabase CLI for ${t.platform}-${t.arch}. Install @durabaseio/sdk, not this package.`,
    license: sdk.license,
    repository: { ...sdk.repository, directory: "cli" },
    os: [t.platform],
    cpu: [t.arch],
    files: ["bin", "LICENSE"],
    publishConfig: { access: "public" },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  console.log(`✓ ${name}@${version}`);
}
