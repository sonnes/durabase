// Serves the durabase routes of a Worker. Each URI has one route:
//
//   POST /db/<namespace>          the Database DO, as JSON-RPC 2.0
//   POST /auth/<realm>            sign-in, sign-out and the current user
//   GET  /auth/<realm>/callback   the link of the sign-in email
//   /files/<bucket>/<name>        downloads and uploads (files/serve.ts)
//
//   const answer = await serve(request, env);
//   if (answer) return answer;
//
// A call over HTTP is anon, or authenticated with a session. The policies of
// the DO decide what it can read and write. Code with a binding to the DO
// skips serve(), and is the service role.

import type { AuthDO } from "./auth/auth";
import { authenticate, clearCookies, sameOrigin, sessionCookies, type Session } from "./auth/session";
import type { DatabaseRpc } from "./database";
import type { FilesBindings } from "./files/ops";
import { serveFiles } from "./files/serve";
import { ErrorCode, type Id, type RpcError, type RpcResponse } from "./protocol";
import { DEFAULT_REALM, DEFAULT_SECRET } from "./names";
import { BINDINGS, parseRoute, type Address } from "./uri";

export interface ServeOptions {
  // The names of the bindings. The defaults are DB, MAILBOX, AUTH, FILES
  // and FILES_BUCKET.
  bindings?: { db?: string; auth?: string } & FilesBindings;
  // The realm of the sessions: the name of the Auth DO. The default is "main".
  realm?: string;
  // The binding of the secret. The default is "DURABASE_AUTH_SECRET".
  secret?: string;
  // Where Cloudflare creates a Database DO, on the first call only.
  locationHint?: DurableObjectLocationHint;
}

type Env = Record<string, unknown>;


export async function serve(request: Request, env: unknown, options: ServeOptions = {}): Promise<Response | undefined> {
  const route = parseRoute(new URL(request.url).pathname);
  if (!route) return undefined;
  const e = env as Env;
  const secret = typeof e[options.secret ?? DEFAULT_SECRET] === "string" ? (e[options.secret ?? DEFAULT_SECRET] as string) : undefined;
  const realm = options.realm ?? DEFAULT_REALM;
  const authDO = () => {
    const ns = binding<DurableObjectNamespace<AuthDO>>(e, options.bindings?.auth ?? BINDINGS.auth);
    return ns.get(ns.idFromName(realm));
  };

  switch (route.scheme) {
    case "auth":
      return serveAuth(request, route, realm, secret, authDO);
    case "files":
      return serveFiles(request, e, route, options.bindings ?? {}, secret, () => authenticate(request, secret, authDO));
    case "db": {
      if (route.path.length > 0) return undefined;
      if (request.method !== "POST") return rpcError(null, ErrorCode.InvalidRequest, "use POST with a JSON-RPC 2.0 body", 405);
      const body = await readJson(request);
      if (body === undefined) return rpcError(null, ErrorCode.ParseError, "the body is not JSON");
      const session = await authenticate(request, secret, authDO);
      const name = options.bindings?.db ?? BINDINGS.db;
      const ns = binding<DurableObjectNamespace>(e, name);
      const hint = options.locationHint ? { locationHint: options.locationHint } : undefined;
      const stub = ns.get(ns.idFromName(route.authority), hint) as unknown as DatabaseRpc;
      const result = await stub.rpcAs(body, session.auth);
      return withCookies(result === undefined ? new Response(null, { status: 204 }) : Response.json(result), session.cookies);
    }
  }
}

async function serveAuth(
  request: Request,
  route: Address,
  realm: string,
  secret: string | undefined,
  authDO: () => DurableObjectStub<AuthDO>,
): Promise<Response | undefined> {
  if (route.authority !== realm) return rpcError(null, ErrorCode.InvalidRequest, `unknown realm: ${route.authority}`, 404);
  if (!secret) return rpcError(null, ErrorCode.InternalError, `the Worker needs the secret ${DEFAULT_SECRET}`, 500);
  const auth = authDO();

  if (route.path.length === 1 && route.path[0] === "callback" && request.method === "GET") {
    return callback(request, secret, auth);
  }
  if (route.path.length > 0) return undefined;
  if (request.method !== "POST") return rpcError(null, ErrorCode.InvalidRequest, "use POST with a JSON-RPC 2.0 body", 405);
  if (!sameOrigin(request)) return rpcError(null, ErrorCode.Forbidden, "the request must come from a page of this site", 403);

  const body = (await readJson(request)) as { id?: Id; method?: string; params?: Record<string, unknown> } | undefined;
  if (body === undefined || typeof body !== "object" || Array.isArray(body) || body === null) {
    return rpcError(null, ErrorCode.ParseError, "the body is not one JSON-RPC 2.0 request");
  }
  const id = body.id ?? null;
  const params = body.params ?? {};
  const answer = (result: unknown, cookies: string[] = []) => withCookies(Response.json({ jsonrpc: "2.0", id, result: result ?? null }), cookies);
  const fail = (error: RpcError, cookies: string[] = []) => withCookies(Response.json({ jsonrpc: "2.0", id, error }), cookies);

  switch (body.method) {
    case "signInWithOtp": {
      if (typeof params.email !== "string") return fail({ code: ErrorCode.InvalidParams, message: "signInWithOtp needs an email" });
      // Workers RPC types drop the unknown data of an error, so the type comes back here.
      const next = typeof params.next === "string" ? safePath(params.next) : undefined;
      const r = (await auth.signIn(params.email, new URL(request.url).origin, next)) as { error?: RpcError };
      return r.error ? fail(r.error) : answer(null);
    }
    case "verifyOtp": {
      if (typeof params.email !== "string" || typeof params.code !== "string") {
        return fail({ code: ErrorCode.InvalidParams, message: "verifyOtp needs an email and a code" });
      }
      const r = await auth.verifyCode(params.email, params.code);
      if (!r.ok) return fail({ code: ErrorCode.Forbidden, message: VERIFY_ERRORS[r.reason], data: { reason: r.reason } });
      return answer({ user: r.user }, await sessionCookies(secret, r.user, r.sid, r.counter));
    }
    case "getUser": {
      const session = await authenticate(request, secret, () => auth);
      return answer(userOf(session), session.cookies);
    }
    case "signOut": {
      const session = await authenticate(request, secret, () => auth);
      if (session.sid) await auth.signOut(session.sid);
      return answer(null, clearCookies());
    }
  }
  return fail({ code: ErrorCode.MethodNotFound, message: `unknown method: ${body.method}` });
}

const VERIFY_ERRORS = {
  invalid: "the code or the link is not valid",
  expired: "the code or the link expired. Ask for a new email.",
  tries: "too many wrong codes. Ask for a new email.",
} as const;

// The link in the email: GET /auth/main/callback?token=…&next=/orders
async function callback(request: Request, secret: string, auth: DurableObjectStub<AuthDO>): Promise<Response> {
  const url = new URL(request.url);
  const next = safePath(url.searchParams.get("next"));
  const token = url.searchParams.get("token");
  const r = token ? await auth.verifyLink(token) : ({ ok: false, reason: "invalid" } as const);
  if (!r.ok) {
    const to = new URL(next, url.origin);
    to.searchParams.set("auth_error", r.reason);
    return redirect(to.pathname + to.search, []);
  }
  return redirect(next, await sessionCookies(secret, r.user, r.sid, r.counter));
}

// Only a path on this site, so the link cannot send the user to another site.
function safePath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}

function redirect(location: string, cookies: string[]): Response {
  return withCookies(new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } }), cookies);
}

function userOf(session: Session) {
  if (session.auth.role !== "authenticated") return null;
  const { sub, email, role, groups } = session.auth;
  return { id: sub, email, role, groups };
}

function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

function rpcError(id: Id, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } } satisfies RpcResponse, { status });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function binding<T>(env: Env, name: string): T {
  const value = env[name];
  if (!value) throw new Error(`the Worker has no binding ${name}`);
  return value as T;
}
