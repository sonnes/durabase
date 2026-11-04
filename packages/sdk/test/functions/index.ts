import { fn } from "./fn";

// Writes an order and its items, with the next order number.
export const create_order = fn(
  (tx, a: { amountPaise: number; customer: object; items: { productId: string; title: string; quantity: number }[] }) => {
    const [{ value }] = tx.sql<{ value: number }>(
      `INSERT INTO counters (name, value) VALUES ('order', 1001)
       ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value`,
    );
    const id = `LP-${value}`;
    tx.from("orders").insert({ id, amount_paise: a.amountPaise, customer: JSON.stringify(a.customer), created_at: tx.now }).run();
    tx.from("order_items")
      .insert(a.items.map((i) => ({ order_id: id, product_id: i.productId, title: i.title, quantity: i.quantity })))
      .run();
    return { id };
  },
);

// Marks an order paid one time for each webhook event.
export const pay_order = fn((tx, a: { eventId: string; orderId: string }) => {
  const order = tx.from("orders").select("id", "state").eq("id", a.orderId).maybeOne();
  if (!order) return { result: "unknown-order" as const };
  if (!tx.insertOrIgnore("webhook_events", { event_id: a.eventId, received_at: tx.now })) {
    return { result: "duplicate" as const, orderId: order.id };
  }
  tx.from("orders").update({ state: "paid" }).eq("id", order.id).eq("state", "pending").run();
  return { result: "applied" as const, orderId: order.id };
});

// Writes a row, then fails. The write must roll back.
export const fail_after_write = fn((tx, a: { id: string }) => {
  tx.from("orders").insert({ id: a.id, amount_paise: 1, customer: "{}" }).run();
  throw new Error("stop");
});

// An async function is an error: a function runs in a transaction.
export const async_fn = fn(async () => 1);

// Returns nothing. The response still has a result: null.
export const noop = fn(() => {});

// Not a function: the DO ignores it.
export const notAFunction = 42;
