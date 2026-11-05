// The file calls, in the Worker. Each call asks the Files DO, moves the bytes
// in R2, then tells the DO. serve() runs them for a caller over HTTP, and a
// client with a binding runs them as the service role.

import { SERVICE, type Auth } from "../caller";
import { ErrorCode, type RpcError } from "../protocol";
import { signFile } from "../auth/tokens";
import { FILES_DO } from "../names";
import type { FileRow, FilesDO, Outcome } from "./files";

export interface FilesBindings {
  // The binding of the Files DO. The default is FILES.
  files?: string;
  // The binding of the R2 bucket. The default is FILES_BUCKET.
  filesBucket?: string;
}

export interface FilesEnv {
  files: DurableObjectStub<FilesDO>;
  bucket: R2Bucket;
}

export function filesEnv(env: unknown, bindings: FilesBindings = {}): FilesEnv {
  const e = env as Record<string, unknown>;
  const ns = e[bindings.files ?? "FILES"] as DurableObjectNamespace<FilesDO> | undefined;
  const bucket = e[bindings.filesBucket ?? "FILES_BUCKET"] as R2Bucket | undefined;
  if (!ns) throw new Error(`the Worker has no binding ${bindings.files ?? "FILES"}`);
  if (!bucket) throw new Error(`the Worker has no binding ${bindings.filesBucket ?? "FILES_BUCKET"}`);
  return { files: ns.get(ns.idFromName(FILES_DO)), bucket };
}

// The R2 key of one version of a file.
export function r2Key(bucket: string, name: string, version: string): string {
  return `${bucket}/${name}/${version}`;
}

// The path of a file in a URL: /files/media/avatars/asha.jpg
export function filePath(bucket: string, name: string): string {
  return `/files/${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export interface Uploaded {
  name: string;
  version: string;
  size: number;
}

// Workers RPC types drop the unknown data of an error. The outcomes come
// back typed here.
type Rpc<T> = Promise<Outcome<T>>;

export async function upload(
  fe: FilesEnv,
  auth: Auth,
  a: {
    bucket: string;
    name: string;
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;
    size: number;
    type: string;
    upsert?: boolean;
    metadata?: Record<string, unknown>;
  },
): Rpc<Uploaded> {
  const prep = (await fe.files.prepareUpload(auth, { bucket: a.bucket, name: a.name, size: a.size, type: a.type, upsert: a.upsert })) as Outcome<{
    version: string;
    public: boolean;
  }>;
  if (!prep.ok) return prep;

  const key = r2Key(a.bucket, a.name, prep.value.version);
  let body = a.body;
  if (body instanceof ReadableStream) {
    const fixed = new FixedLengthStream(a.size);
    void body.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  const object = await fe.bucket.put(key, body, {
    httpMetadata: { contentType: a.type },
    customMetadata: { public: prep.value.public ? "1" : "0" },
  });

  const commit = (await fe.files.commitUpload(auth, {
    bucket: a.bucket,
    name: a.name,
    version: prep.value.version,
    size: object.size,
    type: a.type,
    etag: object.etag,
    metadata: a.metadata ? JSON.stringify(a.metadata) : null,
    upsert: a.upsert,
  })) as Outcome<{ replaced: string | null }>;
  if (!commit.ok) {
    await fe.bucket.delete(key);
    return commit;
  }
  if (commit.value.replaced) await fe.bucket.delete(r2Key(a.bucket, a.name, commit.value.replaced));
  return { ok: true, value: { name: a.name, version: prep.value.version, size: object.size } };
}

export async function list(fe: FilesEnv, auth: Auth, a: { bucket: string; prefix?: string; limit?: number; offset?: number }): Rpc<FileRow[]> {
  return (await fe.files.list(auth, a)) as Outcome<FileRow[]>;
}

export async function remove(fe: FilesEnv, auth: Auth, a: { bucket: string; names: string[] }): Rpc<string[]> {
  const r = (await fe.files.remove(auth, a)) as Outcome<{ name: string; version: string }[]>;
  if (!r.ok) return r;
  await Promise.all(r.value.map((f) => fe.bucket.delete(r2Key(a.bucket, f.name, f.version))));
  return { ok: true, value: r.value.map((f) => f.name) };
}

export async function head(fe: FilesEnv, auth: Auth, a: { bucket: string; name: string }): Rpc<FileRow | null> {
  return (await fe.files.head(auth, a)) as Outcome<FileRow | null>;
}

// A link to one version of a private file, for expiresIn seconds. A new
// upload or a remove stops the link.
export async function signedUrl(
  fe: FilesEnv,
  secret: string,
  a: { origin: string; bucket: string; name: string; expiresIn: number },
): Rpc<string> {
  const r = await head(fe, SERVICE, a);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, error: notFound(a.bucket, a.name) };
  const exp = Math.floor(Date.now() / 1000) + a.expiresIn;
  const sig = await signFile(secret, `${a.bucket}/${a.name}/${r.value.version}`, exp);
  return { ok: true, value: `${a.origin}${filePath(a.bucket, a.name)}?v=${r.value.version}&exp=${exp}&sig=${sig}` };
}

export function notFound(bucket: string, name: string): RpcError {
  return { code: ErrorCode.InvalidParams, message: `no file: files://${bucket}/${name}`, data: { reason: "not-found" } };
}
