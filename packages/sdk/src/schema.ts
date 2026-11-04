// The tables, the columns and the foreign keys of the database, read from
// SQLite after the migrations. A call can use only these names, because SQL
// cannot bind a name as a parameter.

import { DurabaseError, ErrorCode } from "./protocol";

export interface Relation {
  kind: "one" | "many";
  table: string; // the other table
  local: string; // the column in this table
  remote: string; // the column in the other table
}

export interface TableInfo {
  name: string;
  columns: string[];
  relations: Map<string, Relation>; // the key is the other table, in lower case
  column(name: string): string;
}

export class Schema {
  readonly tables = new Map<string, TableInfo>();

  table(name: string): TableInfo {
    const t = this.tables.get(name.toLowerCase());
    if (!t) throw new DurabaseError(ErrorCode.InvalidParams, `unknown table: ${name}`, { table: name });
    return t;
  }
}

function internal(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("sqlite_") || n.startsWith("_cf_") || n.startsWith("_durabase_");
}

export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function loadSchema(sql: SqlStorage): Schema {
  const schema = new Schema();
  const names = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray()
    .map((r) => r.name)
    .filter((n) => !internal(n));

  const pk = new Map<string, string[]>();
  for (const name of names) {
    const cols = sql.exec<{ name: string; pk: number }>(`PRAGMA table_info(${quote(name)})`).toArray();
    const lower = new Map(cols.map((c) => [c.name.toLowerCase(), c.name]));
    pk.set(
      name.toLowerCase(),
      cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    );
    schema.tables.set(name.toLowerCase(), {
      name,
      columns: cols.map((c) => c.name),
      relations: new Map(),
      column(col: string) {
        const found = lower.get(col.toLowerCase());
        if (!found) {
          throw new DurabaseError(ErrorCode.InvalidParams, `unknown column: ${col}`, { table: name, column: col });
        }
        return found;
      },
    });
  }

  // One level of embeds follows each foreign key with one column. If two
  // foreign keys join the same tables, the first one counts.
  for (const name of names) {
    const fks = sql
      .exec<{ id: number; seq: number; table: string; from: string; to: string | null }>(
        `PRAGMA foreign_key_list(${quote(name)})`,
      )
      .toArray();
    const byId = new Map<number, typeof fks>();
    for (const f of fks) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
    for (const group of byId.values()) {
      if (group.length !== 1) continue;
      const fk = group[0];
      const child = schema.tables.get(name.toLowerCase());
      const parent = schema.tables.get(fk.table.toLowerCase());
      if (!child || !parent) continue;
      const remote = fk.to ?? pk.get(parent.name.toLowerCase())?.[0];
      if (!remote) continue;

      if (!child.relations.has(parent.name.toLowerCase())) {
        child.relations.set(parent.name.toLowerCase(), { kind: "one", table: parent.name, local: fk.from, remote });
      }
      if (!parent.relations.has(child.name.toLowerCase())) {
        parent.relations.set(child.name.toLowerCase(), { kind: "many", table: child.name, local: remote, remote: fk.from });
      }
    }
  }
  return schema;
}
