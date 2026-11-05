// The client of one bucket:
//
//   const media = createClient("files://media");   // in the browser, over HTTP
//   const printables = createClient("files://printables", { env, origin: "https://littleplay.co" });  // in the Worker
//
//   await media.upload("avatars/asha.jpg", file);
//   const { data } = await media.list("avatars/");
//   await media.remove(["avatars/asha.jpg"]);
//   media.getPublicUrl("products/brick-kit/1.jpg");
//   await printables.createSignedUrl("atlas/india.pdf", { expiresIn: 7 * 24 * 3600 });

import { DEFAULT_SECRET } from "../names";
import { SERVICE } from "../caller";
import type { ClientOptions } from "../client";
import { ErrorCode, type RpcError, type RpcResponse } from "../protocol";
import type { Result } from "../types";
import type { FileRow, Outcome } from "./files";
import { filePath, filesEnv, list, remove, signedUrl, upload, type FilesEnv, type Uploaded } from "./ops";

type FetchFn = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export type UploadBody = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export interface UploadOptions {
  // Overwrite a file that exists. The update rule applies.
  upsert?: boolean;
  // The MIME type. The default is the type of a Blob, or application/octet-stream.
  contentType?: string;
}

function failed(error: RpcError): Result<never> {
  return { data: null, error, count: null };
}

function result<T>(r: Outcome<T>): Result<T> {
  return r.ok ? { data: r.value, error: null, count: null } : failed(r.error);
}

// /files answers JSON-RPC 2.0, as /db and /auth do.
async function answer<T>(res: Response): Promise<Result<T>> {
  const r = (await res.json()) as RpcResponse;
  return "error" in r ? failed(r.error) : { data: r.result as T, error: null, count: null };
}

function sizeOf(body: UploadBody): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

export class FilesClient {
  readonly #http?: { fetch: FetchFn; origin: string };
  readonly #env?: { fe: FilesEnv; secret: string | undefined; origin: string | undefined };

  constructor(
    readonly bucket: string,
    options: ClientOptions = {},
  ) {
    const env = options.env;
    if (env) {
      const secret = (env as Record<string, unknown>)[options.secret ?? DEFAULT_SECRET];
      this.#env = {
        fe: filesEnv(env, options.bindings),
        secret: typeof secret === "string" ? secret : undefined,
        origin: options.origin?.replace(/\/+$/, ""),
      };
    } else {
      this.#http = { fetch: options.fetch ?? ((i, init) => fetch(i, init)), origin: options.origin ?? "" };
    }
  }

  async upload(name: string, body: UploadBody, opts: UploadOptions = {}): Promise<Result<Uploaded>> {
    const type = opts.contentType ?? (body instanceof Blob && body.type ? body.type : "application/octet-stream");
    if (this.#env) {
      const size = sizeOf(body);
      if (size === undefined) return failed({ code: ErrorCode.InvalidParams, message: "a stream needs a Blob or a buffer here" });
      return result(await upload(this.#env.fe, SERVICE, { bucket: this.bucket, name, body, size, type, upsert: opts.upsert }));
    }
    const http = this.#http!;
    const headers: Record<string, string> = { "content-type": type };
    if (opts.upsert) headers["x-upsert"] = "true";
    const res = await http.fetch(`${http.origin}${filePath(this.bucket, name)}`, { method: "PUT", headers, body: body as BodyInit });
    return answer(res);
  }

  async list(prefix = "", opts: { limit?: number; offset?: number } = {}): Promise<Result<FileRow[]>> {
    if (this.#env) return result(await list(this.#env.fe, SERVICE, { bucket: this.bucket, prefix, ...opts }));
    return this.#rpc("list", { prefix, ...opts });
  }

  async remove(names: string[]): Promise<Result<string[]>> {
    if (this.#env) return result(await remove(this.#env.fe, SERVICE, { bucket: this.bucket, names }));
    return this.#rpc("remove", { names });
  }

  // The URL of a file. With the version, the URL of a public file gives the
  // same bytes forever, and a cache can keep it.
  getPublicUrl(name: string, opts: { version?: string } = {}): string {
    const path = filePath(this.bucket, name);
    return opts.version ? `${path}?v=${opts.version}` : path;
  }

  // A full link to the current version of a private file, for an email. Only
  // the service role can make one. A new upload or a remove stops the link.
  async createSignedUrl(name: string, opts: { expiresIn: number }): Promise<Result<string>> {
    const e = this.#env;
    if (!e) return failed({ code: ErrorCode.InvalidRequest, message: "createSignedUrl needs a client with an env, in the Worker" });
    if (!e.origin) {
      return failed({ code: ErrorCode.InvalidRequest, message: "createSignedUrl needs the origin of the site, such as createClient(uri, { env, origin })" });
    }
    if (!e.secret) return failed({ code: ErrorCode.InternalError, message: `the Worker needs the secret ${DEFAULT_SECRET}` });
    return result(await signedUrl(e.fe, e.secret, { origin: e.origin, bucket: this.bucket, name, expiresIn: opts.expiresIn }));
  }

  async #rpc<T>(method: string, params: object): Promise<Result<T>> {
    const http = this.#http!;
    const res = await http.fetch(`${http.origin}/files/${encodeURIComponent(this.bucket)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return answer(res);
  }
}
