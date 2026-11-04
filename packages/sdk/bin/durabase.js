#!/usr/bin/env node
// Starts the durabase CLI binary for this platform. The binary comes from the
// optional package @durabaseio/cli-<platform>-<arch>. DURABASE_BIN overrides it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.platform === "win32" ? "durabase.exe" : "durabase";

function find() {
  if (process.env.DURABASE_BIN) return process.env.DURABASE_BIN;
  const pkg = `@durabaseio/cli-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
  } catch {}
  // In the durabase repo: the binary of `pnpm build:cli`.
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "cli", "bin", exe);
  if (existsSync(local)) return local;
  console.error(`durabase: no binary for ${process.platform}-${process.arch}. Install ${pkg}, or set DURABASE_BIN.`);
  process.exit(1);
}

const result = spawnSync(find(), process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
