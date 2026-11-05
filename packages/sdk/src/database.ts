// The Database Durable Object. A project exports it with one line:
//
//   export const Database = database({ migrations, functions });
//
// The developer writes no Durable Object class.

import { DurableObject } from "cloudflare:workers";
import { SERVICE, type Auth } from "./caller";
import { migrate, type Migration } from "./migrate";
import { parsePolicies, Policies, type Policy } from "./policy";
import { DurabaseError, ErrorCode, type RpcResponse } from "./protocol";
import { collectFunctions, handle, type Context, type Rows } from "./rpc";
import { loadSchema, type Schema } from "./schema";

export interface DatabaseOptions {
  migrations: Migration[];
  // The functions module: each export made with fn() is "fn.<export name>".
  functions?: Record<string, unknown>;
  // "read" accepts select only, so each write goes through a function.
  // The default is "all".
  rows?: Rows;
  // The policies of durabase.gen.ts. The DO uses the db:// policies, for the
  // callers of serve(). With no policies, a caller over HTTP gets no rows.
  policies?: readonly Policy[];
}

export interface DatabaseRpc {
  // The call from code with a binding: the service role.
  rpc(body: unknown): Promise<RpcResponse | RpcResponse[] | undefined>;
  // The call from serve(), for a caller over HTTP. The policies apply.
  rpcAs(body: unknown, auth: Auth): Promise<RpcResponse | RpcResponse[] | undefined>;
}

export function database(options: DatabaseOptions) {
  const functions = collectFunctions(options.functions);

  return class Database extends DurableObject implements DatabaseRpc {
    #schema!: Schema;
    #policies: Policies = new Policies("db", []);
    #migrationError?: DurabaseError;

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env as never);
      ctx.blockConcurrencyWhile(async () => {
        try {
          this.#policies = parsePolicies(options.policies ?? [], "db");
          migrate(ctx.storage, options.migrations);
        } catch (error) {
          this.#migrationError =
            error instanceof DurabaseError
              ? error
              : new DurabaseError(ErrorCode.MigrationFailed, error instanceof Error ? error.message : String(error));
        }
        this.#schema = loadSchema(ctx.storage.sql);
      });
    }

    async rpc(body: unknown): Promise<RpcResponse | RpcResponse[] | undefined> {
      return this.rpcAs(body, SERVICE);
    }

    async rpcAs(body: unknown, auth: Auth): Promise<RpcResponse | RpcResponse[] | undefined> {
      const context: Context = {
        storage: this.ctx.storage,
        schema: this.#schema,
        functions,
        env: this.env,
        name: this.ctx.id.name,
        rows: options.rows ?? "all",
        migrationError: this.#migrationError,
        auth,
        policies: this.#policies,
      };
      return handle(context, body);
    }
  };
}
