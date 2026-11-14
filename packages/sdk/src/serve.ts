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
import type { Verified } from "./auth/functions";
import { authenticate, clearCookies, clearSignInCookie, readNonce, sameOrigin, sessionCookies, signInCookie, type Session } from "./auth/session";
import { MIN_SECRET, randomToken } from "./auth/tokens";
import { MAX_BODY, readJson } from "./body";
import type { DatabaseRpc } from "./database";
import type { FilesBindings } from "./files/ops";
import { serveFiles } from "./files/serve";
import { DEFAULT_LIMIT, limitRequest, type Limiter } from "./limit";
import { ErrorCode, type Id, type RpcError, type RpcResponse } from "./protocol";
import { DEFAULT_REALM, DEFAULT_SECRET } from "./names";
import { BINDINGS, parseRoute, type Address } from "./uri";

// The largest batch of /db, in calls.
const MAX_BATCH = 100;

export interface ServeOptions {
  // The names of the bindings. The defaults are DB, MAILBOX, AUTH, FILES,
  // FILES_BUCKET and DURABASE_LIMIT.
  bindings?: {
    db?: string;
    auth?: string;
    // The Rate Limiting binding. With no such binding, serve() limits nothing.
    limit?: string;
  } & FilesBindings;
  // The names of the Database DOs that /db serves: a list, or a function for
  // names that the app makes, such as one name for each tenant. Each other
  // name gets a 404. The default is no name, because a call to a new name
  // creates a Durable Object.
  databases?: readonly string[] | ((name: string) => boolean);
  // The largest JSON-RPC body, in bytes. The default is 1,000,000. An upload
  // has the limit of its bucket.
  maxBody?: number;
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
  // serve() has no route for a Mailbox.
  if (!route || route.scheme === "mail") return undefined;
  const e = env as Env;
  const secretName = options.secret ?? DEFAULT_SECRET;
  const secret = typeof e[secretName] === "string" ? (e[secretName] as string) : undefined;
  if (secret !== undefined && secret.length < MIN_SECRET) {
    throw new Error(`the secret ${secretName} must have ${MIN_SECRET} characters or more`);
  }

  // The limit comes before each call to a Durable Object.
  const limiter = e[options.bindings?.limit ?? DEFAULT_LIMIT] as Limiter | undefined;
  const refused = await limitRequest(request, limiter, `${route.scheme}/${route.authority}`);
  if (refused) return refused;

  const maxBody = options.maxBody ?? MAX_BODY;
  const realm = options.realm ?? DEFAULT_REALM;
  const authDO = () => {
    const ns = binding<DurableObjectNamespace<AuthDO>>(e, options.bindings?.auth ?? BINDINGS.auth);
    return ns.get(ns.idFromName(realm));
  };

  switch (route.scheme) {
    case "auth":
      return serveAuth(request, route, realm, secret, authDO, maxBody);
    case "files":
      return serveFiles(request, e, route, options.bindings ?? {}, secret, () => authenticate(request, secret, authDO), maxBody);
    case "db": {
      if (route.path.length > 0) return undefined;
      const known = typeof options.databases === "function" ? options.databases(route.authority) : (options.databases ?? []).includes(route.authority);
      if (!known) return rpcError(null, ErrorCode.InvalidRequest, `unknown database: ${route.authority}`, 404);
      if (request.method !== "POST") return rpcError(null, ErrorCode.InvalidRequest, "use POST with a JSON-RPC 2.0 body", 405);
      const body = await readJson(request, maxBody);
      if (!body.ok) return rpcError(null, body.error.code, body.error.message, body.status);
      if (Array.isArray(body.value) && body.value.length > MAX_BATCH) {
        return rpcError(null, ErrorCode.InvalidRequest, `a batch has ${MAX_BATCH} calls at most`);
      }
      const session = await authenticate(request, secret, authDO);
      const name = options.bindings?.db ?? BINDINGS.db;
      const ns = binding<DurableObjectNamespace>(e, name);
      const hint = options.locationHint ? { locationHint: options.locationHint } : undefined;
      const stub = ns.get(ns.idFromName(route.authority), hint) as unknown as DatabaseRpc;
      const result = await stub.rpcAs(body.value, session.auth);
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
  maxBody: number,
): Promise<Response | undefined> {
  if (route.authority !== realm) return rpcError(null, ErrorCode.InvalidRequest, `unknown realm: ${route.authority}`, 404);
  if (!secret) return rpcError(null, ErrorCode.InternalError, `the Worker needs the secret ${DEFAULT_SECRET}`, 500);

  if (route.path.length === 1 && route.path[0] === "callback" && request.method === "GET") {
    return callback(request, secret, authDO);
  }
  if (route.path.length > 0) return undefined;
  if (request.method !== "POST") return rpcError(null, ErrorCode.InvalidRequest, "use POST with a JSON-RPC 2.0 body", 405);
  if (!sameOrigin(request)) return rpcError(null, ErrorCode.Forbidden, "the request must come from a page of this site", 403);

  const read = await readJson(request, maxBody);
  if (!read.ok && read.status === 413) return rpcError(null, read.error.code, read.error.message, read.status);
  const body = (read.ok ? read.value : undefined) as { id?: Id; method?: string; params?: Record<string, unknown> } | undefined;
  if (body === undefined || typeof body !== "object" || Array.isArray(body) || body === null) {
    return rpcError(null, ErrorCode.ParseError, "the body is not one JSON-RPC 2.0 request");
  }
  const auth = authDO();
  const id = body.id ?? null;
  const params = body.params ?? {};
  const answer = (result: unknown, cookies: string[] = []) => withCookies(Response.json({ jsonrpc: "2.0", id, result: result ?? null }), cookies);
  const fail = (error: RpcError, cookies: string[] = []) => withCookies(Response.json({ jsonrpc: "2.0", id, error }), cookies);

  switch (body.method) {
    case "signInWithOtp": {
      if (typeof params.email !== "string") return fail({ code: ErrorCode.InvalidParams, message: "signInWithOtp needs an email" });
      const origin = new URL(request.url).origin;
      const next = typeof params.next === "string" ? safePath(params.next, origin) : undefined;
      // A browser that asks for a second email keeps its nonce, so the link
      // of each email works.
      const nonce = readNonce(request) ?? randomToken();
      // Workers RPC types drop the unknown data of an error, so the type comes back here.
      const r = (await auth.signIn(params.email, origin, next, nonce)) as { error?: RpcError };
      return r.error ? fail(signInError(r.error)) : answer(null, [signInCookie(nonce)]);
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
  locked: "too many wrong codes. Use the link of the email, or try again in 24 hours.",
} as const;

// The Auth DO refuses an address or a rate with these codes. Each other
// error is internal: its message goes to the log of the Worker.
function signInError(error: RpcError): RpcError {
  if (error.code === ErrorCode.Forbidden || error.code === ErrorCode.InvalidParams) return error;
  console.error(`durabase: the sign-in failed with error ${error.code}:`, error.message);
  return { code: ErrorCode.InternalError, message: "the sign-in email was not sent" };
}

// The link in the email: GET /auth/main/callback?token=…&next=/orders
//
// The link signs in only the browser that asked for it, which has the nonce
// cookie of signInWithOtp. In each other browser, the answer has the error
// "browser" and no session. The Auth DO gets no call, so the link stays open.
async function callback(request: Request, secret: string, authDO: () => DurableObjectStub<AuthDO>): Promise<Response> {
  const url = new URL(request.url);
  const next = safePath(url.searchParams.get("next"), url.origin);
  const token = url.searchParams.get("token");
  const nonce = readNonce(request);
  let r: Verified | { ok: false; reason: "browser" };
  if (!nonce) r = { ok: false, reason: "browser" };
  else if (!token) r = { ok: false, reason: "invalid" };
  else r = await authDO().verifyLink(token, nonce);
  if (!r.ok) {
    const to = new URL(next, url.origin);
    to.searchParams.set("auth_error", r.reason);
    return redirect(to.pathname + to.search + to.hash, []);
  }
  return redirect(next, [...(await sessionCookies(secret, r.user, r.sid, r.counter)), clearSignInCookie()]);
}

// The path, the query and the hash of next, if next is a URL of this site.
// Else "/", so the link cannot send the user to another site. A browser
// removes a tab and a line break from a URL, and reads a backslash as "/". So
// "/\t/evil.example" is "//evil.example" for a browser, and a text check of
// next is not sufficient.
function safePath(next: string | null, origin: string): string {
  if (!next || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  return url.pathname + url.search + url.hash;
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

function binding<T>(env: Env, name: string): T {
  const value = env[name];
  if (!value) throw new Error(`the Worker has no binding ${name}`);
  return value as T;
}
