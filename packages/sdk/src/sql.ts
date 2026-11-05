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
import type { Action, Fragment, Guard } from "./policy";
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

// A column that the caller cannot read cannot pick or sort the rows either.
// Else a filter such as like '%9%' reads a closed column one character at a
// time.
function assertReadable(table: TableInfo, column: string, guard: Guard | undefined): void {
  if (guard && !guard.column(table, column, "select")) throw guard.forbidden("select", table, column);
}

function buildWhere(where: Where | undefined, table: TableInfo, guard?: Guard): { sql: string; bindings: SqlStorageValue[] } {
  if (!where) return { sql: "", bindings: [] };
  const parts: string[] = [];
  const bindings: SqlStorageValue[] = [];
  for (const [name, ops] of Object.entries(where)) {
    assertReadable(table, table.column(name), guard);
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

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const KEY = "__durabase_key";
// The key columns of a written row, for the check after the write.
const ROW_KEY = "__durabase_pk";

// Adds the rule of a policy to a where.
function withRule(where: Fragment, rule: Fragment | null | undefined): Fragment {
  if (!rule) return where;
  const sql = where.sql ? `${where.sql} AND (${rule.sql})` : ` WHERE (${rule.sql})`;
  return { sql, bindings: [...where.bindings, ...rule.bindings] };
}

// The columns of a select. With a guard, "*" means the columns that the
// caller can read, and a column that a policy refuses is an error.
function selectColumns(table: TableInfo, columns: string[], guard: Guard | undefined): string[] {
  const all = columns.length === 0 || columns.includes("*");
  const named = columns.filter((c) => c !== "*").map((c) => table.column(c));
  if (guard) {
    for (const c of named) if (!guard.column(table, c, "select")) throw guard.forbidden("select", table, c);
  }
  if (!all) return named.map(quote);
  if (!guard || table.columns.every((c) => guard.column(table, c, "select"))) return ["*", ...named.map(quote)];
  return [...new Set([...table.columns.filter((c) => guard.column(table, c, "select")), ...named])].map(quote);
}

function returningColumns(returning: string[] | undefined, table: TableInfo, guard: Guard | undefined): string {
  const cols = returning ? selectColumns(table, returning, guard) : [];
  if (guard) table.key.forEach((k, i) => cols.push(`${k === "rowid" ? k : quote(k)} AS ${ROW_KEY}${i}`));
  if (cols.length === 0) return " RETURNING 1 AS __durabase_one";
  return ` RETURNING ${cols.join(", ")}`;
}

// After a write, each new row must pass the rule. Else the DO throws, and
// SQLite rolls back the call. The check finds the rows by their key, so it
// also works on a table WITHOUT ROWID.
function checkRows(sql: SqlStorage, table: TableInfo, rows: Row[], rule: Fragment, guard: Guard, action: Action): void {
  const keys = table.key.map((k) => (k === "rowid" ? k : quote(k)));
  const tuple = `(${keys.map(() => "?").join(", ")})`;
  const room = Math.max(1, Math.floor((MAX_BINDINGS - rule.bindings.length) / keys.length));
  for (const part of chunks(rows, room)) {
    const values = part.flatMap((r) => keys.map((_, i) => r[`${ROW_KEY}${i}`] as SqlStorageValue));
    const q = `SELECT count(*) AS bad FROM ${quote(table.name)} WHERE (${keys.join(", ")}) IN (VALUES ${part.map(() => tuple).join(", ")}) AND NOT coalesce((${rule.sql}), 0)`;
    const [{ bad }] = exec(sql, q, [...values, ...rule.bindings]).toArray() as { bad: number }[];
    if (bad > 0) throw guard.forbidden(action, table);
  }
  dropKeys(table, rows);
}

function dropKeys(table: TableInfo, rows: Row[]): void {
  for (const r of rows) table.key.forEach((_, i) => delete r[`${ROW_KEY}${i}`]);
}

export function select(sql: SqlStorage, schema: Schema, raw: unknown, guard?: Guard): RowsResult {
  const p = parse(SelectParams, raw);
  const table = schema.table(p.table);
  const rule = guard?.rule(table, "select");
  if (guard && !rule) return { rows: [], count: 0 };

  const plain: string[] = [];
  const embeds: { name: string; columns: string[] }[] = [];
  for (const c of p.columns ?? []) {
    if (typeof c === "string") plain.push(c);
    else for (const [name, columns] of Object.entries(c)) embeds.push({ name, columns });
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
  const cols = plain.length || relations.length === 0 ? selectColumns(table, plain, guard) : [];
  keyCols.forEach((k, i) => cols.push(`${quote(k)} AS ${KEY}${i}`));

  const where = withRule(buildWhere(p.where, table, guard), rule);
  let query = `SELECT ${cols.join(", ")} FROM ${quote(table.name)}${where.sql}`;
  const bindings = [...where.bindings];
  if (p.order?.length) {
    for (const [c] of p.order) assertReadable(table, table.column(c), guard);
    query += ` ORDER BY ${p.order.map(([c, d]) => `${quote(table.column(c))} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
  }
  if (p.limit !== undefined || p.offset !== undefined) {
    query += " LIMIT ? OFFSET ?";
    bindings.push(p.limit ?? -1, p.offset ?? 0);
  }

  const rows: Row[] = exec(sql, query, bindings).toArray();

  for (const { name, columns, rel } of relations) {
    const other = schema.table(rel.table);
    const otherRule = guard?.rule(other, "select");
    const keyAlias = `${KEY}${keyCols.indexOf(rel.local)}`;
    const keys = [...new Set(rows.map((r) => r[keyAlias]).filter((k) => k !== null))] as SqlStorageValue[];
    const otherCols = selectColumns(other, columns, guard);
    const found = new Map<SqlStorageValue, Row[]>();
    const open = !guard || otherRule;
    const room = Math.max(1, MAX_BINDINGS - (otherRule?.bindings.length ?? 0));
    for (const part of open ? chunks(keys, room) : []) {
      const inKeys: Fragment = { sql: ` WHERE ${quote(rel.remote)} IN (${part.map(() => "?").join(", ")})`, bindings: part };
      const w = withRule(inKeys, otherRule);
      const q = `SELECT ${otherCols.join(", ")}, ${quote(rel.remote)} AS ${KEY} FROM ${quote(other.name)}${w.sql}`;
      for (const r of exec(sql, q, w.bindings).toArray()) {
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

export function insert(sql: SqlStorage, schema: Schema, raw: unknown, guard?: Guard): RowsResult {
  const p = parse(InsertParams, raw);
  const table = schema.table(p.table);
  const rule = guard?.rule(table, "insert");
  if (guard && !rule) throw guard.forbidden("insert", table);
  const names = [...new Set(p.rows.flatMap((r) => Object.keys(r)))].map((c) => table.column(c));
  if (guard) for (const n of names) if (!guard.column(table, n, "insert")) throw guard.forbidden("insert", table, n);
  // RETURNING counts the rows that went in, also with OR IGNORE.
  const returning = returningColumns(p.returning, table, guard);
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
  if (guard && rule) checkRows(sql, table, out, rule, guard, "insert");
  return p.returning ? { rows: out, count: out.length } : { count: out.length };
}

export function update(sql: SqlStorage, schema: Schema, raw: unknown, guard?: Guard): RowsResult {
  const p = parse(UpdateParams, raw);
  const table = schema.table(p.table);
  const rule = guard?.rule(table, "update");
  if (guard && !rule) throw guard.forbidden("update", table);
  const sets = Object.entries(p.set).map(([c, v]) => ({ col: table.column(c), value: toValue(v) }));
  if (guard) for (const s of sets) if (!guard.column(table, s.col, "update")) throw guard.forbidden("update", table, s.col);
  // The rule picks the rows that the caller can change. After the update,
  // each row must still pass it.
  const where = withRule(buildWhere(p.where, table, guard), rule);
  const query = `UPDATE ${quote(table.name)} SET ${sets.map((s) => `${quote(s.col)} = ?`).join(", ")}${where.sql}${returningColumns(p.returning, table, guard)}`;
  const rows = exec(sql, query, [...sets.map((s) => s.value), ...where.bindings]).toArray();
  if (guard && rule) checkRows(sql, table, rows, rule, guard, "update");
  return p.returning ? { rows, count: rows.length } : { count: rows.length };
}

export function remove(sql: SqlStorage, schema: Schema, raw: unknown, guard?: Guard): RowsResult {
  const p = parse(DeleteParams, raw);
  const table = schema.table(p.table);
  const rule = guard?.rule(table, "delete");
  if (guard && !rule) throw guard.forbidden("delete", table);
  const where = withRule(buildWhere(p.where, table, guard), rule);
  const query = `DELETE FROM ${quote(table.name)}${where.sql}${returningColumns(p.returning, table, guard)}`;
  const rows = exec(sql, query, where.bindings).toArray();
  dropKeys(table, rows);
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
