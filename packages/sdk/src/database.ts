// The Database Durable Object. A project exports it with one line:
//
//   export const Database = database({ migrations, functions });
//
// The developer writes no Durable Object class.

import { DurableObject } from "cloudflare:workers";
import { migrate, type Migration } from "./migrate";
import { DurabaseError, ErrorCode, type RpcResponse } from "./protocol";
import { collectFunctions, handle, type Context } from "./rpc";
import { loadSchema, type Schema } from "./schema";

export interface DatabaseOptions {
  migrations: Migration[];
  // The functions module: each export made with fn() is "fn.<export name>".
  functions?: Record<string, unknown>;
}

export interface DatabaseRpc {
  rpc(body: unknown): Promise<RpcResponse | RpcResponse[] | undefined>;
}

export function database(options: DatabaseOptions) {
  const functions = collectFunctions(options.functions);

  return class Database extends DurableObject implements DatabaseRpc {
    #schema!: Schema;
    #migrationError?: DurabaseError;

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env as never);
      ctx.blockConcurrencyWhile(async () => {
        try {
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

    // The call from a client with a binding to this DO.
    async rpc(body: unknown): Promise<RpcResponse | RpcResponse[] | undefined> {
      const context: Context = {
        storage: this.ctx.storage,
        schema: this.#schema,
        functions,
        env: this.env,
        migrationError: this.#migrationError,
      };
      return handle(context, body);
    }

    // The call over HTTP: POST a JSON-RPC 2.0 body.
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "POST") {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: ErrorCode.InvalidRequest, message: "use POST with a JSON-RPC 2.0 body" } },
          { status: 405 },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "the body is not JSON" } });
      }
      const result = await this.rpc(body);
      return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
    }
  };
}
