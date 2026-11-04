// Runs the row methods on SQLite. Each name comes from the schema. Each value
// is a ? binding.

import type { z } from "zod";
import {
  DeleteParams,
  DurabaseError,
  ErrorCode,
  InsertParams,
  SelectParams,
  UpdateParams,
  type RowsResult,
  type Where,
} from "./protocol";
import { quote, type Schema, type TableInfo } from "./schema";

type Row = Record<string, SqlStorageValue | unknown>;

// SQLite in a Durable Object accepts at most 100 bound values in a query.
const MAX_BINDINGS = 100;

export function toValue(v: unknown): SqlStorageValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || v instanceof ArrayBuffer) return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.getTime();
  return JSON.stringify(v);
}

function exec(sql: SqlStorage, query: string, bindings: SqlStorageValue[]): SqlStorageCursor<Record<string, SqlStorageValue>> {
  try {
    return sql.exec(query, ...bindings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DurabaseError(ErrorCode.SqlError, message);
  }
}

function buildWhere(where: Where | undefined, table: TableInfo): { sql: string; bindings: SqlStorageValue[] } {
  if (!where) return { sql: "", bindings: [] };
  const parts: string[] = [];
  const bindings: SqlStorageValue[] = [];
  for (const [name, ops] of Object.entries(where)) {
    const col = quote(table.column(name));
    for (const [op, value] of Object.entries(ops)) {
      switch (op) {
        case "eq":
          if (value === null) parts.push(`${col} IS NULL`);
          else parts.push(`${col} = ?`), bindings.push(toValue(value));
          break;
        case "neq":
          if (value === null) parts.push(`${col} IS NOT NULL`);
          else parts.push(`${col} != ?`), bindings.push(toValue(value));
          break;
        case "gt":
        case "gte":
        case "lt":
        case "lte": {
          const sign = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
          parts.push(`${col} ${sign} ?`);
          bindings.push(toValue(value));
          break;
        }
        case "like":
          parts.push(`${col} LIKE ?`);
          bindings.push(toValue(value));
          break;
        case "in": {
          if (!Array.isArray(value)) {
            throw new DurabaseError(ErrorCode.InvalidParams, `in needs an array: ${name}`);
          }
          if (value.length === 0) parts.push("0");
          else parts.push(`${col} IN (${value.map(() => "?").join(", ")})`), bindings.push(...value.map(toValue));
          break;
        }
        case "is":
          if (value === null) parts.push(`${col} IS NULL`);
          else if (value === true) parts.push(`${col} IS TRUE`);
          else if (value === false) parts.push(`${col} IS FALSE`);
          else throw new DurabaseError(ErrorCode.InvalidParams, `is needs null, true or false: ${name}`);
          break;
        default:
          throw new DurabaseError(ErrorCode.InvalidParams, `unknown operator: ${op}`);
      }
    }
  }
  return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", bindings };
}

function returningClause(returning: string[] | undefined, table: TableInfo): string {
  if (!returning) return "";
  if (returning.length === 0 || returning.includes("*")) return " RETURNING *";
  return ` RETURNING ${returning.map((c) => quote(table.column(c))).join(", ")}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const KEY = "__durabase_key";

export function select(sql: SqlStorage, schema: Schema, raw: unknown): RowsResult {
  const p = parse(SelectParams, raw);
  const table = schema.table(p.table);

  const plain: string[] = [];
  const embeds: { name: string; columns: string[] }[] = [];
  for (const c of p.columns ?? []) {
    if (typeof c === "string") {
      plain.push(c === "*" ? "*" : quote(table.column(c)));
    } else {
      for (const [name, columns] of Object.entries(c)) embeds.push({ name, columns });
    }
  }

  // An embed needs the key column of this table. It goes into the query
  // with a fixed alias, and out of the result after the embed.
  const relations = embeds.map((e) => {
    const rel = table.relations.get(e.name.toLowerCase());
    if (!rel) {
      throw new DurabaseError(ErrorCode.InvalidParams, `no foreign key joins ${table.name} and ${e.name}`, {
        table: table.name,
        embed: e.name,
      });
    }
    return { ...e, rel };
  });
  const keyCols = [...new Set(relations.map((r) => r.rel.local))];
  const cols = plain.length || relations.length === 0 ? [...plain] : [];
  if (cols.length === 0 && relations.length === 0) cols.push("*");
  keyCols.forEach((k, i) => cols.push(`${quote(k)} AS ${KEY}${i}`));

  const where = buildWhere(p.where, table);
  let query = `SELECT ${cols.join(", ")} FROM ${quote(table.name)}${where.sql}`;
  const bindings = [...where.bindings];
  if (p.order?.length) {
    query += ` ORDER BY ${p.order.map(([c, d]) => `${quote(table.column(c))} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
  }
  if (p.limit !== undefined || p.offset !== undefined) {
    query += " LIMIT ? OFFSET ?";
    bindings.push(p.limit ?? -1, p.offset ?? 0);
  }

  const rows: Row[] = exec(sql, query, bindings).toArray();

  for (const { name, columns, rel } of relations) {
    const other = schema.table(rel.table);
    const keyAlias = `${KEY}${keyCols.indexOf(rel.local)}`;
    const keys = [...new Set(rows.map((r) => r[keyAlias]).filter((k) => k !== null))] as SqlStorageValue[];
    const otherCols = columns.length ? columns.map((c) => (c === "*" ? "*" : quote(other.column(c)))) : ["*"];
    const found = new Map<SqlStorageValue, Row[]>();
    for (const part of chunks(keys, MAX_BINDINGS)) {
      const q = `SELECT ${otherCols.join(", ")}, ${quote(rel.remote)} AS ${KEY} FROM ${quote(other.name)} WHERE ${quote(rel.remote)} IN (${part.map(() => "?").join(", ")})`;
      for (const r of exec(sql, q, part).toArray()) {
        const k = r[KEY];
        delete r[KEY];
        found.set(k, [...(found.get(k) ?? []), r]);
      }
    }
    for (const r of rows) {
      const matches = found.get(r[keyAlias] as SqlStorageValue) ?? [];
      r[name] = rel.kind === "many" ? matches : (matches[0] ?? null);
    }
  }
  keyCols.forEach((_, i) => rows.forEach((r) => delete r[`${KEY}${i}`]));

  return { rows, count: rows.length };
}

export function insert(sql: SqlStorage, schema: Schema, raw: unknown): RowsResult {
  const p = parse(InsertParams, raw);
  const table = schema.table(p.table);
  const names = [...new Set(p.rows.flatMap((r) => Object.keys(r)))].map((c) => table.column(c));
  // RETURNING counts the rows that went in, also with OR IGNORE.
  const returning = p.returning ? returningClause(p.returning, table) : " RETURNING 1 AS __durabase_one";
  const verb = p.onConflict === "ignore" ? "INSERT OR IGNORE" : "INSERT";

  const out: Row[] = [];
  if (names.length === 0) {
    for (let i = 0; i < p.rows.length; i++) {
      out.push(...exec(sql, `${verb} INTO ${quote(table.name)} DEFAULT VALUES${returning}`, []).toArray());
    }
  } else {
    const perStatement = Math.max(1, Math.floor(MAX_BINDINGS / names.length));
    for (const part of chunks(p.rows, perStatement)) {
      const values = part.map(() => `(${names.map(() => "?").join(", ")})`).join(", ");
      const bindings = part.flatMap((r) => names.map((n) => toValue(lookup(r, n))));
      const query = `${verb} INTO ${quote(table.name)} (${names.map(quote).join(", ")}) VALUES ${values}${returning}`;
      out.push(...exec(sql, query, bindings).toArray());
    }
  }
  return p.returning ? { rows: out, count: out.length } : { count: out.length };
}

export function update(sql: SqlStorage, schema: Schema, raw: unknown): RowsResult {
  const p = parse(UpdateParams, raw);
  const table = schema.table(p.table);
  const sets = Object.entries(p.set).map(([c, v]) => ({ col: table.column(c), value: toValue(v) }));
  const where = buildWhere(p.where, table);
  const query = `UPDATE ${quote(table.name)} SET ${sets.map((s) => `${quote(s.col)} = ?`).join(", ")}${where.sql}${p.returning ? returningClause(p.returning, table) : " RETURNING 1 AS __durabase_one"}`;
  const rows = exec(sql, query, [...sets.map((s) => s.value), ...where.bindings]).toArray();
  return p.returning ? { rows, count: rows.length } : { count: rows.length };
}

export function remove(sql: SqlStorage, schema: Schema, raw: unknown): RowsResult {
  const p = parse(DeleteParams, raw);
  const table = schema.table(p.table);
  const where = buildWhere(p.where, table);
  const query = `DELETE FROM ${quote(table.name)}${where.sql}${p.returning ? returningClause(p.returning, table) : " RETURNING 1 AS __durabase_one"}`;
  const rows = exec(sql, query, where.bindings).toArray();
  return p.returning ? { rows, count: rows.length } : { count: rows.length };
}

// A row can name a column in another case than the schema.
function lookup(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const key = Object.keys(row).find((k) => k.toLowerCase() === column.toLowerCase());
  return key === undefined ? null : row[key];
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue.path.map(String).join(".");
    throw new DurabaseError(ErrorCode.InvalidParams, path ? `${path}: ${issue.message}` : issue.message, {
      issues: r.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  return r.data;
}
