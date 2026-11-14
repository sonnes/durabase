import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { limitRequest, serve, type Limiter } from "../src";

// The test Worker serves https://test. Its limiter DURABASE_LIMIT accepts 300
// requests in 60 seconds for one key (test/wrangler.jsonc).

const ORIGIN = "https://test";
const LIMIT = 300;

function call(method: string, params?: unknown) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

// A limiter that refuses each key in over, and records each key.
function fakeLimiter(over: string[] = []): Limiter & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: !over.includes(key) };
    },
  };
}

describe("the rate limit", () => {
  it("answers 429 after the limit of one address and one route", async () => {
    const ip = "203.0.113.7";
    const post = (address: string) =>
      SELF.fetch(`${ORIGIN}/db/http`, { method: "POST", headers: { "cf-connecting-ip": address }, body: JSON.stringify(call("fn.whoami")) });

    const answers = await Promise.all(Array.from({ length: LIMIT + 1 }, () => post(ip)));
    const refused = answers.filter((r) => r.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0].headers.get("retry-after")).toBe("60");
    expect(await refused[0].json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32006, message: "too many requests. Try again in 60 seconds." },
    });

    expect((await post(ip)).status).toBe(429);
    expect((await post("203.0.113.8")).status).toBe(200);
  });

  it("makes one key from the address, the scheme and the name, on each route", async () => {
    const limiter = fakeLimiter();
    const e = { ...env, DURABASE_LIMIT: limiter };
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    await serve(new Request(`${ORIGIN}/db/http`, { method: "POST", headers, body: "{}" }), e, { databases: ["http"] });
    await serve(new Request(`${ORIGIN}/auth/main`, { method: "POST", headers, body: "{}" }), e);
    await serve(new Request(`${ORIGIN}/auth/main/callback?token=x`, { headers }), e);
    await serve(new Request(`${ORIGIN}/files/media/avatars/x.txt`, { headers }), e);
    await serve(new Request(`${ORIGIN}/files/media`, { method: "POST", body: "{}" }), e);
    expect(limiter.keys).toEqual([
      "203.0.113.9 db/http",
      "203.0.113.9 auth/main",
      "203.0.113.9 auth/main",
      "203.0.113.9 files/media",
      "unknown files/media",
    ]);
  });

  it("refuses before a call to a Durable Object", async () => {
    const limiter = fakeLimiter(["unknown db/http", "unknown auth/main", "unknown files/media"]);
    // With no binding of a Durable Object, a call to one throws.
    const e = { DURABASE_AUTH_SECRET: env.DURABASE_AUTH_SECRET, DURABASE_LIMIT: limiter };
    const requests = [
      new Request(`${ORIGIN}/db/http`, { method: "POST", body: "{}" }),
      new Request(`${ORIGIN}/auth/main`, { method: "POST", body: "{}" }),
      new Request(`${ORIGIN}/auth/main/callback?token=x`),
      new Request(`${ORIGIN}/files/media/avatars/x.txt`),
    ];
    for (const request of requests) {
      const res = await serve(request, e, { databases: ["http"] });
      expect(res?.status).toBe(429);
    }
  });

  it("uses the binding of the options, and limits nothing with no binding", async () => {
    const limiter = fakeLimiter(["unknown db/http"]);
    const request = () => new Request(`${ORIGIN}/db/http`, { method: "POST", body: JSON.stringify(call("fn.whoami")) });
    const { DURABASE_LIMIT: _, ...rest } = env;
    const named = await serve(request(), { ...rest, MY_LIMIT: limiter }, { databases: ["http"], bindings: { limit: "MY_LIMIT" } });
    expect(named?.status).toBe(429);
    const none = await serve(request(), rest, { databases: ["http"] });
    expect(none?.status).toBe(200);
  });

  it("gives limitRequest to the routes of the app", async () => {
    const limiter = fakeLimiter(["203.0.113.9 subscribe"]);
    const request = new Request(`${ORIGIN}/subscribe`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } });
    const refused = await limitRequest(request, limiter, "subscribe");
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toBe("60");
    expect(await limitRequest(request, limiter, "other")).toBeUndefined();
    // The default key is the path of the request.
    expect(await limitRequest(request, limiter)).toBeUndefined();
    expect(limiter.keys).toEqual(["203.0.113.9 subscribe", "203.0.113.9 other", "203.0.113.9 /subscribe"]);
    expect(await limitRequest(request, undefined)).toBeUndefined();
  });
});

describe("the databases of serve()", () => {
  const post = (name: string) => SELF.fetch(`${ORIGIN}/db/${name}`, { method: "POST", body: JSON.stringify(call("fn.whoami")) });

  it("answers 404 for a database that is not in the list", async () => {
    const res = await post(crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: -32600, message: expect.stringMatching(/^unknown database: /) } });
    expect((await post("http")).status).toBe(200);
  });

  it("serves no database with no list, and accepts a function as the list", async () => {
    const request = (name: string) => new Request(`${ORIGIN}/db/${name}`, { method: "POST", body: JSON.stringify(call("fn.whoami")) });
    expect((await serve(request("http"), env))?.status).toBe(404);
    const tenants = { databases: (name: string) => name.startsWith("tenant-") };
    expect((await serve(request("tenant-1"), env, tenants))?.status).toBe(200);
    expect((await serve(request("http"), env, tenants))?.status).toBe(404);
  });
});

describe("the size of a request", () => {
  it("refuses a body over 1 MB, from the Content-Length header", async () => {
    for (const path of ["/db/http", "/auth/main", "/files/media"]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN }, body: `"${"x".repeat(1_000_000)}"` });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "the body is larger than 1000000 bytes" } });
    }
  });

  it("refuses a body over the limit of the options, with no Content-Length header", async () => {
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode(" ".repeat(30)));
          c.enqueue(new TextEncoder().encode(JSON.stringify(call("fn.whoami"))));
          c.close();
        },
      });
    const request = () => new Request(`${ORIGIN}/db/http`, { method: "POST", body: body(), duplex: "half" } as RequestInit);
    expect(request().headers.has("content-length")).toBe(false);
    const big = await serve(request(), env, { databases: ["http"], maxBody: 100 });
    expect(big?.status).toBe(413);
    const ok = await serve(request(), env, { databases: ["http"], maxBody: 500 });
    expect(ok?.status).toBe(200);
  });

  it("refuses a batch of more than 100 calls", async () => {
    const batch = (n: number) => SELF.fetch(`${ORIGIN}/db/http`, { method: "POST", body: JSON.stringify(Array.from({ length: n }, () => call("fn.whoami"))) });
    const big = await batch(101);
    expect(await big.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "a batch has 100 calls at most" } });
    expect(await (await batch(100)).json()).toHaveLength(100);
  });
});

describe("the secret", () => {
  it("must have 32 characters or more", async () => {
    const request = new Request(`${ORIGIN}/db/http`, { method: "POST", body: JSON.stringify(call("fn.whoami")) });
    const short = { ...env, DURABASE_AUTH_SECRET: "x".repeat(31) };
    await expect(serve(request, short, { databases: ["http"] })).rejects.toThrow("the secret DURABASE_AUTH_SECRET must have 32 characters or more");
  });
});

describe("an error over HTTP", () => {
  const post = (body: unknown) => SELF.fetch(`${ORIGIN}/db/http`, { method: "POST", body: JSON.stringify(body) });

  it("hides the message of an error that is not a DurabaseError", async () => {
    const res = await post(call("fn.public_fail"));
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32003, message: "the function public_fail failed", data: { function: "public_fail" } },
    });
  });
});
