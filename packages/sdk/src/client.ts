// The JS client, in the style of supabase-js:
//
//   const db = createClient<Database>("db://shop");       // in the browser: POST /db/shop
//   const db = createClient<Database>("db://shop", env);  // in the Worker: the binding DB
//   const { data, error } = await db.from("orders").select("id", "state").eq("state", "paid");
//   const { data: order } = await db.rpc("create_order", { items, customer });
//
// Each call goes to the Database DO as JSON-RPC 2.0. A client with a binding
// is the service role and skips the policies. A client over HTTP sends the
// session cookie, and the policies apply.

import { DurabaseError, ErrorCode, FUNCTION_PREFIX, type Call, type RowsResult, type RpcBody, type RpcResponse } from "./protocol";
import { Query, type ClientTable } from "./query";
import type { AnyDatabase, DatabaseShape, Result, TableName } from "./types";
import { FilesClient, type FilesClientOptions } from "./files/client";
import { BINDINGS, parseUri, routeOf } from "./uri";

type Transport = (body: RpcBody) => Promise<RpcResponse | RpcResponse[] | undefined>;

// A namespace of any durabase DO: a Database or a Mailbox.
type AnyNamespace = DurableObjectNamespace<any>;

export type Target =
  | string
  | AnyNamespace
  | { url: string; headers?: Record<string, string> }
  | { fetcher: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }; url?: string };

export interface ClientOptions {
  // The name of the Database DO. One name is one database. A URI gives the
  // name itself.
  name?: string;
  // Where Cloudflare creates the DO, on the first call only.
  locationHint?: DurableObjectLocationHint;
  // For a URI with no env: the origin of the site, such as
  // "https://littleplay.co". The default is the origin of the page.
  origin?: string;
  // For a URI with no env: the fetch function. The default is fetch.
  fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  // For a URI with an env: the binding. The default comes from the scheme:
  // DB, MAILBOX or AUTH.
  binding?: string;
  // The realm of db.auth. The default is "main".
  realm?: string;
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

// A transport over HTTP, and the URL of db.auth.
interface Http {
  fetch: FetchFn;
  origin: string;
}

function uriTransport(uri: string, env: object | undefined, options: ClientOptions): { transport: Transport; http?: Http } {
  const address = parseUri(uri);
  if (address.path.length > 0) throw new TypeError(`a client needs a store URI, such as db://shop, not ${uri}`);
  if (env) {
    const ns = (env as Record<string, unknown>)[options.binding ?? BINDINGS[address.scheme]] as AnyNamespace | undefined;
    if (!ns) throw new TypeError(`the env has no binding ${options.binding ?? BINDINGS[address.scheme]} for ${uri}`);
    return { transport: transportFor(ns, { ...options, name: address.authority }) };
  }
  const http: Http = {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    origin: options.origin ?? "",
  };
  return { transport: post(http.fetch, `${http.origin}${routeOf(address)}`), http };
}

function transportFor(target: Exclude<Target, string>, options: ClientOptions): Transport {
  if (Object.hasOwn(target, "fetcher")) {
    const t = target as { fetcher: { fetch: FetchFn }; url?: string };
    return post((input, init) => t.fetcher.fetch(input, init), t.url ?? "https://durabase/db");
  }
  if (Object.hasOwn(target, "url")) {
    const t = target as { url: string; headers?: Record<string, string> };
    return post((input, init) => fetch(input, init), t.url, t.headers);
  }
  const ns = target as unknown as DurableObjectNamespace;
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
  // Sign-in and the current user, over HTTP. A client with a binding is the
  // service role and has no session.
  readonly auth: AuthClient;

  constructor(target: Target, options: ClientOptions = {}, env?: object) {
    if (typeof target === "string") {
      const t = uriTransport(target, env, options);
      this.#transport = t.transport;
      this.auth = new AuthClient(t.http, options.realm ?? "main");
    } else {
      this.#transport = transportFor(target, options);
      this.auth = new AuthClient(undefined, options.realm ?? "main");
    }
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

// createClient("db://shop")                  over HTTP, to /db/shop on this site
// createClient("db://shop", env)             with the binding DB, as the service role
// createClient(env.DB, { name: "shop" })     with a namespace, as the service role
// createClient("files://media")             the client of one bucket
export function createClient(uri: `files://${string}`, env?: object, options?: FilesClientOptions): FilesClient;
export function createClient<DB extends DatabaseShape = AnyDatabase>(uri: string, env?: object, options?: ClientOptions): DurabaseClient<DB>;
export function createClient<DB extends DatabaseShape = AnyDatabase>(target: Exclude<Target, string>, options?: ClientOptions): DurabaseClient<DB>;
export function createClient<DB extends DatabaseShape = AnyDatabase>(
  target: Target,
  a?: object,
  b?: ClientOptions & FilesClientOptions,
): DurabaseClient<DB> | FilesClient {
  if (typeof target === "string" && target.startsWith("files://")) {
    const address = parseUri(target);
    if (address.path.length > 0) throw new TypeError(`a files client needs a bucket URI, such as files://media, not ${target}`);
    return new FilesClient(address.authority, a, b);
  }
  if (typeof target === "string") return new DurabaseClient<DB>(target, b, a);
  return new DurabaseClient<DB>(target, a as ClientOptions | undefined);
}

export interface AuthUser {
  id: string;
  email: string;
  role: "authenticated";
  groups: string[];
}

export type AuthResult<T> = { data: T; error: null } | { data: null; error: { code: number; message: string; data?: unknown } };

// db.auth: the calls of POST /auth/<realm>. The Worker keeps the session in
// HttpOnly cookies, so script on the page never sees a token.
export class AuthClient {
  constructor(
    private readonly http: Http | undefined,
    private readonly realm: string,
  ) {}

  // Sends one email with a link and a 6-digit code. The link goes to next, a
  // path on this site. The default is "/".
  signInWithOtp(args: { email: string; next?: string }): Promise<AuthResult<null>> {
    return this.call("signInWithOtp", args);
  }

  // Signs in with the code from the email.
  async verifyOtp(args: { email: string; code: string }): Promise<AuthResult<AuthUser>> {
    const r = await this.call<{ user: Omit<AuthUser, "role"> }>("verifyOtp", args);
    return r.error ? r : { data: { ...r.data.user, role: "authenticated" }, error: null };
  }

  // The signed-in user, or null.
  getUser(): Promise<AuthResult<AuthUser | null>> {
    return this.call("getUser", {});
  }

  signOut(): Promise<AuthResult<null>> {
    return this.call("signOut", {});
  }

  private async call<T>(method: string, params: object): Promise<AuthResult<T>> {
    if (!this.http) {
      return { data: null, error: { code: ErrorCode.InvalidRequest, message: "db.auth needs a client over HTTP, such as createClient(\"db://shop\")" } };
    }
    const res = await this.http.fetch(`${this.http.origin}/auth/${encodeURIComponent(this.realm)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const r = (await res.json()) as RpcResponse;
    if ("error" in r) return { data: null, error: r.error };
    return { data: r.result as T, error: null };
  }
}
