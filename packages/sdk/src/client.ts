// The JS client, in the style of supabase-js:
//
//   const db = createClient<Database>(env.DB);
//   const { data, error } = await db.from("orders").select("id", "state").eq("state", "paid");
//   const { data: order } = await db.rpc("create_order", { items, customer });
//
// Each call goes to the Database DO as JSON-RPC 2.0.

import { DurabaseError, ErrorCode, FUNCTION_PREFIX, type Call, type RowsResult, type RpcBody, type RpcResponse } from "./protocol";
import { Query, type ClientTable } from "./query";
import type { AnyDatabase, DatabaseShape, Result, TableName } from "./types";

type Transport = (body: RpcBody) => Promise<RpcResponse | RpcResponse[] | undefined>;

export type Target =
  | DurableObjectNamespace
  | { url: string; headers?: Record<string, string> }
  | { fetcher: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }; url?: string };

export interface ClientOptions {
  // The name of the Database DO. One name is one database.
  name?: string;
  // Where Cloudflare creates the DO, on the first call only.
  locationHint?: DurableObjectLocationHint;
}

export const DEFAULT_NAME = "db";

type FetchFn = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

function post(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Transport {
  return async (body) => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return undefined;
    return (await res.json()) as RpcResponse | RpcResponse[];
  };
}

function transportFor(target: Target, options: ClientOptions): Transport {
  if (Object.hasOwn(target, "fetcher")) {
    const t = target as { fetcher: { fetch: FetchFn }; url?: string };
    return post((input, init) => t.fetcher.fetch(input, init), t.url ?? "https://durabase/db");
  }
  if (Object.hasOwn(target, "url")) {
    const t = target as { url: string; headers?: Record<string, string> };
    return post((input, init) => fetch(input, init), t.url, t.headers);
  }
  const ns = target as DurableObjectNamespace;
  return async (body) => {
    const id = ns.idFromName(options.name ?? DEFAULT_NAME);
    const stub = ns.get(id, options.locationHint ? { locationHint: options.locationHint } : undefined);
    return (stub as unknown as { rpc(b: RpcBody): Promise<RpcResponse | RpcResponse[] | undefined> }).rpc(body);
  };
}

let nextId = 1;

function failed(error: { code: number; message: string; data?: unknown }): Result<never> {
  return { data: null, error, count: null };
}

class ClientQuery extends Query implements PromiseLike<Result<unknown>> {
  constructor(
    table: string,
    private readonly client: DurabaseClient<any>,
  ) {
    super(table);
  }

  then<A = Result<unknown>, B = never>(
    onfulfilled?: ((value: Result<unknown>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.client.send(this).then(onfulfilled, onrejected);
  }

  toResult(result: unknown): Result<unknown> {
    const rows = result as RowsResult;
    try {
      return { data: this.shape(rows), error: null, count: rows.count };
    } catch (error) {
      if (error instanceof DurabaseError) return failed(error.toJSON());
      throw error;
    }
  }
}

class RpcQuery implements PromiseLike<Result<unknown>> {
  constructor(
    private readonly name: string,
    private readonly args: unknown,
    private readonly client: DurabaseClient<any>,
  ) {}

  toCall(): Call {
    return { method: `${FUNCTION_PREFIX}${this.name}`, params: this.args };
  }

  toResult(result: unknown): Result<unknown> {
    return { data: result, error: null, count: null };
  }

  then<A = Result<unknown>, B = never>(
    onfulfilled?: ((value: Result<unknown>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.client.send(this).then(onfulfilled, onrejected);
  }
}

type Sendable = ClientQuery | RpcQuery;

export class DurabaseClient<DB extends DatabaseShape = AnyDatabase> {
  readonly #transport: Transport;

  constructor(target: Target, options: ClientOptions = {}) {
    this.#transport = transportFor(target, options);
  }

  from<N extends TableName<DB["tables"]>>(table: N): ClientTable<DB["tables"], N> {
    return new ClientQuery(table, this) as unknown as ClientTable<DB["tables"], N>;
  }

  rpc<F extends keyof DB["functions"] & string>(
    name: F,
    ...args: undefined extends DB["functions"][F]["args"] ? [args?: DB["functions"][F]["args"]] : [args: DB["functions"][F]["args"]]
  ): PromiseLike<Result<DB["functions"][F]["returns"]>> {
    return new RpcQuery(name, args[0], this) as PromiseLike<Result<DB["functions"][F]["returns"]>>;
  }

  // Runs the queries in one transaction. If one fails, none of them changes
  // a row, and each result has an error.
  async batch<const Q extends readonly PromiseLike<Result<unknown>>[]>(queries: Q): Promise<{ -readonly [K in keyof Q]: Awaited<Q[K]> }> {
    const items = queries.map((q) => {
      if (!(q instanceof ClientQuery) && !(q instanceof RpcQuery)) {
        throw new TypeError("batch() takes the queries of this client, before an await");
      }
      return q as Sendable;
    });
    if (items.length === 0) return [] as never;
    const ids = items.map(() => nextId++);
    const body = items.map((q, i) => ({ jsonrpc: "2.0" as const, id: ids[i], ...q.toCall() }));
    const res = await this.#transport(body);
    const list = Array.isArray(res) ? res : res ? [res] : [];
    const byId = new Map(list.map((r) => [r.id, r]));
    return items.map((q, i) => {
      const r = byId.get(ids[i]);
      if (!r) return failed({ code: ErrorCode.InternalError, message: "no response for this call" });
      return "error" in r ? failed(r.error) : q.toResult(r.result);
    }) as never;
  }

  async send(q: Sendable): Promise<Result<unknown>> {
    const id = nextId++;
    const res = await this.#transport({ jsonrpc: "2.0", id, ...q.toCall() });
    const r = Array.isArray(res) ? res[0] : res;
    if (!r) return failed({ code: ErrorCode.InternalError, message: "no response" });
    return "error" in r ? failed(r.error) : q.toResult(r.result);
  }
}

export function createClient<DB extends DatabaseShape = AnyDatabase>(target: Target, options?: ClientOptions): DurabaseClient<DB> {
  return new DurabaseClient<DB>(target, options);
}
