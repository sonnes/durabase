// The types that durabase.gen.ts fills. A table has row, insert, update and
// relationships. A function has args and returns.

export interface TableShape {
  row: Record<string, unknown>;
  insert: Record<string, unknown>;
  update: Record<string, unknown>;
  relationships: Record<string, "one" | "many">;
}

export type TablesShape = Record<string, TableShape>;

export interface FunctionShape {
  args: unknown;
  returns: unknown;
}

export interface DatabaseShape {
  tables: TablesShape;
  functions: Record<string, FunctionShape>;
}

// With no generated types, every name is a string and every row is a record.
export interface AnyDatabase {
  tables: Record<
    string,
    {
      row: Record<string, unknown>;
      insert: Record<string, unknown>;
      update: Record<string, unknown>;
      relationships: Record<string, "one" | "many">;
    }
  >;
  functions: Record<string, { args: any; returns: any }>;
}

export type TableName<T extends TablesShape> = keyof T & string;
export type RowOf<T extends TablesShape, N extends TableName<T>> = T[N]["row"];
type Relations<T extends TablesShape, N extends TableName<T>> = keyof T[N]["relationships"] & TableName<T>;

// An argument of select(): a column, "*", or one level of embedded rows.
export type ColumnArg<T extends TablesShape, N extends TableName<T>> =
  | (keyof RowOf<T, N> & string)
  | "*"
  | { [R in Relations<T, N>]?: readonly ((keyof RowOf<T, R> & string) | "*")[] };

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type PickCols<Row, C> = "*" extends C ? Row : Pick<Row, Extract<C, keyof Row>>;

type EmbedResult<T extends TablesShape, N extends TableName<T>, E> = {
  [R in keyof E & Relations<T, N>]: E[R] extends readonly (infer C)[]
    ? T[N]["relationships"][R] extends "many"
      ? Simplify<PickCols<RowOf<T, R>, C>>[]
      : Simplify<PickCols<RowOf<T, R>, C>> | null
    : never;
};

// The row type of a select with these arguments.
export type Selected<T extends TablesShape, N extends TableName<T>, C extends readonly unknown[]> = C extends readonly []
  ? RowOf<T, N>
  : Simplify<
      PickCols<RowOf<T, N>, Extract<C[number], string>> &
        UnionToIntersection<
          C[number] extends infer E ? (E extends object ? EmbedResult<T, N, E> : {}) : {}
        >
    >;

export interface Result<T> {
  data: T | null;
  error: { code: number; message: string; data?: unknown } | null;
  count: number | null;
}
