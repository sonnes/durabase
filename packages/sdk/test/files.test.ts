import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createClient } from "../src";
import { signAccess } from "../src/auth/tokens";

// The buckets and the policies come from test/worker.ts and
// test/durabase/policies.yaml:
//
//   media        public, images and text, 1000 bytes at most
//   printables   private, PDFs. A buyer can read them.

const ORIGIN = "https://test";
const media = createClient("files://media", { env });
const printables = createClient("files://printables", { env, origin: ORIGIN });

function freshName(dir = "avatars"): string {
  return `${dir}/${crypto.randomUUID().slice(0, 8)}.txt`;
}

async function bearer(sub: string, groups: string[] = []): Promise<string> {
  return `Bearer ${await signAccess(env.DURABASE_AUTH_SECRET, { id: sub, email: `${sub}@example.com`, groups }, "s1")}`;
}

async function put(name: string, body: string, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/files/media/${name}`, {
    method: "PUT",
    headers: { "content-type": "text/plain", ...headers },
    body,
  });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: any } };
}

async function rpc(bucket: string, method: string, params: object, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/files/${bucket}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: any; error?: any };
}

async function r2Keys(prefix: string): Promise<string[]> {
  return (await env.FILES_BUCKET.list({ prefix })).objects.map((o) => o.key);
}

describe("the service role", () => {
  it("uploads, lists and removes a file", async () => {
    const name = freshName();
    const up = await media.upload(name, "hello", { contentType: "text/plain" });
    expect(up.error).toBeNull();
    expect(up.data).toMatchObject({ name, size: 5 });

    const { data: rows } = await media.list(name);
    expect(rows).toEqual([expect.objectContaining({ bucket: "media", name, owner_id: null, size: 5, type: "text/plain" })]);
    expect(await r2Keys(`media/${name}/`)).toEqual([`media/${name}/${up.data!.version}`]);

    expect((await media.remove([name])).data).toEqual([name]);
    expect((await media.list(name)).data).toEqual([]);
    expect(await r2Keys(`media/${name}/`)).toEqual([]);
  });

  it("refuses a file over the size limit, and a type that the bucket does not take", async () => {
    expect((await media.upload(freshName(), "x".repeat(1001), { contentType: "text/plain" })).error).toMatchObject({ data: { reason: "size" } });
    expect((await media.upload(freshName(), "x", { contentType: "application/pdf" })).error).toMatchObject({ data: { reason: "type" } });
    expect((await media.upload("../x", "x", { contentType: "text/plain" })).error).toMatchObject({ message: "not a valid file name: ../x" });
  });

  it("makes a signed link to a private file, which a new upload stops", async () => {
    const name = `atlas/${crypto.randomUUID().slice(0, 8)}.pdf`;
    await printables.upload(name, "%PDF-1", { contentType: "application/pdf" });
    const { data: link } = await printables.createSignedUrl(name, { expiresIn: 60 });
    expect(link).toMatch(/^https:\/\/test\/files\/printables\/atlas\/.+\.pdf\?v=[\w-]+&exp=\d+&sig=[\w-]+$/);

    const ok = await SELF.fetch(link!);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("%PDF-1");

    const forged = await SELF.fetch(link!.replace(/sig=.+$/, "sig=AAAA"));
    expect(forged.status).toBe(403);

    await printables.upload(name, "%PDF-2", { contentType: "application/pdf", upsert: true });
    expect((await SELF.fetch(link!)).status).toBe(404);
  });

  it("needs the origin of the site for a signed link", async () => {
    const name = `atlas/${crypto.randomUUID().slice(0, 8)}.pdf`;
    await printables.upload(name, "%PDF", { contentType: "application/pdf" });
    const noOrigin = createClient("files://printables", { env });
    expect((await noOrigin.createSignedUrl(name, { expiresIn: 60 })).error).toMatchObject({ code: -32600 });
  });
});

describe("uploads over HTTP", () => {
  it("refuses anon, and accepts a signed-in user as the owner", async () => {
    const name = freshName();
    const anon = await put(name, "hi");
    expect(anon.status).toBe(403);
    expect(anon.body).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32005, message: `no access to insert files://media/${name}` } });
    expect(await r2Keys(`media/${name}/`)).toEqual([]);

    const ok = await put(name, "hi", { authorization: await bearer("asha") });
    expect(ok.status).toBe(200);
    expect((await media.list(name)).data?.[0]).toMatchObject({ owner_id: "asha" });
  });

  it("refuses a file that exists, and overwrites it with upsert for the owner only", async () => {
    const name = freshName();
    const asha = await bearer("asha");
    const first = await put(name, "one", { authorization: asha });
    expect((await put(name, "two", { authorization: asha })).status).toBe(409);
    expect((await put(name, "two", { authorization: await bearer("ravi"), "x-upsert": "true" })).status).toBe(403);

    const second = await put(name, "two", { authorization: asha, "x-upsert": "true" });
    expect(second.status).toBe(200);
    expect(second.body.result.version).not.toBe(first.body.result.version);
    expect(await r2Keys(`media/${name}/`)).toEqual([`media/${name}/${second.body.result.version}`]);
  });

  it("refuses a policy that does not cover the path", async () => {
    const r = await put("other/x.txt", "x", { authorization: await bearer("asha") });
    expect(r.status).toBe(403);
  });

  it("lets only the owner remove a file", async () => {
    const name = freshName();
    await put(name, "x", { authorization: await bearer("asha") });
    const ravi = await rpc("media", "remove", { names: [name] }, { authorization: await bearer("ravi") });
    expect(ravi.error).toMatchObject({ code: -32005 });
    const asha = await rpc("media", "remove", { names: [name] }, { authorization: await bearer("asha") });
    expect(asha.result).toEqual([name]);
  });
});

describe("downloads", () => {
  it("serves a public file, and a versioned URL with a long cache", async () => {
    const name = freshName();
    const { data } = await media.upload(name, "public", { contentType: "text/plain" });

    const current = await SELF.fetch(`${ORIGIN}${media.getPublicUrl(name)}`);
    expect(await current.text()).toBe("public");
    expect(current.headers.get("cache-control")).toBe("public, max-age=60");
    expect(current.headers.get("content-security-policy")).toContain("sandbox");
    expect(current.headers.get("x-content-type-options")).toBe("nosniff");

    const versioned = await SELF.fetch(`${ORIGIN}${media.getPublicUrl(name, { version: data!.version })}`);
    expect(await versioned.text()).toBe("public");
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves a private file only to a caller that the select rule accepts", async () => {
    const name = `atlas/${crypto.randomUUID().slice(0, 8)}.pdf`;
    await printables.upload(name, "%PDF", { contentType: "application/pdf" });
    const url = `${ORIGIN}/files/printables/${name}`;

    expect((await SELF.fetch(url)).status).toBe(404);
    expect((await SELF.fetch(url, { headers: { authorization: await bearer("asha") } })).status).toBe(404);
    const buyer = await SELF.fetch(url, { headers: { authorization: await bearer("asha", ["buyer"]) } });
    expect(buyer.status).toBe(200);
    expect(buyer.headers.get("cache-control")).toBe("private, no-store");

    const { data: version } = await printables.list(name);
    const guess = await SELF.fetch(`${url}?v=${version![0].version}`);
    expect(guess.status).toBe(404);
  });

  it("lists only the files that the select rule accepts", async () => {
    const name = `atlas/${crypto.randomUUID().slice(0, 8)}.pdf`;
    await printables.upload(name, "%PDF", { contentType: "application/pdf" });
    expect((await rpc("printables", "list", { prefix: name })).result).toEqual([]);
    const buyer = await rpc("printables", "list", { prefix: name }, { authorization: await bearer("asha", ["buyer"]) });
    expect(buyer.result).toHaveLength(1);
  });
});

describe("a list over HTTP", () => {
  it("gives 1 file at least and 1000 files at most", async () => {
    const dir = `avatars/${crypto.randomUUID().slice(0, 8)}`;
    await media.upload(`${dir}/a.txt`, "a", { contentType: "text/plain" });
    await media.upload(`${dir}/b.txt`, "b", { contentType: "text/plain" });
    expect((await rpc("media", "list", { prefix: dir })).result).toHaveLength(2);
    expect((await rpc("media", "list", { prefix: dir, limit: -1 })).result).toHaveLength(1);
    expect((await rpc("media", "list", { prefix: dir, limit: 0.5 })).result).toHaveLength(1);
    expect((await rpc("media", "list", { prefix: dir, limit: 1e9, offset: -5 })).result).toHaveLength(2);
  });
});

describe("a bucket that was public", () => {
  // The object in R2 has the mark of a public file, from the time that the
  // bucket was public. The bucket printables is private now.
  it("serves the old URL of a file only with the select rule", async () => {
    const name = `atlas/${crypto.randomUUID().slice(0, 8)}.pdf`;
    const { data } = await printables.upload(name, "%PDF", { contentType: "application/pdf" });
    await env.FILES_BUCKET.put(`printables/${name}/${data!.version}`, "%PDF", {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { public: "1" },
    });
    const url = `${ORIGIN}/files/printables/${name}?v=${data!.version}`;

    expect((await SELF.fetch(url)).status).toBe(404);
    const buyer = await SELF.fetch(url, { headers: { authorization: await bearer("asha", ["buyer"]) } });
    expect(buyer.status).toBe(200);
    expect(buyer.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("the files client over HTTP", () => {
  it("uploads and lists with the session of the page", async () => {
    const auth = await bearer("asha");
    const client = createClient("files://media", {
      origin: ORIGIN,
      fetch: (input, init) => SELF.fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: auth } }),
    });
    const name = freshName();
    const up = await client.upload(name, new Blob(["blob"], { type: "text/plain" }));
    expect(up.error).toBeNull();
    expect((await client.list(name)).data).toHaveLength(1);
    expect((await client.remove([name])).data).toEqual([name]);
    expect((await client.createSignedUrl(name, { expiresIn: 1 })).error).toMatchObject({ code: -32600 });
  });
});
