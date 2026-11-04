// A function runs in the Database DO, in one transaction with the call.
// It gets tx, which reads and writes rows with no await. If the function
// throws, SQLite rolls back all its writes.

import { DurabaseError, ErrorCode, type RowsResult } from "./protocol";
import { Query, type TxTable } from "./query";
import type { AnyDatabase, TableName, TablesShape } from "./types";

export interface Tx<T extends TablesShape = AnyDatabase["tables"]> {
  from<N extends TableName<T>>(table: N): TxTable<T, N>;
  // Inserts the row if no row has its key. Returns true if the row went in.
  insertOrIgnore<N extends TableName<T>>(table: N, row: T[N]["insert"]): boolean;
  // Runs any SQL statement. Use ? for each value.
  sql<R extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): R[];
  // The time of the call, in milliseconds.
  readonly now: number;
  // The env of the Database DO.
  readonly env: unknown;
}

const BRAND = "__durabase_function";

export interface DurabaseFunction<A, R> {
  readonly [BRAND]: true;
  readonly handler: (tx: Tx<any>, args: A) => R;
}

// Returns fn() for the tables of a project, so tx has the row types:
//
//   export const fn = createFn<Tables>();
//   export default fn((tx, args: { id: string }) => tx.from("orders").select("state").eq("id", args.id).one());
export function createFn<T extends TablesShape>() {
  return <A = void, R = unknown>(handler: (tx: Tx<T>, args: A) => R): DurabaseFunction<A, R> => ({
    [BRAND]: true,
    handler: handler as (tx: Tx<any>, args: A) => R,
  });
}

// fn() with no generated types.
export const fn = createFn<AnyDatabase["tables"]>();

export function isFunction(v: unknown): v is DurabaseFunction<unknown, unknown> {
  return typeof v === "object" && v !== null && (v as Record<string, unknown>)[BRAND] === true;
}

// The args and the result of each function in a module.
export type FunctionsOf<M> = {
  [K in keyof M as M[K] extends DurabaseFunction<any, any> ? K : never]: M[K] extends DurabaseFunction<infer A, infer R>
    ? { args: A; returns: R }
    : never;
};

// The builder of a function: the same calls as the client, with sync terminals.
export class TxQuery extends Query {
  constructor(
    table: string,
    private readonly run_: (call: ReturnType<Query["toCall"]>) => RowsResult,
  ) {
    super(table);
  }

  all(): unknown[] {
    return (this.exec().rows ?? []) as unknown[];
  }

  one(): unknown {
    this.mode = "single";
    return this.shape(this.exec());
  }

  maybeOne(): unknown {
    this.mode = "maybe";
    return this.shape(this.exec());
  }

  run(): number {
    if (this.method === "select") {
      throw new DurabaseError(ErrorCode.InvalidParams, "run() is for insert, update and delete. Use all() for a select.");
    }
    return this.exec().count;
  }

  private exec(): RowsResult {
    return this.run_(this.toCall());
  }
}
