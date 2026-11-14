// The rate limit of the HTTP routes. serve() gives each request to a Workers
// Rate Limiting binding before it calls a Durable Object:
// https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
//
// The binding counts the requests of one key in each Cloudflare location, so
// the limit is not exact. The Auth DO keeps the exact limits of one email
// address in SQLite (auth/functions.ts).

import { ErrorCode } from "./protocol";

// The part of a Rate Limiting binding that durabase uses.
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// The default binding of the limiter.
export const DEFAULT_LIMIT = "DURABASE_LIMIT";

// The period of a Rate Limiting binding is 10 or 60 seconds. The binding does
// not tell when the period ends, so Retry-After has the longer period.
const RETRY_SECONDS = 60;

// Counts one request. Returns the 429 answer if the caller is over the limit,
// and undefined if the request can go on. The key of the limiter is the IP
// address of the caller and key. The default key is the path of the request.
// With no limiter, each request goes on.
//
//   const refused = await limitRequest(request, env.DURABASE_LIMIT, "subscribe");
//   if (refused) return refused;
export async function limitRequest(request: Request, limiter: Limiter | undefined, key?: string): Promise<Response | undefined> {
  if (!limiter) return undefined;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${ip} ${key ?? new URL(request.url).pathname}` });
  if (success) return undefined;
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: ErrorCode.RateLimited, message: `too many requests. Try again in ${RETRY_SECONDS} seconds.` } },
    { status: 429, headers: { "retry-after": String(RETRY_SECONDS) } },
  );
}
