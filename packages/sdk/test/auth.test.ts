import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createClient, type Mailbox } from "../src";
import { signAccess, signRefresh } from "../src/auth/tokens";

// The test Worker serves https://test. The Auth DO sends the sign-in email
// from the mailbox orders@shop.example, and the links go to
// https://shop.example.

const ORIGIN = "https://test";
const SECRET = env.DURABASE_AUTH_SECRET;

function freshEmail(): string {
  return `${crypto.randomUUID().slice(0, 8)}@example.com`;
}

async function authCall(method: string, params: object = {}, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/auth/main`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { res, body: (await res.json()) as { result?: any; error?: { code: number; message: string; data?: any } } };
}

// The link and the code of the last sign-in email to this address.
async function lastEmail(email: string): Promise<{ link: string; code: string }> {
  const mail = createClient<Mailbox>("mail://orders@shop.example", env);
  const { data } = await mail
    .from("messages")
    .select("text", "to_addresses")
    .eq("folder", "outbox")
    .like("to_addresses", `%${email}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  const text = data?.[0]?.text ?? "";
  return {
    link: /Sign in: (\S+)/.exec(text)?.[1] ?? "",
    code: /Or type this code: (\d{6})/.exec(text)?.[1] ?? "",
  };
}

// The cookies of a response, as one Cookie header.
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function signIn(email: string): Promise<string> {
  await authCall("signInWithOtp", { email });
  const { code } = await lastEmail(email);
  const { res } = await authCall("verifyOtp", { email, code });
  return cookieHeader(res);
}

async function whoami(cookie: string, origin = ORIGIN) {
  const res = await SELF.fetch(`${ORIGIN}/db/${crypto.randomUUID()}`, {
    method: "POST",
    headers: { cookie, origin },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fn.whoami" }),
  });
  return { res, auth: ((await res.json()) as { result: unknown }).result };
}

describe("sign-in with a code", () => {
  it("sends one email with a link and a code, and signs in with the code", async () => {
    const email = freshEmail();
    const start = await authCall("signInWithOtp", { email: email.toUpperCase() });
    expect(start.body).toEqual({ jsonrpc: "2.0", id: 1, result: null });

    const { link, code } = await lastEmail(email);
    expect(link).toMatch(/^https:\/\/shop\.example\/auth\/main\/callback\?token=[\w-]{43}$/);
    expect(code).toMatch(/^\d{6}$/);

    const { res, body } = await authCall("verifyOtp", { email, code });
    expect(body.result.user).toMatchObject({ email, groups: [] });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c).toMatch(/^__Host-durabase-(access|refresh)=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

    const { auth } = await whoami(cookieHeader(res));
    expect(auth).toEqual({ role: "authenticated", sub: body.result.user.id, email, groups: [] });
  });

  it("refuses a wrong code, and stops the code after 5 wrong tries", async () => {
    const email = freshEmail();
    await authCall("signInWithOtp", { email });
    const { code } = await lastEmail(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const { body } = await authCall("verifyOtp", { email, code: wrong });
      expect(body.error).toMatchObject({ code: -32005, data: { reason: "invalid" } });
    }
    const { body } = await authCall("verifyOtp", { email, code });
    expect(body.error).toMatchObject({ code: -32005, data: { reason: "tries" } });
  });

  it("uses a code one time only", async () => {
    const email = freshEmail();
    await authCall("signInWithOtp", { email });
    const { code } = await lastEmail(email);
    await authCall("verifyOtp", { email, code });
    const again = await authCall("verifyOtp", { email, code });
    expect(again.body.error).toMatchObject({ data: { reason: "expired" } });
  });

  it("sends 5 emails for one address in one hour, then refuses", async () => {
    const email = freshEmail();
    for (let i = 0; i < 5; i++) expect((await authCall("signInWithOtp", { email })).body.error).toBeUndefined();
    const sixth = await authCall("signInWithOtp", { email });
    expect(sixth.body.error).toMatchObject({ code: -32005, data: { reason: "rate-limit" } });
  });

  it("refuses a sign-in from a page of another site", async () => {
    const { res } = await authCall("signInWithOtp", { email: freshEmail() }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("sign-in with the link", () => {
  it("sets the cookies and goes to the next path", async () => {
    const email = freshEmail();
    await authCall("signInWithOtp", { email, next: "/orders" });
    const { link } = await lastEmail(email);
    const url = new URL(link);
    expect(url.searchParams.get("next")).toBe("/orders");
    const res = await SELF.fetch(`${ORIGIN}${url.pathname}${url.search}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/orders");
    expect((await whoami(cookieHeader(res))).auth).toMatchObject({ role: "authenticated", email });

    const again = await SELF.fetch(`${ORIGIN}${url.pathname}${url.search}`, { redirect: "manual" });
    expect(again.headers.get("location")).toBe("/orders?auth_error=invalid");
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("leaves a next path of another site out of the link", async () => {
    const email = freshEmail();
    await authCall("signInWithOtp", { email, next: "//evil.example" });
    const { link } = await lastEmail(email);
    expect(new URL(link).searchParams.has("next")).toBe(false);
  });

  it("goes only to a path on this site", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/main/callback?token=x&next=//evil.example`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/?auth_error=invalid");
  });
});

describe("the session", () => {
  it("is anon for a POST from another site, and with no cookie", async () => {
    const cookie = await signIn(freshEmail());
    expect((await whoami(cookie, "https://evil.example")).auth).toEqual({ role: "anon" });
    expect((await whoami("")).auth).toEqual({ role: "anon" });
  });

  it("accepts the access token in a Bearer header", async () => {
    const token = await signAccess(SECRET, { id: "u1", email: "a@example.com", groups: ["staff"] }, "s1");
    const res = await SELF.fetch(`${ORIGIN}/db/${crypto.randomUUID()}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fn.whoami" }),
    });
    expect(((await res.json()) as { result: unknown }).result).toEqual({ role: "authenticated", sub: "u1", email: "a@example.com", groups: ["staff"] });
  });

  it("refreshes an expired access token with the refresh token", async () => {
    const email = freshEmail();
    const cookie = await signIn(email);
    const refreshOnly = cookie.split("; ").filter((c) => c.startsWith("__Host-durabase-refresh="))[0];

    const first = await whoami(refreshOnly);
    expect(first.auth).toMatchObject({ role: "authenticated", email });
    expect(first.res.headers.getSetCookie()).toHaveLength(2);

    // The same token again, at once: two tabs that refresh together.
    const second = await whoami(refreshOnly);
    expect(second.auth).toMatchObject({ role: "authenticated", email });

    // The next token works, and then the first token is too old.
    const next = cookieHeader(first.res)
      .split("; ")
      .filter((c) => c.startsWith("__Host-durabase-refresh="))[0];
    expect((await whoami(next)).auth).toMatchObject({ role: "authenticated" });
    const old = await whoami(refreshOnly);
    expect(old.auth).toEqual({ role: "anon" });
    expect(old.res.headers.getSetCookie().every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("ends the session when an old refresh token comes back", async () => {
    const cookie = await signIn(freshEmail());
    const stolen = cookie.split("; ").filter((c) => c.startsWith("__Host-durabase-refresh="))[0];
    const first = await whoami(stolen);
    const current = cookieHeader(first.res)
      .split("; ")
      .filter((c) => c.startsWith("__Host-durabase-refresh="))[0];
    const second = await whoami(current);
    const latest = cookieHeader(second.res)
      .split("; ")
      .filter((c) => c.startsWith("__Host-durabase-refresh="))[0];

    // Two steps old: a copy of the token. The session ends for each token.
    expect((await whoami(stolen)).auth).toEqual({ role: "anon" });
    expect((await whoami(latest)).auth).toEqual({ role: "anon" });
  });

  it("signs a standard HS256 JWT", async () => {
    const token = await signAccess(SECRET, { id: "u1", email: "a@example.com", groups: [] }, "s1");
    const [header, payload, sig] = token.split(".");
    expect(JSON.parse(atob(header))).toEqual({ alg: "HS256", typ: "JWT" });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)));
    const expected = btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(sig).toBe(expected);
  });

  it("refuses a refresh token that the server did not sign", async () => {
    const forged = await signRefresh("another-secret-of-32-characters-xx", "s1", 0);
    expect((await whoami(`__Host-durabase-refresh=${forged}`)).auth).toEqual({ role: "anon" });
  });

  it("gets the user, and signs out", async () => {
    const email = freshEmail();
    const cookie = await signIn(email);
    const user = await authCall("getUser", {}, { cookie });
    expect(user.body.result).toMatchObject({ email, role: "authenticated" });

    const out = await authCall("signOut", {}, { cookie });
    expect(out.res.headers.getSetCookie().every((c) => c.includes("Max-Age=0"))).toBe(true);
    const refreshOnly = cookie.split("; ").filter((c) => c.startsWith("__Host-durabase-refresh="))[0];
    expect((await whoami(refreshOnly)).auth).toEqual({ role: "anon" });
  });

  it("carries the groups that the service role sets, after the next refresh", async () => {
    const email = freshEmail();
    const cookie = await signIn(email);
    const { auth } = await whoami(cookie);
    const stub = env.AUTH.get(env.AUTH.idFromName("main"));
    await stub.setGroups((auth as { sub: string }).sub, ["staff"]);
    const refreshOnly = cookie.split("; ").filter((c) => c.startsWith("__Host-durabase-refresh="))[0];
    expect((await whoami(refreshOnly)).auth).toMatchObject({ groups: ["staff"] });
  });
});

describe("the Auth DO", () => {
  it("keeps only hashes of the link and the code", async () => {
    const email = freshEmail();
    await authCall("signInWithOtp", { email });
    const { link, code } = await lastEmail(email);
    const token = new URL(link).searchParams.get("token")!;
    const rows = await runInDurableObject(env.AUTH.get(env.AUTH.idFromName("main")), (_i, state) =>
      state.storage.sql.exec("SELECT * FROM codes WHERE email = ?", email).toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(code);
  });
});

describe("the client", () => {
  it("signs in and reads rows over HTTP", async () => {
    const jar: string[] = [];
    const fetchWithJar = async (input: RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", ORIGIN);
      if (jar.length) headers.set("cookie", jar.join("; "));
      const res = await SELF.fetch(input, { ...init, headers });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const name = pair.split("=")[0];
        const i = jar.findIndex((j) => j.startsWith(`${name}=`));
        if (i >= 0) jar.splice(i, 1);
        if (!c.includes("Max-Age=0")) jar.push(pair);
      }
      return res;
    };
    const db = createClient("db://client-test", undefined, { origin: ORIGIN, fetch: fetchWithJar });
    const email = freshEmail();
    expect((await db.auth.signInWithOtp({ email })).error).toBeNull();
    const { code } = await lastEmail(email);
    const { data: user } = await db.auth.verifyOtp({ email, code });
    expect(user).toMatchObject({ email, role: "authenticated" });
    expect((await db.auth.getUser()).data).toMatchObject({ email });
    expect((await db.rpc("whoami")).data).toMatchObject({ email });
    await db.auth.signOut();
    expect((await db.auth.getUser()).data).toBeNull();
  });

  it("has no session with a binding", async () => {
    const db = createClient("db://shop", env);
    expect((await db.auth.getUser()).error).toMatchObject({ code: -32600 });
  });
});
