import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createClient, type Auth, type RpcResponse } from "../src";
import type { Database } from "./durabase.gen";

// The policies come from test/durabase/policies.yaml.

const asha: Auth = { role: "authenticated", sub: "u-asha", email: "asha@example.com", groups: [] };
const ravi: Auth = { role: "authenticated", sub: "u-ravi", email: "ravi@example.com", groups: [] };
const staff: Auth = { role: "authenticated", sub: "u-staff", email: "kiran@staff.example", groups: ["staff"] };
const anon: Auth = { role: "anon" };

// A namespace with two orders: one of asha and one of ravi.
async function shop() {
  const name = crypto.randomUUID();
  const service = createClient<Database>(`db://${name}`, { env });
  await service.from("orders").insert([
    { id: "LP-1", amount_paise: 100, customer: "{}", customer_email: "asha@example.com" },
    { id: "LP-2", amount_paise: 200, customer: "{}", customer_email: "ravi@example.com" },
  ]);
  await service.from("order_items").insert([
    { order_id: "LP-1", product_id: "kit", title: "Brick kit", quantity: 1 },
    { order_id: "LP-2", product_id: "pdf", title: "Printables", quantity: 2 },
  ]);
  await service.from("tags").insert([{ name: "red", owner: "kiran@staff.example" }]);
  await service.from("counters").insert([
    { name: "public", value: 1 },
    { name: "private", value: 2 },
  ]);
  const stub = env.DB.get(env.DB.idFromName(name)) as unknown as {
    rpcAs(body: unknown, auth: Auth): Promise<RpcResponse>;
  };
  const call = async (auth: Auth, method: string, params: unknown) => {
    const r = await stub.rpcAs({ jsonrpc: "2.0", id: 1, method, params }, auth);
    return "error" in r ? { error: r.error } : { result: r.result as { rows?: Record<string, unknown>[]; count: number } };
  };
  return { name, service, call };
}

describe("select", () => {
  it("gives each caller only the rows of the rule", async () => {
    const { call } = await shop();
    const mine = await call(asha, "select", { table: "orders", columns: ["id"] });
    expect(mine.result?.rows).toEqual([{ id: "LP-1" }]);
    const none = await call(anon, "select", { table: "orders", columns: ["id"] });
    expect(none.result?.rows).toEqual([]);
  });

  it("applies the rule to an embed", async () => {
    const { call } = await shop();
    const r = await call(asha, "select", { table: "order_items", columns: ["title"] });
    expect(r.result?.rows).toEqual([{ title: "Brick kit" }]);
    const embed = await call(asha, "select", { table: "orders", columns: ["id", { order_items: ["title"] }] });
    expect(embed.result?.rows).toEqual([{ id: "LP-1", order_items: [{ title: "Brick kit" }] }]);
  });

  it("refuses a column that a policy closes, and leaves it out of *", async () => {
    const { call } = await shop();
    const r = await call(asha, "select", { table: "orders", columns: ["id", "customer"] });
    expect(r.error).toEqual({ code: -32005, message: expect.stringMatching(/^no access to db:\/\/.+\/orders#customer$/) });
    const all = await call(asha, "select", { table: "orders" });
    expect(Object.keys(all.result!.rows![0]).sort()).toEqual(["amount_paise", "created_at", "customer_email", "id", "notes", "state"]);
  });

  it("refuses a filter or a sort on a closed column", async () => {
    const { call } = await shop();
    const closed = { code: -32005, message: expect.stringMatching(/^no access to db:\/\/.+\/orders#customer$/) };
    const where = await call(asha, "select", { table: "orders", columns: ["id"], where: { customer: { like: "%{%" } } });
    expect(where.error).toEqual(closed);
    const order = await call(asha, "select", { table: "orders", columns: ["id"], order: [["customer", "asc"]] });
    expect(order.error).toEqual(closed);
    const update = await call(asha, "update", { table: "orders", set: { notes: "x" }, where: { customer: { eq: "{}" } } });
    expect(update.error).toEqual(closed);
    const remove = await call(staff, "delete", { table: "orders", where: { customer: { eq: "{}" } } });
    expect(remove.error).toMatchObject({ code: -32005 });
  });

  it("matches a var with like", async () => {
    const { call } = await shop();
    const s = await call(staff, "select", { table: "tags", columns: ["name"] });
    expect(s.result?.rows).toEqual([{ name: "red" }]);
    const a = await call(asha, "select", { table: "tags", columns: ["name"] });
    expect(a.result?.rows).toEqual([]);
  });

  it("matches a list var with has, and a list with one match", async () => {
    const { call } = await shop();
    const s = await call(staff, "select", { table: "counters", columns: ["name"], order: [["name", "asc"]] });
    expect(s.result?.rows).toEqual([{ name: "private" }, { name: "public" }]);
    const a = await call(anon, "select", { table: "counters", columns: ["name"] });
    expect(a.result?.rows).toEqual([{ name: "public" }]);
  });

  it("gives the service role each row", async () => {
    const { service } = await shop();
    const { data } = await service.from("orders").select("id", "customer").order("id");
    expect(data).toEqual([
      { id: "LP-1", customer: "{}" },
      { id: "LP-2", customer: "{}" },
    ]);
  });
});

describe("writes", () => {
  it("accepts an insert that passes the rule", async () => {
    const { call } = await shop();
    const r = await call(asha, "insert", { table: "orders", rows: [{ id: "LP-3", amount_paise: 1, customer: "{}", customer_email: "asha@example.com" }] });
    expect(r.result).toEqual({ count: 1 });
  });

  it("refuses an insert that fails the rule, and writes nothing", async () => {
    const { call, service } = await shop();
    const r = await call(asha, "insert", {
      table: "orders",
      rows: [
        { id: "LP-3", amount_paise: 1, customer: "{}", customer_email: "asha@example.com" },
        { id: "LP-4", amount_paise: 1, customer: "{}", customer_email: "ravi@example.com" },
      ],
    });
    expect(r.error).toMatchObject({ code: -32005, message: expect.stringMatching(/no access to insert db:\/\/.+\/orders$/) });
    const { data } = await service.from("orders").select("id").order("id");
    expect(data).toEqual([{ id: "LP-1" }, { id: "LP-2" }]);
  });

  it("updates only the rows of the rule", async () => {
    const { call, service } = await shop();
    const r = await call(asha, "update", { table: "orders", set: { notes: "hi" }, where: { amount_paise: { gt: 0 } } });
    expect(r.result).toEqual({ count: 1 });
    const { data } = await service.from("orders").select("id", "notes").order("id");
    expect(data).toEqual([
      { id: "LP-1", notes: "hi" },
      { id: "LP-2", notes: null },
    ]);
  });

  it("refuses an update that moves a row out of the rule", async () => {
    const { call } = await shop();
    const r = await call(asha, "update", { table: "orders", set: { customer_email: "ravi@example.com" }, where: { id: { eq: "LP-1" } } });
    expect(r.error).toMatchObject({ code: -32005 });
  });

  it("checks the rows of a table with no rowid", async () => {
    const { call } = await shop();
    const ok = await call(asha, "insert", { table: "tags", rows: [{ name: "blue", owner: "asha@example.com" }] });
    expect(ok.result).toEqual({ count: 1 });
    const bad = await call(asha, "insert", { table: "tags", rows: [{ name: "green", owner: "ravi@example.com" }] });
    expect(bad.error).toMatchObject({ code: -32005 });
    const moved = await call(asha, "update", { table: "tags", set: { owner: "ravi@example.com" }, where: { name: { eq: "blue" } } });
    expect(moved.error).toMatchObject({ code: -32005 });
  });

  it("refuses a write with no policy", async () => {
    const { call } = await shop();
    const r = await call(asha, "delete", { table: "orders", where: { id: { eq: "LP-1" } } });
    expect(r.error).toEqual({ code: -32005, message: expect.stringMatching(/no access to delete db:\/\/.+\/orders$/) });
  });

  it("returns only the columns that the caller can read", async () => {
    const { call } = await shop();
    const r = await call(asha, "update", { table: "orders", set: { notes: "x" }, where: { id: { eq: "LP-1" } }, returning: ["*"] });
    expect(r.result?.rows?.[0]).not.toHaveProperty("customer");
    expect(r.result?.rows?.[0]).not.toHaveProperty("__durabase_rowid");
  });
});

describe("a batch", () => {
  it("rolls back the full batch when a policy refuses one call", async () => {
    const name = crypto.randomUUID();
    const stub = env.DB.get(env.DB.idFromName(name)) as unknown as { rpcAs(body: unknown, auth: Auth): Promise<RpcResponse[]> };
    const out = await stub.rpcAs(
      [
        { jsonrpc: "2.0", id: 1, method: "insert", params: { table: "orders", rows: [{ id: "A", amount_paise: 1, customer: "{}", customer_email: "asha@example.com" }] } },
        { jsonrpc: "2.0", id: 2, method: "insert", params: { table: "counters", rows: [{ name: "x", value: 1 }] } },
      ],
      asha,
    );
    expect(out[1]).toMatchObject({ error: { code: -32005 } });
    const { data } = await createClient<Database>(`db://${name}`, { env }).from("orders").select("id");
    expect(data).toEqual([]);
  });
});

describe("tx.auth", () => {
  it("gives a function the caller, and the service role to a binding", async () => {
    const { call, service } = await shop();
    expect((await call(ravi, "fn.whoami", undefined)).result).toEqual(ravi);
    expect((await service.rpc("whoami")).data).toEqual({ role: "service" });
  });
});
