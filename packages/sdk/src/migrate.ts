// Applies the migrations that did not run before. The Database DO calls this
// function in blockConcurrencyWhile, so no call runs before it ends.

import { DurabaseError, ErrorCode } from "./protocol";

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS_TABLE = "_durabase_migrations";

// Each migration runs in one transaction. If a statement fails, SQLite rolls
// back that migration, and the migrations before it stay applied.
export function migrate(storage: DurableObjectStorage, migrations: Migration[], now = Date.now()): number {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const row = sql
    .exec<{ version: number | null }>(`SELECT MAX(version) AS version FROM ${MIGRATIONS_TABLE}`)
    .one();
  let current = row.version ?? 0;

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;

    try {
      storage.transactionSync(() => {
        for (const statement of migration.statements) {
          sql.exec(statement);
        }
        sql.exec(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
          migration.version,
          migration.name,
          now,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DurabaseError(
        ErrorCode.MigrationFailed,
        `migration ${migration.version} failed: ${message}`,
        { migration: migration.version, name: migration.name, applied: current },
      );
    }
    current = migration.version;
  }
  return current;
}
