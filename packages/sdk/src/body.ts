// Reads the JSON body of a request, up to a size limit.

import { ErrorCode, type RpcError } from "./protocol";

// The default size limit of a JSON-RPC body, in bytes.
export const MAX_BODY = 1_000_000;

export type Body = { ok: true; value: unknown } | { ok: false; error: RpcError; status: number };

// A client can send a wrong Content-Length header, or none. So the limit
// applies to the header and to the bytes that arrive.
export async function readJson(request: Request, max: number): Promise<Body> {
  const tooLarge: Body = { ok: false, error: { code: ErrorCode.InvalidRequest, message: `the body is larger than ${max} bytes` }, status: 413 };
  if (Number(request.headers.get("content-length") ?? 0) > max) return tooLarge;

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: { code: ErrorCode.ParseError, message: "the body is not JSON" }, status: 200 };
  }
}
