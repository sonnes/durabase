// The routes of files://<bucket>/<name>:
//
//   GET  /files/<bucket>/<name>?v=<version>             a file of a public bucket: no policy
//   GET  /files/<bucket>/<name>?v=…&exp=…&sig=…         a signed link: no DO call
//   GET  /files/<bucket>/<name>                         the current version, with the select rule
//   PUT  /files/<bucket>/<name>                         an upload. The header x-upsert: true overwrites.
//
// Each JSON answer is JSON-RPC 2.0, as on /db and /auth.
//   POST /files/<bucket>                                list and remove, as JSON-RPC 2.0

import type { Session } from "../auth/session";
import { verifyFile } from "../auth/tokens";
import { readJson } from "../body";
import { callerError, ErrorCode, type Id, type RpcError } from "../protocol";
import type { Address } from "../uri";
import { filesEnv, head, isPublic, list, r2Key, remove, upload, type FilesBindings, type FilesEnv } from "./ops";

// A file can hold HTML or SVG from a user. These headers stop it from
// running script on the site.
const SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

export async function serveFiles(
  request: Request,
  env: unknown,
  route: Address,
  bindings: FilesBindings,
  secret: string | undefined,
  session: () => Promise<Session>,
  maxBody: number,
): Promise<Response> {
  const fe = filesEnv(env, bindings);
  const bucket = route.authority;
  const name = route.path.join("/");

  if (name === "") {
    if (request.method !== "POST") return json({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.InvalidRequest, message: "use POST with a JSON-RPC 2.0 body" } }, 405);
    return rpc(request, fe, bucket, session, maxBody);
  }
  if (request.method === "GET" || request.method === "HEAD") return download(request, fe, bucket, name, secret, session);
  if (request.method === "PUT") return put(request, fe, bucket, name, session);
  return new Response(null, { status: 405 });
}

async function download(
  request: Request,
  fe: FilesEnv,
  bucket: string,
  name: string,
  secret: string | undefined,
  session: () => Promise<Session>,
): Promise<Response> {
  const url = new URL(request.url);
  const version = url.searchParams.get("v");
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (version && exp && sig) {
    const valid = secret !== undefined && (await verifyFile(secret, `${bucket}/${name}/${version}`, Number(exp), sig));
    if (!valid) return new Response("the link is not valid or expired", { status: 403 });
    return respond(request, await fe.bucket.get(r2Key(bucket, name, version)), "private, max-age=60");
  }
  const open = await isPublic(fe, bucket);
  if (version && open) {
    const object = await fe.bucket.get(r2Key(bucket, name, version));
    // A public file of one version never changes.
    if (object) return respond(request, object, "public, max-age=31536000, immutable");
  }

  const s = await session();
  const row = await head(fe, s.auth, { bucket, name });
  if (!row.ok) return new Response(callerError(row.error).message, { status: 400 });
  if (!row.value || (version && version !== row.value.version)) return withCookies(new Response("not found", { status: 404 }), s.cookies);
  const object = await fe.bucket.get(r2Key(bucket, name, row.value.version));
  // A shared cache keeps a public answer for each visitor. An answer with the
  // new cookies of a session is for one browser only.
  const shared = open && s.cookies.length === 0;
  return withCookies(respond(request, object, shared ? "public, max-age=60" : "private, no-store"), s.cookies);
}

function respond(request: Request, object: R2ObjectBody | null, cache: string): Response {
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers(SAFE_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", cache);
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function put(request: Request, fe: FilesEnv, bucket: string, name: string, session: () => Promise<Session>): Promise<Response> {
  const size = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isSafeInteger(size) || size < 0) {
    return json({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.InvalidParams, message: "an upload needs a body with a Content-Length" } }, 411);
  }
  const s = await session();
  const r = await upload(fe, s.auth, {
    bucket,
    name,
    body: request.body,
    size,
    type: request.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream",
    upsert: request.headers.get("x-upsert") === "true",
  });
  const res = r.ok ? json({ jsonrpc: "2.0", id: null, result: r.value }) : json({ jsonrpc: "2.0", id: null, error: callerError(r.error) }, status(r.error));
  return withCookies(res, s.cookies);
}

async function rpc(request: Request, fe: FilesEnv, bucket: string, session: () => Promise<Session>, maxBody: number): Promise<Response> {
  const read = await readJson(request, maxBody);
  if (!read.ok) return json({ jsonrpc: "2.0", id: null, error: read.error }, read.status);
  const body = read.value as { id?: Id; method?: string; params?: Record<string, unknown> } | null;
  const id = body?.id ?? null;
  const params = body?.params ?? {};
  const s = await session();
  const answer = (r: { ok: true; value: unknown } | { ok: false; error: RpcError }) =>
    withCookies(json(r.ok ? { jsonrpc: "2.0", id, result: r.value } : { jsonrpc: "2.0", id, error: callerError(r.error) }), s.cookies);

  switch (body?.method) {
    case "list":
      return answer(
        await list(fe, s.auth, {
          bucket,
          prefix: typeof params.prefix === "string" ? params.prefix : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
          offset: typeof params.offset === "number" ? params.offset : undefined,
        }),
      );
    case "remove": {
      const names = Array.isArray(params.names) ? params.names.filter((n): n is string => typeof n === "string") : [];
      return answer(await remove(fe, s.auth, { bucket, names }));
    }
  }
  return answer({ ok: false, error: { code: ErrorCode.MethodNotFound, message: `unknown method: ${body?.method}` } });
}

function status(error: RpcError): number {
  if (error.code === ErrorCode.Forbidden) return 403;
  if ((error.data as { reason?: string } | undefined)?.reason === "not-found") return 404;
  if ((error.data as { reason?: string } | undefined)?.reason === "exists") return 409;
  return 400;
}

function json(body: unknown, statusCode = 200): Response {
  return Response.json(body, { status: statusCode });
}

function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

