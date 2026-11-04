import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createClient, migrate } from "../src";
import type { Database } from "./durabase.gen";
import { migrations } from "./durabase.gen";

// Each test gets its own Database DO, so the tests do not share rows.
function freshDb() {
  return createClient<Database>(env.DB, { name: crypto.randomUUID() });
}

const customer = { name: "Asha", phone: "99999 00000" };

async function order(db: ReturnType<typeof freshDb>, n = 1) {
  const { data, error } = await db.rpc("create_order", {
    amountPaise: 1000 * n,
    customer,
    items: [
      { productId: "bricks", title: "Bricks", quantity: n },
      { productId: "house", title: "Play House", quantity: 1 },
    ],
  });
  expect(error).toBeNull();
  return data!.id;
}

describe("migrations", () => {
  it("applies each migration one time, in order", async () => {
    const name = crypto.randomUUID();
    await createClient<Database>(env.DB, { name }).from("orders").select("id");
    const stub = env.DB.get(env.DB.idFromName(name));
    const rows = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT version, name FROM _durabase_migrations ORDER BY version").toArray(),
    );
    expect(rows).toEqual([
      { version: 1, name: "init" },
      { version: 2, name: "notes" },
    ]);
  });

  it("answers each call with the error of a failed migration", async () => {
    const stub = env.DB.get(env.DB.idFromName(crypto.randomUUID()));
    const error = await runInDurableObject(stub, (_i, state) => {
      try {
        migrate(state.storage, [...migrations, { version: 3, name: "bad", statements: ["ALTER TABLE orders ADD COLUMN stat"] , }, { version: 4, name: "worse", statements: ["SELECT * FROM nope"] }]);
      } catch (e) {
        return (e as { code: number; data: unknown; message: string });
      }
    });
    expect(error?.code).toBe(-32000);
    expect(error?.message).toMatch(/^migration 4 failed: /);
    expect(error?.data).toMatchObject({ migration: 4, applied: 3 });
  });
});

describe("select", () => {
  it("reads the columns of each argument, with embedded rows", async () => {
    const db = freshDb();
    const id = await order(db, 2);
    const { data, error, count } = await db
      .from("orders")
      .select("id", "state", { order_items: ["title", "quantity"] })
      .eq("id", id);
    expect(error).toBeNull();
    expect(count).toBe(1);
    expect(data).toEqual([
      {
        id,
        state: "pending",
        order_items: [
          { title: "Bricks", quantity: 2 },
          { title: "Play House", quantity: 1 },
        ],
      },
    ]);
  });

  it("embeds the parent row as one object", async () => {
    const db = freshDb();
    const id = await order(db);
    const { data } = await db.from("order_items").select("title", { orders: ["state"] }).eq("product_id", "bricks").single();
    expect(data).toEqual({ title: "Bricks", orders: { state: "pending" } });
    expect(id).toMatch(/^LP-100\d$/);
  });

  it("filters, orders and limits", async () => {
    const db = freshDb();
    for (let n = 1; n <= 4; n++) await order(db, n);
    const { data } = await db
      .from("orders")
      .select("amount_paise")
      .gte("amount_paise", 2000)
      .in("state", ["pending", "paid"])
      .order("amount_paise", { ascending: false })
      .range(0, 1);
    expect(data).toEqual([{ amount_paise: 4000 }, { amount_paise: 3000 }]);
  });

  it("refuses a name that is not in the schema", async () => {
    const db = freshDb();
    const { data, error } = await db.from("orders").select("id", "stat" as "id");
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: -32602, message: "unknown column: stat" });

    const t = await db.from("orders; drop table orders" as "orders").select();
    expect(t.error).toMatchObject({ code: -32602 });
  });

  it("gives an error from single() for zero rows, and null from maybeSingle()", async () => {
    const db = freshDb();
    const one = await db.from("orders").select("id").eq("id", "LP-0").single();
    expect(one.error).toMatchObject({ code: -32004 });
    const maybe = await db.from("orders").select("id").eq("id", "LP-0").maybeSingle();
    expect(maybe).toMatchObject({ data: null, error: null });
  });
});

describe("insert, update and delete", () => {
  it("inserts rows and returns the selected columns", async () => {
    const db = freshDb();
    const { data, error } = await db
      .from("orders")
      .insert([
        { id: "A", amount_paise: 1, customer: "{}" },
        { id: "B", amount_paise: 2, customer: "{}" },
      ])
      .select("id", "state");
    expect(error).toBeNull();
    expect(data).toEqual([
      { id: "A", state: "pending" },
      { id: "B", state: "pending" },
    ]);
  });

  it("inserts more rows than one statement can bind", async () => {
    const db = freshDb();
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `R${i}`, amount_paise: i, customer: "{}" }));
    const { count, error } = await db.from("orders").insert(rows);
    expect(error).toBeNull();
    expect(count).toBe(120);
  });

  it("updates and deletes only the rows of the where", async () => {
    const db = freshDb();
    const a = await order(db, 1);
    const b = await order(db, 2);
    const up = await db.from("orders").update({ state: "paid", notes: "ok" }).eq("id", a).select("id", "state", "notes");
    expect(up.data).toEqual([{ id: a, state: "paid", notes: "ok" }]);

    await db.from("order_items").delete().eq("order_id", b);
    const del = await db.from("orders").delete().eq("id", b);
    expect(del).toMatchObject({ data: null, error: null, count: 1 });

    const { data } = await db.from("orders").select("id");
    expect(data).toEqual([{ id: a }]);
  });

  it("refuses an update or a delete with no where", async () => {
    const db = freshDb();
    await order(db);
    const up = await db.from("orders").update({ state: "paid" });
    expect(up.error).toMatchObject({ code: -32602, message: "where: an update needs a where" });
    const del = await db.from("orders").delete();
    expect(del.error).toMatchObject({ code: -32602 });
  });

  it("gives the SQLite error of a broken constraint", async () => {
    const db = freshDb();
    const { error } = await db.from("orders").insert({ id: "X", amount_paise: 1, customer: "{}", state: "lost" as "paid" });
    expect(error?.code).toBe(-32002);
    expect(error?.message).toMatch(/CHECK constraint failed/);
  });
});

describe("functions", () => {
  it("runs a function in one transaction and returns its result", async () => {
    const db = freshDb();
    const id = await order(db);
    const first = await db.rpc("pay_order", { eventId: "evt_1", orderId: id });
    const again = await db.rpc("pay_order", { eventId: "evt_1", orderId: id });
    expect(first.data).toEqual({ result: "applied", orderId: id });
    expect(again.data).toEqual({ result: "duplicate", orderId: id });
  });

  it("rolls back the writes of a function that throws", async () => {
    const db = freshDb();
    const { error } = await db.rpc("fail_after_write", { id: "GONE" });
    expect(error).toMatchObject({ code: -32003, message: "stop", data: { function: "fail_after_write" } });
    const { data } = await db.from("orders").select("id").eq("id", "GONE");
    expect(data).toEqual([]);
  });

  it("refuses an async function and an unknown function", async () => {
    const db = freshDb();
    expect((await db.rpc("async_fn")).error).toMatchObject({ code: -32003 });
    expect((await db.rpc("notAFunction" as "async_fn")).error).toMatchObject({ code: -32601 });
  });
});

describe("batches", () => {
  it("runs a batch in one transaction", async () => {
    const db = freshDb();
    const [a, b] = await db.batch([
      db.from("orders").insert({ id: "A", amount_paise: 1, customer: "{}" }),
      db.from("orders").select("id"),
    ]);
    expect(a.error).toBeNull();
    expect(b.data).toEqual([{ id: "A" }]);
  });

  it("rolls back the full batch if one call fails", async () => {
    const db = freshDb();
    const [a, b] = await db.batch([
      db.from("orders").insert({ id: "A", amount_paise: 1, customer: "{}" }),
      db.from("orders").insert({ id: "A", amount_paise: 1, customer: "{}" }),
    ]);
    expect(a.error).toMatchObject({ code: -32001, data: { failed: 1 } });
    expect(b.error?.code).toBe(-32002);
    const { data } = await db.from("orders").select("id");
    expect(data).toEqual([]);
  });
});

describe("the /db route", () => {
  it("answers JSON-RPC 2.0 over HTTP", async () => {
    const res = await SELF.fetch("https://test/db", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "insert", params: { table: "counters", rows: [{ name: "x", value: 1 }] } },
        { jsonrpc: "2.0", id: 2, method: "select", params: { table: "counters", where: { name: { eq: "x" } } } },
        { jsonrpc: "2.0", method: "select", params: { table: "counters" } },
      ]),
    });
    expect(await res.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: { count: 1 } },
      { jsonrpc: "2.0", id: 2, result: { rows: [{ name: "x", value: 1 }], count: 1 } },
    ]);
  });

  it("answers result null for a function that returns nothing", async () => {
    const res = await SELF.fetch("https://test/db", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fn.noop" }),
    });
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("answers a parse error and a bad request", async () => {
    const bad = await SELF.fetch("https://test/db", { method: "POST", body: "{" });
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    const wrong = await SELF.fetch("https://test/db", { method: "POST", body: JSON.stringify({ id: 1, method: "select" }) });
    expect(await wrong.json()).toMatchObject({ id: 1, error: { code: -32600 } });
    const get = await SELF.fetch("https://test/db");
    expect(get.status).toBe(405);
  });

  it("works with the client and a URL", async () => {
    const db = createClient<Database>({ fetcher: SELF, url: "https://test/db" });
    const { error } = await db.from("webhook_events").insert({ event_id: "e1", received_at: 1 });
    expect(error).toBeNull();
    const { data } = await db.from("webhook_events").select("event_id").eq("event_id", "e1").single();
    expect(data).toEqual({ event_id: "e1" });
  });
});
