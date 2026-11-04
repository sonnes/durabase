// The builder of a row call. db.from("orders").select("id").eq("state", "paid")
// becomes one JSON-RPC call. The JS client awaits the builder. A function in
// the DO calls all(), one(), maybeOne() or run() on it, with no await.

import { DurabaseError, ErrorCode, type Call, type RowsResult } from "./protocol";
import type { ColumnArg, Result, RowOf, Selected, TableName, TablesShape } from "./types";

type Mode = "many" | "single" | "maybe";

export class Query {
  protected method: "select" | "insert" | "update" | "delete" = "select";
  protected params: Record<string, any>;
  protected mode: Mode = "many";

  constructor(table: string) {
    this.params = { table };
  }

  select(...columns: unknown[]): this {
    if (this.method === "select") {
      if (columns.length) this.params.columns = columns;
    } else {
      this.params.returning = columns.length ? columns : ["*"];
    }
    return this;
  }

  insert(rows: object | object[], options?: { onConflict?: "ignore" }): this {
    this.method = "insert";
    this.params.rows = Array.isArray(rows) ? rows : [rows];
    if (options?.onConflict) this.params.onConflict = options.onConflict;
    return this;
  }

  update(set: object): this {
    this.method = "update";
    this.params.set = set;
    return this;
  }

  delete(): this {
    this.method = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.filter(column, "eq", value);
  }
  neq(column: string, value: unknown): this {
    return this.filter(column, "neq", value);
  }
  gt(column: string, value: unknown): this {
    return this.filter(column, "gt", value);
  }
  gte(column: string, value: unknown): this {
    return this.filter(column, "gte", value);
  }
  lt(column: string, value: unknown): this {
    return this.filter(column, "lt", value);
  }
  lte(column: string, value: unknown): this {
    return this.filter(column, "lte", value);
  }
  in(column: string, values: readonly unknown[]): this {
    return this.filter(column, "in", [...values]);
  }
  is(column: string, value: null | boolean): this {
    return this.filter(column, "is", value);
  }
  like(column: string, pattern: string): this {
    return this.filter(column, "like", pattern);
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    (this.params.order ??= []).push([column, options.ascending === false ? "desc" : "asc"]);
    return this;
  }

  limit(count: number): this {
    this.params.limit = count;
    return this;
  }

  // The rows from to to, both included, as in supabase-js.
  range(from: number, to: number): this {
    this.params.offset = from;
    this.params.limit = to - from + 1;
    return this;
  }

  single(): this {
    this.mode = "single";
    return this;
  }

  maybeSingle(): this {
    this.mode = "maybe";
    return this;
  }

  toCall(): Call {
    return { method: this.method, params: this.params };
  }

  // The data of a result, in the mode of this query.
  shape(result: RowsResult): unknown {
    const rows = result.rows;
    if (this.mode === "many") return rows ?? null;
    const n = rows?.length ?? 0;
    if (n === 1) return rows![0];
    if (n === 0 && this.mode === "maybe") return null;
    throw new DurabaseError(ErrorCode.RowCount, `expected ${this.mode === "single" ? "1 row" : "0 or 1 rows"}, got ${n}`, {
      rows: n,
    });
  }

  private filter(column: string, op: string, value: unknown): this {
    const where = (this.params.where ??= {});
    (where[column] ??= {})[op] = value;
    return this;
  }
}

// ---------------------------------------------------------------------------
// The types of the builders.

type Col<R> = keyof R & string;

export interface Filters<R, Self> {
  eq<K extends Col<R>>(column: K, value: R[K]): Self;
  neq<K extends Col<R>>(column: K, value: R[K]): Self;
  gt<K extends Col<R>>(column: K, value: R[K]): Self;
  gte<K extends Col<R>>(column: K, value: R[K]): Self;
  lt<K extends Col<R>>(column: K, value: R[K]): Self;
  lte<K extends Col<R>>(column: K, value: R[K]): Self;
  in<K extends Col<R>>(column: K, values: readonly R[K][]): Self;
  is<K extends Col<R>>(column: K, value: null | boolean): Self;
  like<K extends Col<R>>(column: K, pattern: string): Self;
}

export interface Ordering<R, Self> {
  order<K extends Col<R>>(column: K, options?: { ascending?: boolean }): Self;
  limit(count: number): Self;
  range(from: number, to: number): Self;
}

// The client: await the builder for { data, error, count }.

export interface ClientSelect<R, Out>
  extends Filters<R, ClientSelect<R, Out>>,
    Ordering<R, ClientSelect<R, Out>>,
    PromiseLike<Result<Out[]>> {
  single(): PromiseLike<Result<Out>>;
  maybeSingle(): PromiseLike<Result<Out | null>>;
}

export interface ClientMutation<T extends TablesShape, N extends TableName<T>>
  extends Filters<RowOf<T, N>, ClientMutation<T, N>>,
    PromiseLike<Result<null>> {
  select<const C extends readonly ColumnArg<T, N>[]>(...columns: C): ClientReturning<Selected<T, N, C>>;
}

export interface ClientReturning<Out> extends PromiseLike<Result<Out[]>> {
  single(): PromiseLike<Result<Out>>;
  maybeSingle(): PromiseLike<Result<Out | null>>;
}

export interface ClientTable<T extends TablesShape, N extends TableName<T>> {
  select<const C extends readonly ColumnArg<T, N>[]>(...columns: C): ClientSelect<RowOf<T, N>, Selected<T, N, C>>;
  insert(rows: T[N]["insert"] | readonly T[N]["insert"][], options?: { onConflict?: "ignore" }): ClientMutation<T, N>;
  update(set: T[N]["update"]): ClientMutation<T, N>;
  delete(): ClientMutation<T, N>;
}

// A function in the DO: no await. all(), one() and maybeOne() return rows.
// run() returns the number of rows that a write changed.

export interface TxSelect<R, Out> extends Filters<R, TxSelect<R, Out>>, Ordering<R, TxSelect<R, Out>> {
  all(): Out[];
  one(): Out;
  maybeOne(): Out | null;
}

export interface TxMutation<T extends TablesShape, N extends TableName<T>>
  extends Filters<RowOf<T, N>, TxMutation<T, N>> {
  run(): number;
  select<const C extends readonly ColumnArg<T, N>[]>(...columns: C): TxReturning<Selected<T, N, C>>;
}

export interface TxReturning<Out> {
  all(): Out[];
  one(): Out;
  maybeOne(): Out | null;
}

export interface TxTable<T extends TablesShape, N extends TableName<T>> {
  select<const C extends readonly ColumnArg<T, N>[]>(...columns: C): TxSelect<RowOf<T, N>, Selected<T, N, C>>;
  insert(rows: T[N]["insert"] | readonly T[N]["insert"][], options?: { onConflict?: "ignore" }): TxMutation<T, N>;
  update(set: T[N]["update"]): TxMutation<T, N>;
  delete(): TxMutation<T, N>;
}
