// Type checks only. `pnpm typecheck` compiles this file. Nothing runs it.

import { createClient } from "../src";
import type { Database } from "./durabase.gen";

declare const ns: DurableObjectNamespace;
const db = createClient<Database>(ns);

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>() {}

export async function checks() {
  // Each column is one argument. The row type has only those columns.
  const { data } = await db.from("orders").select("id", "state");
  assert<Equal<typeof data, { id: string; state: "pending" | "paid" | "shipped" }[] | null>>();

  // An embed of many rows is an array. An embed of the parent is an object or null.
  const many = await db.from("orders").select("id", { order_items: ["title"] }).single();
  assert<Equal<typeof many.data, { id: string; order_items: { title: string }[] } | null>>();
  const one = await db.from("order_items").select("title", { orders: ["state"] });
  assert<Equal<typeof one.data, { title: string; orders: { state: "pending" | "paid" | "shipped" } | null }[] | null>>();

  // No arguments: the full row.
  const all = await db.from("counters").select();
  assert<Equal<typeof all.data, { name: string; value: number }[] | null>>();

  // @ts-expect-error: "stat" is not a column of orders.
  await db.from("orders").select("id", "stat");
  // @ts-expect-error: "nope" is not a table.
  db.from("nope");
  // @ts-expect-error: the value of eq() must have the type of the column.
  await db.from("orders").select("id").eq("amount_paise", "100");
  // @ts-expect-error: "lost" is not a value of the CHECK of state.
  await db.from("orders").update({ state: "lost" }).eq("id", "LP-1");
  // @ts-expect-error: insert needs amount_paise and customer.
  await db.from("orders").insert({ id: "LP-1" });

  // The args and the result of a function come from its handler.
  const paid = await db.rpc("pay_order", { eventId: "e", orderId: "LP-1" });
  assert<Equal<NonNullable<typeof paid.data>["result"], "unknown-order" | "duplicate" | "applied">>();
  // @ts-expect-error: pay_order needs eventId.
  await db.rpc("pay_order", { orderId: "LP-1" });
  // @ts-expect-error: "notAFunction" is not a function.
  await db.rpc("notAFunction");
}
