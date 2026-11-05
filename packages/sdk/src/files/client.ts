// The client of one bucket:
//
//   const media = createClient("files://media");        // in the browser, over HTTP
//   const printables = createClient("files://printables", env);  // in the Worker: the service role
//
//   await media.upload("avatars/asha.jpg", file);
//   const { data } = await media.list("avatars/");
//   await media.remove(["avatars/asha.jpg"]);
//   media.getPublicUrl("products/brick-kit/1.jpg");
//   await printables.createSignedUrl("atlas/india.pdf", { expiresIn: 7 * 24 * 3600 });

import { DEFAULT_SECRET } from "../names";
import { SERVICE } from "../caller";
import { ErrorCode, type RpcError, type RpcResponse } from "../protocol";
import type { FileRow, Outcome } from "./files";
import { filePath, filesEnv, list, remove, signedUrl, upload, type FilesBindings, type FilesEnv, type Uploaded } from "./ops";

export type FileResult<T> = { data: T; error: null } | { data: null; error: RpcError };

type FetchFn = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export interface FilesClientOptions {
  // Over HTTP: the origin of the site, and the fetch function.
  origin?: string;
  fetch?: FetchFn;
  // With an env: the bindings, and the binding of the secret.
  bindings?: FilesBindings;
  secret?: string;
}

export type UploadBody = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export interface UploadOptions {
  // Overwrite a file that exists. The update rule applies.
  upsert?: boolean;
  // The MIME type. The default is the type of a Blob, or application/octet-stream.
  contentType?: string;
}

function result<T>(r: Outcome<T>): FileResult<T> {
  return r.ok ? { data: r.value, error: null } : { data: null, error: r.error };
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
  readonly #env?: { fe: FilesEnv; secret: string | undefined };

  constructor(
    readonly bucket: string,
    env: object | undefined,
    options: FilesClientOptions = {},
  ) {
    if (env) {
      const secret = (env as Record<string, unknown>)[options.secret ?? DEFAULT_SECRET];
      this.#env = { fe: filesEnv(env, options.bindings), secret: typeof secret === "string" ? secret : undefined };
    } else {
      this.#http = { fetch: options.fetch ?? ((i, init) => fetch(i, init)), origin: options.origin ?? "" };
    }
  }

  async upload(name: string, body: UploadBody, opts: UploadOptions = {}): Promise<FileResult<Uploaded>> {
    const type = opts.contentType ?? (body instanceof Blob && body.type ? body.type : "application/octet-stream");
    if (this.#env) {
      const size = sizeOf(body);
      if (size === undefined) return { data: null, error: { code: ErrorCode.InvalidParams, message: "a stream needs a Blob or a buffer here" } };
      return result(await upload(this.#env.fe, SERVICE, { bucket: this.bucket, name, body, size, type, upsert: opts.upsert }));
    }
    const http = this.#http!;
    const headers: Record<string, string> = { "content-type": type };
    if (opts.upsert) headers["x-upsert"] = "true";
    const res = await http.fetch(`${http.origin}${filePath(this.bucket, name)}`, { method: "PUT", headers, body: body as BodyInit });
    return (await res.json()) as FileResult<Uploaded>;
  }

  async list(prefix = "", opts: { limit?: number; offset?: number } = {}): Promise<FileResult<FileRow[]>> {
    if (this.#env) return result(await list(this.#env.fe, SERVICE, { bucket: this.bucket, prefix, ...opts }));
    return this.#rpc("list", { prefix, ...opts });
  }

  async remove(names: string[]): Promise<FileResult<string[]>> {
    if (this.#env) return result(await remove(this.#env.fe, SERVICE, { bucket: this.bucket, names }));
    return this.#rpc("remove", { names });
  }

  // The URL of a file. With the version, the URL of a public file gives the
  // same bytes forever, and a cache can keep it.
  getPublicUrl(name: string, opts: { version?: string } = {}): string {
    const path = filePath(this.bucket, name);
    return opts.version ? `${path}?v=${opts.version}` : path;
  }

  // A link to the current version of a private file. Only the service role
  // can make one. A new upload or a remove stops the link.
  async createSignedUrl(name: string, opts: { expiresIn: number }): Promise<FileResult<string>> {
    if (!this.#env) {
      return { data: null, error: { code: ErrorCode.InvalidRequest, message: "createSignedUrl needs a client with an env, in the Worker" } };
    }
    if (!this.#env.secret) return { data: null, error: { code: ErrorCode.InternalError, message: `the Worker needs the secret ${DEFAULT_SECRET}` } };
    return result(await signedUrl(this.#env.fe, this.#env.secret, { bucket: this.bucket, name, expiresIn: opts.expiresIn }));
  }

  async #rpc<T>(method: string, params: object): Promise<FileResult<T>> {
    const http = this.#http!;
    const res = await http.fetch(`${http.origin}/files/${encodeURIComponent(this.bucket)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const r = (await res.json()) as RpcResponse;
    return "error" in r ? { data: null, error: r.error } : { data: r.result as T, error: null };
  }
}
