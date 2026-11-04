import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createClient, receiveEmail, type Mailbox, type MailboxDO } from "../src";

type Client = ReturnType<typeof createClient<Mailbox>>;

// Each test gets its own mailbox, so the tests do not share messages.
function freshMailbox(): { address: string; mail: Client; stub: DurableObjectStub<MailboxDO> } {
  const address = `${crypto.randomUUID().slice(0, 8)}@example.com`;
  return {
    address,
    mail: createClient<Mailbox>(env.MAILBOX, { name: address }),
    stub: env.MAILBOX.get(env.MAILBOX.idFromName(address)),
  };
}

interface Sent {
  from: { email: string; name?: string };
  to: string[];
  subject: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

// Runs the alarm with a fake EMAIL binding. fail makes each send throw.
async function runAlarm(stub: DurableObjectStub<MailboxDO>, fail?: string): Promise<Sent[]> {
  const sent: Sent[] = [];
  const send = vi.fn(async (message: Sent) => {
    if (fail) throw Object.assign(new Error(fail), { code: fail });
    sent.push(message);
    return { messageId: `<sent-${sent.length}@cloudflare.example>` };
  });
  await runInDurableObject(stub, async (instance) => {
    const o = instance as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, EMAIL: { send } };
    await instance.alarm();
  });
  return sent;
}

function alarmOf(stub: DurableObjectStub<MailboxDO>) {
  return runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
}

async function row(mail: Client, id: string) {
  const { data, error } = await mail.from("messages").select("*").eq("id", id).single();
  expect(error).toBeNull();
  return data!;
}

function rawEmail(o: { from: string; to: string; subject: string; messageId: string; inReplyTo?: string; attachment?: boolean }): string {
  const head = [
    `From: Asha <${o.from}>`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    "MIME-Version: 1.0",
  ];
  if (!o.attachment) {
    return [...head, "Content-Type: text/plain; charset=utf-8", "", "The roof piece is missing.", ""].join("\r\n");
  }
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The roof piece is missing.",
    "--b1",
    'Content-Type: image/png; name="box.png"',
    'Content-Disposition: attachment; filename="box.png"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("png bytes"),
    "--b1--",
    "",
  ].join("\r\n");
}

// A fake ForwardableEmailMessage for the email() handler.
function inbound(raw: string, to: string, from = "asha@example.com") {
  const bytes = new TextEncoder().encode(raw);
  return {
    from,
    to,
    headers: new Headers(),
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
    canBeForwarded: true,
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
}

describe("send", () => {
  it("queues the message in the outbox and sets the alarm", async () => {
    const { mail, stub } = freshMailbox();

    const { data, error } = await mail.rpc("send", { to: "asha@example.com", subject: "Paid: LP-1004", text: "Thanks" });

    expect(error).toBeNull();
    expect(data).toMatchObject({ queued: true });
    expect(await row(mail, data!.id)).toMatchObject({ folder: "outbox", subject: "Paid: LP-1004", attempts: 0 });
    expect(await alarmOf(stub)).not.toBeNull();
  });

  it("queues one message for two sends with the same key", async () => {
    const { mail } = freshMailbox();
    const input = { to: "asha@example.com", subject: "Paid: LP-1004", text: "Thanks", key: "paid:LP-1004" };

    const first = await mail.rpc("send", input);
    const second = await mail.rpc("send", input);

    expect(second.data).toEqual({ id: first.data!.id, queued: false });
    const { data } = await mail.from("messages").select("id");
    expect(data).toHaveLength(1);
  });

  it("refuses more than 50 recipients", async () => {
    const { mail } = freshMailbox();
    const to = Array.from({ length: 51 }, (_, i) => `a${i}@example.com`);
    const { error } = await mail.rpc("send", { to, subject: "Hi", text: "Hi" });
    expect(error?.code).toBe(-32602);
  });

  it("refuses a message with no text and no HTML", async () => {
    const { mail } = freshMailbox();
    const { error } = await mail.rpc("send", { to: "asha@example.com", subject: "Hi" });
    expect(error?.code).toBe(-32602);
  });
});

describe("the alarm", () => {
  it("sends each due message from the address of the mailbox, and moves it to sent", async () => {
    const { address, mail, stub } = freshMailbox();
    const { data } = await mail.rpc("send", {
      to: ["asha@example.com"],
      subject: "Paid: LP-1004",
      text: "Thanks",
      fromName: "little play co",
      replyTo: "help@example.com",
    });

    const sent = await runAlarm(stub);

    expect(sent).toEqual([
      {
        from: { email: address, name: "little play co" },
        to: ["asha@example.com"],
        replyTo: "help@example.com",
        subject: "Paid: LP-1004",
        text: "Thanks",
      },
    ]);
    expect(await row(mail, data!.id)).toMatchObject({
      folder: "sent",
      message_id: "<sent-1@cloudflare.example>",
      due_at: null,
    });
    expect(await alarmOf(stub)).toBeNull();
  });

  it("keeps a failed send in the outbox, with the error, and tries it later", async () => {
    const { mail, stub } = freshMailbox();
    const { data } = await mail.rpc("send", { to: "asha@example.com", subject: "Hi", text: "Hi" });
    const before = Date.now();

    await runAlarm(stub, "E_RATE_LIMIT_EXCEEDED");

    const r = await row(mail, data!.id);
    expect(r).toMatchObject({ folder: "outbox", attempts: 1, error: "E_RATE_LIMIT_EXCEEDED" });
    expect(r.due_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(await alarmOf(stub)).toBe(r.due_at);
  });

  it("moves a message to failed after 12 tries", async () => {
    const { mail, stub } = freshMailbox();
    const { data } = await mail.rpc("send", { to: "asha@example.com", subject: "Hi", text: "Hi" });
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE messages SET attempts = 11 WHERE id = ?", data!.id);
    });

    await runAlarm(stub, "E_RECIPIENT_SUPPRESSED");

    expect(await row(mail, data!.id)).toMatchObject({ folder: "failed", attempts: 12, due_at: null, error: "E_RECIPIENT_SUPPRESSED" });
  });

  it("sends nothing before the due time", async () => {
    const { mail, stub } = freshMailbox();
    const { data } = await mail.rpc("send", { to: "asha@example.com", subject: "Hi", text: "Hi" });
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE messages SET due_at = ? WHERE id = ?", Date.now() + 60_000, data!.id);
    });

    expect(await runAlarm(stub)).toEqual([]);
  });
});

describe("rows", () => {
  it("accepts select, and refuses a write that is not a function", async () => {
    const { mail } = freshMailbox();
    const { data } = await mail.rpc("send", { to: "asha@example.com", subject: "Hi", text: "Hi" });

    const { error } = await mail.from("messages").update({ folder: "sent" }).eq("id", data!.id);

    expect(error?.code).toBe(-32601);
    expect((await row(mail, data!.id)).folder).toBe("outbox");
  });
});

describe("receiveEmail", () => {
  it("keeps an inbound message in the inbox, and its raw message and attachments in R2", async () => {
    const { address, mail } = freshMailbox();
    const raw = rawEmail({ from: "asha@example.com", to: address, subject: "Missing roof piece", messageId: "<in-1@mail.example>", attachment: true });

    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });

    const { data } = await mail.from("messages").select("*").eq("folder", "inbox");
    expect(data).toHaveLength(1);
    const m = data![0];
    expect(m).toMatchObject({
      from_address: "asha@example.com",
      from_name: "Asha",
      subject: "Missing roof piece",
      message_id: "<in-1@mail.example>",
      read: 0,
      thread_id: m.id,
    });
    expect(m.text).toContain("The roof piece is missing.");
    expect(JSON.parse(m.to_addresses)).toEqual([address]);

    const files = JSON.parse(m.attachments!) as { filename: string; type: string; size: number; key: string }[];
    expect(files).toEqual([{ filename: "box.png", type: "image/png", size: 9, key: `${address}/${m.id}/1` }]);
    expect(await (await env.MAILBOX_FILES.get(files[0].key))!.text()).toBe("png bytes");
    expect(await (await env.MAILBOX_FILES.get(m.raw_key!))!.text()).toBe(raw);
  });

  it("rejects mail to an address with no mailbox", async () => {
    const message = inbound(rawEmail({ from: "a@example.com", to: "x@example.com", subject: "Hi", messageId: "<x@m>" }), "x@example.com");

    await receiveEmail(message, env.MAILBOX, { addresses: ["help@example.com"] });

    expect(message.setReject).toHaveBeenCalledWith("no such mailbox");
  });

  it("keeps one copy of a message that arrives two times", async () => {
    const { address, mail } = freshMailbox();
    const raw = rawEmail({ from: "asha@example.com", to: address, subject: "Hi", messageId: "<dup@mail.example>" });

    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });
    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });

    const { data } = await mail.from("messages").select("id").eq("folder", "inbox");
    expect(data).toHaveLength(1);
  });

  it("puts an answer to a sent message in the thread of that message", async () => {
    const { address, mail, stub } = freshMailbox();
    const { data: out } = await mail.rpc("send", { to: "asha@example.com", subject: "Paid: LP-1004", text: "Thanks" });
    await runAlarm(stub);

    const raw = rawEmail({ from: "asha@example.com", to: address, subject: "Re: Paid: LP-1004", messageId: "<in-2@mail.example>", inReplyTo: "<sent-1@cloudflare.example>" });
    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });

    const { data } = await mail.from("messages").select("thread_id").eq("folder", "inbox").single();
    expect(data!.thread_id).toBe(out!.id);
  });
});

describe("reply", () => {
  it("answers an inbound message in its thread", async () => {
    const { address, mail, stub } = freshMailbox();
    const raw = rawEmail({ from: "asha@example.com", to: address, subject: "Missing roof piece", messageId: "<in-3@mail.example>" });
    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });
    const { data: parent } = await mail.from("messages").select("id", "thread_id").eq("folder", "inbox").single();

    const { data, error } = await mail.rpc("reply", { id: parent!.id, text: "We sent a new roof piece today." });
    expect(error).toBeNull();
    expect(await row(mail, data!.id)).toMatchObject({
      folder: "outbox",
      subject: "Re: Missing roof piece",
      in_reply_to: "<in-3@mail.example>",
      refs: "<in-3@mail.example>",
      thread_id: parent!.thread_id,
    });

    const sent = await runAlarm(stub);
    expect(sent[0]).toMatchObject({
      to: ["asha@example.com"],
      subject: "Re: Missing roof piece",
      headers: { "In-Reply-To": "<in-3@mail.example>", References: "<in-3@mail.example>" },
    });
  });

  it("keeps one Re: in the subject", async () => {
    const { address, mail } = freshMailbox();
    const raw = rawEmail({ from: "asha@example.com", to: address, subject: "RE: Hi", messageId: "<in-4@mail.example>" });
    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });
    const { data: parent } = await mail.from("messages").select("id").eq("folder", "inbox").single();

    const { data } = await mail.rpc("reply", { id: parent!.id, text: "Hi" });

    expect((await row(mail, data!.id)).subject).toBe("RE: Hi");
  });

  it("refuses a reply to a message that the mailbox does not have", async () => {
    const { mail } = freshMailbox();
    const { error } = await mail.rpc("reply", { id: "none", text: "Hi" });
    expect(error?.code).toBe(-32003);
  });
});

describe("mark_read and move", () => {
  it("marks a message read, and moves it to trash and back", async () => {
    const { address, mail } = freshMailbox();
    const raw = rawEmail({ from: "asha@example.com", to: address, subject: "Hi", messageId: "<in-5@mail.example>" });
    await receiveEmail(inbound(raw, address), env.MAILBOX, { addresses: [address] });
    const { data: m } = await mail.from("messages").select("id").eq("folder", "inbox").single();

    await mail.rpc("mark_read", { id: m!.id, read: true });
    await mail.rpc("move", { id: m!.id, folder: "trash" });
    expect(await row(mail, m!.id)).toMatchObject({ read: 1, folder: "trash" });

    await mail.rpc("move", { id: m!.id, folder: "inbox" });
    expect((await row(mail, m!.id)).folder).toBe("inbox");
  });

  it("refuses to move a message in the outbox", async () => {
    const { mail } = freshMailbox();
    const { data } = await mail.rpc("send", { to: "asha@example.com", subject: "Hi", text: "Hi" });
    const { error } = await mail.rpc("move", { id: data!.id, folder: "trash" });
    expect(error?.code).toBe(-32003);
  });
});
