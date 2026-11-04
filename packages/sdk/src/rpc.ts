// Answers JSON-RPC 2.0 calls in the Database DO. One call, or one batch,
// runs in one SQLite transaction. If a call in a batch fails, SQLite rolls
// back the full batch.

import { isFunction, TxQuery, type DurabaseFunction, type Tx } from "./fn";
import {
  DurabaseError,
  ErrorCode,
  FUNCTION_PREFIX,
  RpcRequest,
  type Call,
  type Id,
  type RowsResult,
  type RpcError,
  type RpcResponse,
} from "./protocol";
import type { Schema } from "./schema";
import { insert, remove, select, toValue, update } from "./sql";

export interface Context {
  storage: DurableObjectStorage;
  schema: Schema;
  functions: Map<string, DurabaseFunction<unknown, unknown>>;
  env: unknown;
  migrationError?: DurabaseError;
}

export function collectFunctions(module: Record<string, unknown> | undefined): Map<string, DurabaseFunction<unknown, unknown>> {
  const out = new Map<string, DurabaseFunction<unknown, unknown>>();
  for (const [name, value] of Object.entries(module ?? {})) {
    if (isFunction(value)) out.set(name, value);
  }
  return out;
}

export function toRpcError(error: unknown): RpcError {
  if (error instanceof DurabaseError) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return { code: ErrorCode.InternalError, message };
}

class BatchFailure {
  constructor(
    readonly index: number,
    readonly error: RpcError,
  ) {}
}

type Envelope = { ok: true; id: Id | undefined; call: Call } | { ok: false; id: Id | undefined; error: RpcError };

function envelope(raw: unknown): Envelope {
  const r = RpcRequest.safeParse(raw);
  const id = typeof raw === "object" && raw !== null && "id" in raw ? ((raw as { id: Id }).id ?? null) : undefined;
  if (!r.success) {
    return { ok: false, id: id ?? null, error: { code: ErrorCode.InvalidRequest, message: "invalid JSON-RPC 2.0 request" } };
  }
  return { ok: true, id: r.data.id, call: { method: r.data.method as Call["method"], params: r.data.params } };
}

function response(id: Id | undefined, outcome: { result: unknown } | { error: RpcError }): RpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, ...outcome } as RpcResponse;
}

// A request with no id is a notification. It gets no response.
function answer(env: Envelope, outcome: { result: unknown } | { error: RpcError }): RpcResponse | undefined {
  return env.id === undefined ? undefined : response(env.id, outcome);
}

export function handle(ctx: Context, body: unknown): RpcResponse | RpcResponse[] | undefined {
  if (Array.isArray(body)) return handleBatch(ctx, body);

  const env = envelope(body);
  if (!env.ok) return response(env.id, { error: env.error });
  if (ctx.migrationError) return answer(env, { error: ctx.migrationError.toJSON() });
  try {
    const result = ctx.storage.transactionSync(() => dispatch(ctx, env.call));
    return answer(env, { result });
  } catch (error) {
    return answer(env, { error: toRpcError(error) });
  }
}

function handleBatch(ctx: Context, body: unknown[]): RpcResponse | RpcResponse[] | undefined {
  if (body.length === 0) {
    return response(null, { error: { code: ErrorCode.InvalidRequest, message: "the batch is empty" } });
  }
  const envs = body.map(envelope);

  const rolledBack = (failed: number) => ({
    error: { code: ErrorCode.BatchRolledBack, message: `rolled back, because call ${failed} of the batch failed`, data: { failed } },
  });

  let outcomes: ({ result: unknown } | { error: RpcError })[];
  const invalid = envs.findIndex((e) => !e.ok);
  if (invalid >= 0) {
    outcomes = envs.map((e, i) => (!e.ok ? { error: e.error } : rolledBack(invalid)));
  } else if (ctx.migrationError) {
    outcomes = envs.map(() => ({ error: ctx.migrationError!.toJSON() }));
  } else {
    try {
      const results = ctx.storage.transactionSync(() =>
        envs.map((e, i) => {
          try {
            return dispatch(ctx, (e as Extract<Envelope, { ok: true }>).call);
          } catch (error) {
            throw new BatchFailure(i, toRpcError(error));
          }
        }),
      );
      outcomes = results.map((result) => ({ result }));
    } catch (error) {
      const failure = error instanceof BatchFailure ? error : new BatchFailure(0, toRpcError(error));
      outcomes = envs.map((_, i) => (i === failure.index ? { error: failure.error } : rolledBack(failure.index)));
    }
  }

  const out = envs.map((e, i) => answer(e, outcomes[i])).filter((r): r is RpcResponse => r !== undefined);
  return out.length ? out : undefined;
}

function rowCall(ctx: Context, call: Call): RowsResult {
  const sql = ctx.storage.sql;
  switch (call.method) {
    case "select":
      return select(sql, ctx.schema, call.params);
    case "insert":
      return insert(sql, ctx.schema, call.params);
    case "update":
      return update(sql, ctx.schema, call.params);
    case "delete":
      return remove(sql, ctx.schema, call.params);
  }
  throw new DurabaseError(ErrorCode.MethodNotFound, `unknown method: ${call.method}`);
}

function dispatch(ctx: Context, call: Call): unknown {
  if (!call.method.startsWith(FUNCTION_PREFIX)) return rowCall(ctx, call);

  const name = call.method.slice(FUNCTION_PREFIX.length);
  const f = ctx.functions.get(name);
  if (!f) throw new DurabaseError(ErrorCode.MethodNotFound, `unknown function: ${name}`);

  let result: unknown;
  try {
    result = f.handler(makeTx(ctx), call.params);
  } catch (error) {
    if (error instanceof DurabaseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DurabaseError(ErrorCode.FunctionError, message, { function: name });
  }
  if (typeof (result as { then?: unknown } | null)?.then === "function") {
    throw new DurabaseError(
      ErrorCode.FunctionError,
      `the function ${name} returned a Promise. A function runs in a transaction and cannot be async.`,
      { function: name },
    );
  }
  return result;
}

function makeTx(ctx: Context): Tx {
  const run = (call: Call) => rowCall(ctx, call);
  return {
    from: (table: string) => new TxQuery(table, run) as never,
    insertOrIgnore: (table: string, row: object) =>
      rowCall(ctx, { method: "insert", params: { table, rows: [row], onConflict: "ignore" } }).count > 0,
    sql: (query: string, ...bindings: unknown[]) => {
      try {
        return ctx.storage.sql.exec(query, ...bindings.map(toValue)).toArray() as never;
      } catch (error) {
        throw new DurabaseError(ErrorCode.SqlError, error instanceof Error ? error.message : String(error));
      }
    },
    now: Date.now(),
    env: ctx.env,
  };
}
