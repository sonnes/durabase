// The Files Durable Object. One DO keeps a row for each file of all buckets,
// and R2 keeps the bytes. A project exports it with one line:
//
//   export const Files = files({ buckets, policies: filesPolicies });
//
// Each file call is a row operation on objects, and the policies of
// files:// decide it, as the policies of storage.objects do in Supabase:
//
//   upload          insert, or update if the file exists and upsert is true
//   download, list  select. A download from a public bucket skips it.
//   remove          delete
//
// The DO never touches R2. The Worker (ops.ts) asks the DO, moves the bytes,
// then tells the DO.

import { DurableObject } from "cloudflare:workers";
import type { Auth } from "../caller";
import { migrate } from "../migrate";
import { compileRule, POLICIES_TABLE, type Fragment, type Rule, type Vars } from "../policy";
import { DurabaseError, ErrorCode, type RpcError } from "../protocol";
import { loadSchema, type Schema, type TableInfo } from "../schema";
import { migrations } from "./files.gen";

export interface Bucket {
  // A download needs no policy and no session.
  public?: boolean;
  // The largest file, in bytes.
  maxSize?: number;
  // The MIME types, such as "image/*" or "application/pdf".
  types?: string[];
}

// A policy of files://, from policies.yaml. `durabase gen` writes the list.
export interface FilePolicy {
  uri: string;
  action: "select" | "insert" | "update" | "delete";
  rule: string;
}

export interface FilesOptions {
  buckets: Record<string, Bucket>;
  policies?: FilePolicy[];
}

export interface FileRow {
  bucket: string;
  name: string;
  owner_id: string | null;
  version: string;
  size: number;
  type: string;
  etag: string;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: RpcError };

const LIST_LIMIT = 1000;

type Action = FilePolicy["action"];

// files://media, files://media/*, files://media/avatars/* or files://media/logo.png
interface Pattern {
  bucket: string;
  prefix: string;
  exact: boolean;
  action: Action;
  rule: Rule;
}

function parsePattern(p: FilePolicy): Pattern {
  const m = /^files:\/\/([a-z0-9][a-z0-9_.-]*)(?:\/(.*))?$/.exec(p.uri);
  if (!m) throw new DurabaseError(ErrorCode.MigrationFailed, `the policy ${p.uri} is not a files:// URI`);
  const path = m[2] ?? "*";
  const exact = !path.endsWith("*");
  return { bucket: m[1], prefix: exact ? path : path.slice(0, -1), exact, action: p.action, rule: JSON.parse(p.rule) as Rule };
}

function typeMatches(types: string[] | undefined, type: string): boolean {
  if (!types || types.length === 0) return true;
  return types.some((t) => (t.endsWith("/*") ? type.startsWith(t.slice(0, -1)) : t === type));
}

class Refused extends Error {
  constructor(readonly error: RpcError) {
    super(error.message);
  }
}

class Rollback extends Error {}

export function files(options: FilesOptions) {
  const patterns = (options.policies ?? []).map(parsePattern);

  return class Files extends DurableObject {
    #schema!: Schema;
    #migrationError?: DurabaseError;

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env as never);
      ctx.blockConcurrencyWhile(async () => {
        try {
          migrate(ctx.storage, migrations);
          // The policies come with the deploy. The rows keep a record of them.
          ctx.storage.transactionSync(() => {
            ctx.storage.sql.exec(`DELETE FROM ${POLICIES_TABLE} WHERE uri LIKE 'files://%'`);
            for (const p of options.policies ?? []) {
              ctx.storage.sql.exec(`INSERT INTO ${POLICIES_TABLE} (uri, action, rule) VALUES (?, ?, ?)`, p.uri, p.action, p.rule);
            }
          });
        } catch (error) {
          this.#migrationError =
            error instanceof DurabaseError
              ? error
              : new DurabaseError(ErrorCode.MigrationFailed, error instanceof Error ? error.message : String(error));
        }
        this.#schema = loadSchema(ctx.storage.sql);
      });
    }

    // Tests an upload before the bytes go to R2, and writes nothing. Returns
    // the version of the new file.
    async prepareUpload(
      auth: Auth,
      a: { bucket: string; name: string; size: number; type: string; upsert?: boolean },
    ): Promise<Outcome<{ version: string; public: boolean }>> {
      return this.#run(() => {
        this.#limits(a.bucket, a.name, a.size, a.type);
        const version = crypto.randomUUID();
        try {
          this.ctx.storage.transactionSync(() => {
            this.#write(auth, { ...a, version, etag: "", metadata: null });
            throw new Rollback();
          });
        } catch (error) {
          if (!(error instanceof Rollback)) throw error;
        }
        return { version, public: this.#bucket(a.bucket).public === true };
      });
    }

    // Writes the row after the bytes are in R2. Returns the version that the
    // upload replaced, so the Worker can remove its bytes.
    async commitUpload(
      auth: Auth,
      a: { bucket: string; name: string; version: string; size: number; type: string; etag: string; metadata?: string | null; upsert?: boolean },
    ): Promise<Outcome<{ replaced: string | null }>> {
      return this.#run(() => {
        this.#limits(a.bucket, a.name, a.size, a.type);
        return this.ctx.storage.transactionSync(() => ({ replaced: this.#write(auth, { ...a, metadata: a.metadata ?? null }) }));
      });
    }

    // The row of one file, if the caller can read it.
    async head(auth: Auth, a: { bucket: string; name: string }): Promise<Outcome<FileRow | null>> {
      return this.#run(() => {
        this.#bucket(a.bucket);
        const row = this.#row(a.bucket, a.name);
        if (!row) return null;
        const isPublic = this.#bucket(a.bucket).public === true;
        if (!isPublic && !this.#allowed(auth, "select", a.bucket, a.name)) return null;
        return row;
      });
    }

    // The files with a name that starts with prefix, in name order.
    async list(auth: Auth, a: { bucket: string; prefix?: string; limit?: number; offset?: number }): Promise<Outcome<FileRow[]>> {
      return this.#run(() => {
        this.#bucket(a.bucket);
        const prefix = a.prefix ?? "";
        const where: Fragment[] = [
          { sql: "bucket = ?", bindings: [a.bucket] },
          { sql: "substr(name, 1, ?) = ?", bindings: [prefix.length, prefix] },
        ];
        const rule = this.#ruleSql(auth, "select", a.bucket);
        if (rule) where.push(rule);
        const sql = `SELECT * FROM objects WHERE ${where.map((w) => `(${w.sql})`).join(" AND ")} ORDER BY name LIMIT ? OFFSET ?`;
        const bindings = [...where.flatMap((w) => w.bindings), Math.min(a.limit ?? 100, LIST_LIMIT), a.offset ?? 0];
        return this.ctx.storage.sql.exec<FileRow & Record<string, SqlStorageValue>>(sql, ...bindings).toArray();
      });
    }

    // Removes the rows. Returns the versions, so the Worker can remove the
    // bytes. A name that the caller cannot remove is an error, and the DO
    // removes nothing.
    async remove(auth: Auth, a: { bucket: string; names: string[] }): Promise<Outcome<{ name: string; version: string }[]>> {
      return this.#run(() => {
        this.#bucket(a.bucket);
        return this.ctx.storage.transactionSync(() => {
          const out: { name: string; version: string }[] = [];
          for (const name of a.names) {
            const row = this.#row(a.bucket, name);
            if (!row) continue;
            if (!this.#allowed(auth, "delete", a.bucket, name)) throw this.#forbidden("delete", a.bucket, name);
            this.ctx.storage.sql.exec("DELETE FROM objects WHERE bucket = ? AND name = ?", a.bucket, name);
            out.push({ name, version: row.version });
          }
          return out;
        });
      });
    }

    async #run<T>(f: () => T): Promise<Outcome<T>> {
      if (this.#migrationError) return { ok: false, error: this.#migrationError.toJSON() };
      try {
        return { ok: true, value: f() };
      } catch (error) {
        if (error instanceof Refused) return { ok: false, error: error.error };
        if (error instanceof DurabaseError) return { ok: false, error: error.toJSON() };
        throw error;
      }
    }

    #bucket(name: string): Bucket {
      const b = Object.hasOwn(options.buckets, name) ? options.buckets[name] : undefined;
      if (!b) throw new Refused({ code: ErrorCode.InvalidParams, message: `unknown bucket: ${name}` });
      return b;
    }

    #limits(bucket: string, name: string, size: number, type: string): void {
      const b = this.#bucket(bucket);
      if (!name || name.startsWith("/") || name.endsWith("/") || name.split("/").some((p) => p === "" || p === "." || p === "..")) {
        throw new Refused({ code: ErrorCode.InvalidParams, message: `not a valid file name: ${name}` });
      }
      if (b.maxSize !== undefined && size > b.maxSize) {
        throw new Refused({ code: ErrorCode.InvalidParams, message: `the file is larger than ${b.maxSize} bytes`, data: { reason: "size" } });
      }
      if (!typeMatches(b.types, type)) {
        throw new Refused({ code: ErrorCode.InvalidParams, message: `the bucket ${bucket} does not accept ${type}`, data: { reason: "type" } });
      }
    }

    #row(bucket: string, name: string): FileRow | undefined {
      return this.ctx.storage.sql
        .exec<FileRow & Record<string, SqlStorageValue>>("SELECT * FROM objects WHERE bucket = ? AND name = ?", bucket, name)
        .toArray()[0];
    }

    // Writes the row of an upload, and tests the rule. Returns the version
    // that it replaced. Runs in a transaction.
    #write(
      auth: Auth,
      a: { bucket: string; name: string; version: string; size: number; type: string; etag: string; metadata: string | null; upsert?: boolean },
    ): string | null {
      const now = Date.now();
      const old = this.#row(a.bucket, a.name);
      const sql = this.ctx.storage.sql;
      if (old && !a.upsert) {
        throw new Refused({ code: ErrorCode.InvalidParams, message: `the file exists: ${a.name}`, data: { reason: "exists" } });
      }
      const owner = auth.role === "authenticated" ? auth.sub : null;
      if (old) {
        if (!this.#allowed(auth, "update", a.bucket, a.name)) throw this.#forbidden("update", a.bucket, a.name);
        sql.exec(
          "UPDATE objects SET version = ?, size = ?, type = ?, etag = ?, metadata = ?, updated_at = ? WHERE bucket = ? AND name = ?",
          a.version, a.size, a.type, a.etag, a.metadata, now, a.bucket, a.name,
        );
        if (!this.#allowed(auth, "update", a.bucket, a.name)) throw this.#forbidden("update", a.bucket, a.name);
        return old.version;
      }
      sql.exec(
        "INSERT INTO objects (bucket, name, owner_id, version, size, type, etag, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        a.bucket, a.name, owner, a.version, a.size, a.type, a.etag, a.metadata, now, now,
      );
      if (!this.#allowed(auth, "insert", a.bucket, a.name)) throw this.#forbidden("insert", a.bucket, a.name);
      return null;
    }

    #table(): TableInfo {
      return this.#schema.table("objects");
    }

    // The rule of each pattern of the bucket, as SQL on objects. A file
    // follows the pattern with the longest prefix that matches its name. An
    // exact name wins over a prefix. null: the service role.
    #ruleSql(auth: Auth, action: Action, bucket: string): Fragment | null {
      if (auth.role === "service") return null;
      const vars: Vars = { auth, ns: bucket, now: Date.now() };
      const mine = patterns
        .filter((p) => p.bucket === bucket && p.action === action)
        .sort((x, y) => Number(y.exact) - Number(x.exact) || y.prefix.length - x.prefix.length);
      if (mine.length === 0) return { sql: "0", bindings: [] };
      const matches = (p: Pattern): Fragment =>
        p.exact ? { sql: "name = ?", bindings: [p.prefix] } : { sql: "substr(name, 1, ?) = ?", bindings: [p.prefix.length, p.prefix] };
      const clauses = mine.map((p, i) => {
        const before = mine.slice(0, i).map(matches);
        const rule = compileRule(p.rule, this.#schema, this.#table(), vars);
        const parts = [matches(p), ...before.map((b) => ({ sql: `NOT (${b.sql})`, bindings: b.bindings })), rule];
        return { sql: parts.map((x) => `(${x.sql})`).join(" AND "), bindings: parts.flatMap((x) => x.bindings) };
      });
      return { sql: clauses.map((c) => `(${c.sql})`).join(" OR "), bindings: clauses.flatMap((c) => c.bindings) };
    }

    #allowed(auth: Auth, action: Action, bucket: string, name: string): boolean {
      const rule = this.#ruleSql(auth, action, bucket);
      if (!rule) return true;
      const [{ ok }] = this.ctx.storage.sql
        .exec<{ ok: number }>(`SELECT count(*) AS ok FROM objects WHERE bucket = ? AND name = ? AND (${rule.sql})`, bucket, name, ...rule.bindings)
        .toArray();
      return ok > 0;
    }

    #forbidden(action: Action, bucket: string, name: string): Refused {
      const what = action === "select" ? "" : `${action} `;
      return new Refused({ code: ErrorCode.Forbidden, message: `no access to ${what}files://${bucket}/${name}` });
    }
  };
}

export type FilesDO = InstanceType<ReturnType<typeof files>>;

