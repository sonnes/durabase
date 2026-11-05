// The policies of a DO. Each policy is a row of _durabase_policies, which the
// migrations write:
//
//   ('db://shop/orders', 'select', '{"customer_email":{"eq":"$auth.email"}}')
//
// A rule is the where JSON of a query, with vars in place of values. An
// object: each condition must match. A list: one object must match. true
// and false match each row and no row. The DO compiles a rule to SQL with
// each var as a bound value, so a var with no value matches nothing.
//
// The service role skips the policies. For anon and authenticated, a table
// with no policy for an action gives no rows on select and refuses writes.

import type { Auth } from "./caller";
import { DurabaseError, ErrorCode } from "./protocol";
import { quote, type Schema, type TableInfo } from "./schema";

export const POLICIES_TABLE = "_durabase_policies";

export type Action = "select" | "insert" | "update" | "delete";
const ACTIONS: readonly string[] = ["select", "insert", "update", "delete"];

export type Rule = boolean | RuleObject | RuleObject[];
export interface RuleObject {
  [key: string]: unknown;
}

export interface Fragment {
  sql: string;
  bindings: SqlStorageValue[];
}

const MATCH_ALL: Fragment = { sql: "1", bindings: [] };
const MATCH_NONE: Fragment = { sql: "0", bindings: [] };

interface Entry {
  authority: string; // a DO name, or "*"
  table: string; // in lower case, or "*"
  column: string | undefined; // in lower case
  action: Action;
  rule: Rule;
}

// scheme://authority/table#column, with "*" for any authority or table.
const PATTERN = /^([a-z]+):\/\/([^/#]+)(?:\/([^/#]+))?(?:#(.+))?$/;

export class Policies {
  readonly #entries = new Map<string, Rule>();

  constructor(
    readonly scheme: string,
    entries: Entry[],
  ) {
    for (const e of entries) this.#entries.set(key(e.authority, e.table, e.column, e.action), e.rule);
  }

  // The rule of a table or a column. An exact name wins over "*".
  find(name: string | undefined, table: string, column: string | undefined, action: Action): Rule | undefined {
    const t = table.toLowerCase();
    const c = column?.toLowerCase();
    const authorities = name ? [name, "*"] : ["*"];
    for (const a of authorities) {
      for (const tb of [t, "*"]) {
        const rule = this.#entries.get(key(a, tb, c, action));
        if (rule !== undefined) return rule;
      }
    }
    return undefined;
  }
}

function key(authority: string, table: string, column: string | undefined, action: Action): string {
  return `${authority}\u0000${table}\u0000${column ?? ""}\u0000${action}`;
}

// Reads the policies that the migrations wrote. A row that is not valid
// stops the DO, as a failed migration does, so a typo never opens a table.
export function loadPolicies(sql: SqlStorage, scheme: string): Policies {
  const rows = sql.exec<{ uri: string; action: string; rule: string }>(`SELECT uri, action, rule FROM ${POLICIES_TABLE}`).toArray();
  const entries: Entry[] = [];
  for (const row of rows) {
    const m = PATTERN.exec(row.uri);
    if (!m || !m[3]) throw new DurabaseError(ErrorCode.MigrationFailed, `the policy ${row.uri} is not a table or a column`);
    if (m[1] !== scheme) continue;
    if (!ACTIONS.includes(row.action)) {
      throw new DurabaseError(ErrorCode.MigrationFailed, `the policy ${row.uri} has an unknown action: ${row.action}`);
    }
    let rule: Rule;
    try {
      rule = JSON.parse(row.rule) as Rule;
    } catch {
      throw new DurabaseError(ErrorCode.MigrationFailed, `the rule of ${row.uri} ${row.action} is not JSON`);
    }
    if (m[4] !== undefined && typeof rule !== "boolean") {
      throw new DurabaseError(ErrorCode.MigrationFailed, `the rule of the column ${row.uri} must be true or false`);
    }
    entries.push({
      authority: decodeURIComponent(m[2]).toLowerCase(),
      table: m[3].toLowerCase(),
      column: m[4]?.toLowerCase(),
      action: row.action as Action,
      rule,
    });
  }
  return new Policies(scheme, entries);
}

// The values of the vars of one call.
export interface Vars {
  auth: Auth;
  ns: string | undefined;
  now: number;
}

function authVar(auth: Auth, field: string): unknown {
  switch (field) {
    case "role":
      return auth.role;
    case "sub":
      return auth.role === "authenticated" ? auth.sub : null;
    case "email":
      return auth.role === "authenticated" ? auth.email : null;
    case "groups":
      return auth.role === "authenticated" ? auth.groups : [];
  }
  throw new DurabaseError(ErrorCode.InternalError, `unknown var: $auth.${field}`);
}

// "$auth.email" is a var. "$$5" is the text "$5".
function isVar(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("$") && !v.startsWith("$$");
}

function literal(v: unknown): unknown {
  return typeof v === "string" && v.startsWith("$$") ? v.slice(1) : v;
}

function readVar(name: string, vars: Vars): unknown {
  if (name.startsWith("$auth.")) return authVar(vars.auth, name.slice(6));
  if (name === "$ns") return vars.ns ?? null;
  if (name === "$now") return vars.now;
  throw new DurabaseError(ErrorCode.InternalError, `unknown var: ${name}`);
}

function bindable(v: unknown): SqlStorageValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

// The table of a query, and its name in the SQL.
interface Scope {
  table: TableInfo;
  ref: string; // the quoted name or alias
}

class Compiler {
  #depth = 0;

  constructor(
    private readonly schema: Schema,
    private readonly vars: Vars,
  ) {}

  rule(rule: Rule, scope: Scope, outer: Scope | undefined): Fragment {
    if (rule === true) return MATCH_ALL;
    if (rule === false) return MATCH_NONE;
    if (Array.isArray(rule)) {
      if (rule.length === 0) return MATCH_NONE;
      return join(rule.map((r) => this.rule(r, scope, outer)), "OR");
    }
    if (typeof rule !== "object" || rule === null) {
      throw new DurabaseError(ErrorCode.InternalError, "a rule must be true, false, an object or a list");
    }
    const parts = Object.entries(rule).map(([k, ops]) => this.condition(k, ops, scope, outer));
    return parts.length ? join(parts, "AND") : MATCH_ALL;
  }

  private condition(key: string, ops: unknown, scope: Scope, outer: Scope | undefined): Fragment {
    if (key.startsWith("$")) return this.varTest(key, ops as Record<string, unknown>);
    if (scope.table.columns.some((c) => c.toLowerCase() === key.toLowerCase())) {
      return this.columnTest(`${scope.ref}.${quote(scope.table.column(key))}`, ops as Record<string, unknown>, outer ?? scope);
    }
    const other = this.schema.tables.get(key.toLowerCase());
    if (!other) throw new DurabaseError(ErrorCode.InternalError, `a rule of ${scope.table.name} names an unknown column or table: ${key}`);
    const alias = `__durabase_p${++this.#depth}`;
    const inner = this.rule(ops as Rule, { table: other, ref: alias }, scope);
    return { sql: `EXISTS (SELECT 1 FROM ${quote(other.name)} AS ${alias} WHERE ${inner.sql})`, bindings: inner.bindings };
  }

  // $row.<column> is a column of the row that the rule tests.
  private value(v: unknown, row: Scope): Fragment {
    if (isVar(v) && v.startsWith("$row.")) return { sql: `${row.ref}.${quote(row.table.column(v.slice(5)))}`, bindings: [] };
    if (isVar(v)) return { sql: "?", bindings: [bindable(readVar(v, this.vars))] };
    return { sql: "?", bindings: [bindable(literal(v))] };
  }

  private columnTest(col: string, ops: Record<string, unknown>, row: Scope): Fragment {
    const parts: Fragment[] = [];
    for (const [op, v] of Object.entries(ops ?? {})) {
      switch (op) {
        case "eq":
        case "neq": {
          if (!isVar(v) && literal(v) === null) {
            parts.push({ sql: `${col} IS ${op === "eq" ? "" : "NOT "}NULL`, bindings: [] });
            break;
          }
          const r = this.value(v, row);
          parts.push({ sql: `${col} ${op === "eq" ? "=" : "!="} ${r.sql}`, bindings: r.bindings });
          break;
        }
        case "gt":
        case "gte":
        case "lt":
        case "lte":
        case "like": {
          const sign = { gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE" }[op];
          const r = this.value(v, row);
          parts.push({ sql: `${col} ${sign} ${r.sql}`, bindings: r.bindings });
          break;
        }
        case "in": {
          const list = isVar(v) ? readVar(v, this.vars) : v;
          if (!Array.isArray(list)) throw new DurabaseError(ErrorCode.InternalError, `in needs a list: ${col}`);
          if (list.length === 0) parts.push(MATCH_NONE);
          else parts.push({ sql: `${col} IN (${list.map(() => "?").join(", ")})`, bindings: list.map((x) => bindable(literal(x))) });
          break;
        }
        case "is":
          if (v === null) parts.push({ sql: `${col} IS NULL`, bindings: [] });
          else if (v === true) parts.push({ sql: `${col} IS TRUE`, bindings: [] });
          else if (v === false) parts.push({ sql: `${col} IS FALSE`, bindings: [] });
          else throw new DurabaseError(ErrorCode.InternalError, `is needs null, true or false: ${col}`);
          break;
        default:
          throw new DurabaseError(ErrorCode.InternalError, `unknown operator in a rule: ${op}`);
      }
    }
    return parts.length ? join(parts, "AND") : MATCH_ALL;
  }

  // { $auth.role: { eq: "authenticated" } }: the DO knows both sides, so the
  // test is 1 or 0 in the SQL.
  private varTest(name: string, ops: Record<string, unknown>): Fragment {
    const left = readVar(name, this.vars);
    for (const [op, raw] of Object.entries(ops ?? {})) {
      const right = isVar(raw) ? readVar(raw, this.vars) : literal(raw);
      if (!compare(op, left, right)) return MATCH_NONE;
    }
    return MATCH_ALL;
  }
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case "eq":
      return left !== null && left === right;
    case "neq":
      return left !== null && right !== null && left !== right;
    case "gt":
      return left !== null && right !== null && (left as number) > (right as number);
    case "gte":
      return left !== null && right !== null && (left as number) >= (right as number);
    case "lt":
      return left !== null && right !== null && (left as number) < (right as number);
    case "lte":
      return left !== null && right !== null && (left as number) <= (right as number);
    case "in":
      return left !== null && Array.isArray(right) && right.includes(left);
    case "has":
      return Array.isArray(left) && left.includes(right);
    case "is":
      return left === right;
  }
  throw new DurabaseError(ErrorCode.InternalError, `unknown operator in a rule: ${op}`);
}

function join(parts: Fragment[], op: "AND" | "OR"): Fragment {
  if (parts.length === 1) return parts[0];
  return { sql: parts.map((p) => `(${p.sql})`).join(` ${op} `), bindings: parts.flatMap((p) => p.bindings) };
}

// Compiles a rule to SQL on the rows of a table.
export function compileRule(rule: Rule, schema: Schema, table: TableInfo, vars: Vars): Fragment {
  return new Compiler(schema, vars).rule(rule, { table, ref: quote(table.name) }, undefined);
}

// The policies of one call, for one caller.
export class Guard {
  constructor(
    private readonly policies: Policies,
    private readonly schema: Schema,
    private readonly vars: Vars,
  ) {}

  // The rule as SQL on the rows of the table. null: the table has no policy.
  rule(table: TableInfo, action: Action): Fragment | null {
    const rule = this.policies.find(this.vars.ns, table.name, undefined, action);
    if (rule === undefined) return null;
    return compileRule(rule, this.schema, table, this.vars);
  }

  // A column is open unless a column policy says false.
  column(table: TableInfo, column: string, action: Action): boolean {
    return this.policies.find(this.vars.ns, table.name, column, action) !== false;
  }

  uri(table: TableInfo, column?: string): string {
    const base = `${this.policies.scheme}://${this.vars.ns ?? "*"}/${table.name}`;
    return column ? `${base}#${column}` : base;
  }

  forbidden(action: Action, table: TableInfo, column?: string): DurabaseError {
    const what = action === "select" ? "" : `${action} `;
    return new DurabaseError(ErrorCode.Forbidden, `no access to ${what}${this.uri(table, column)}`);
  }
}
