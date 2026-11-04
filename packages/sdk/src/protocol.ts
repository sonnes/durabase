// The JSON-RPC 2.0 messages between the client and the Database Durable
// Object. The client and the DO use the same schemas.

import { z } from "zod";

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  MigrationFailed: -32000,
  BatchRolledBack: -32001,
  SqlError: -32002,
  FunctionError: -32003,
  RowCount: -32004,
  InternalError: -32603,
} as const;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

// An error with a JSON-RPC code. The DO sends it to the client.
export class DurabaseError extends Error implements RpcError {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "DurabaseError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  toJSON(): RpcError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export const Op = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "like"]);
export type Op = z.infer<typeof Op>;

const nonEmpty = (v: object) => Object.keys(v).length > 0;

// { state: { neq: "pending" }, amount_paise: { gte: 100, lt: 500 } }
const Filter = z.partialRecord(Op, z.unknown()).refine(nonEmpty, "a filter needs an operator");
export const Where = z.record(z.string(), Filter);
export type Where = z.infer<typeof Where>;

// A column name, or one level of embedded rows: { order_items: ["title"] }.
export const Column = z.union([
  z.string(),
  z.record(z.string(), z.array(z.string())).refine(nonEmpty, "an embed needs a table"),
]);
export type Column = z.infer<typeof Column>;

const Returning = z.array(z.string()).optional();
const Row = z.record(z.string(), z.unknown());

export const SelectParams = z.object({
  table: z.string(),
  columns: z.array(Column).optional(),
  where: Where.optional(),
  order: z.array(z.tuple([z.string(), z.enum(["asc", "desc"])])).optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type SelectParams = z.infer<typeof SelectParams>;

// onConflict "ignore" skips a row that breaks a UNIQUE or PRIMARY KEY.
export const InsertParams = z.object({
  table: z.string(),
  rows: z.array(Row).min(1),
  onConflict: z.literal("ignore").optional(),
  returning: Returning,
});
export type InsertParams = z.infer<typeof InsertParams>;

// An update and a delete need a where, so one call cannot change all rows
// by accident.
const requiredWhere = (what: string) =>
  z
    .record(z.string(), Filter, { error: (issue) => (issue.input === undefined ? `${what} needs a where` : undefined) })
    .refine(nonEmpty, `${what} needs a where`);

export const UpdateParams = z.object({
  table: z.string(),
  set: Row.refine(nonEmpty, "set needs a column"),
  where: requiredWhere("an update"),
  returning: Returning,
});
export type UpdateParams = z.infer<typeof UpdateParams>;

export const DeleteParams = z.object({
  table: z.string(),
  where: requiredWhere("a delete"),
  returning: Returning,
});
export type DeleteParams = z.infer<typeof DeleteParams>;

export const Id = z.union([z.string(), z.number(), z.null()]);
export type Id = z.infer<typeof Id>;

// The envelope. The DO reads params with the schema of the method.
export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: Id.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

// A function is "fn.<name>". The spec reserves the names that start with "rpc.".
export const FUNCTION_PREFIX = "fn.";

export type Method = "select" | "insert" | "update" | "delete" | `fn.${string}`;

export interface Call {
  method: Method;
  params: unknown;
}

// The result of a row method. rows is missing on a write with no returning.
export interface RowsResult {
  rows?: Record<string, unknown>[];
  count: number;
}

export type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: RpcError };

// A batch is an array. The DO runs the full array in one transaction.
export type RpcBody = RpcRequest | RpcRequest[];
