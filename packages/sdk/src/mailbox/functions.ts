// The functions of the Mailbox DO. A client writes only through these
// functions, so the outbox state stays correct. send() and reply() only
// queue a row. The alarm sends it (outbox.ts).

import { z } from "zod";
import { createFn, type Tx } from "../fn";
import { DurabaseError, ErrorCode } from "../protocol";
import type { Tables } from "./mailbox.gen";

const fn = createFn<Tables>();

// Email Service accepts 50 recipients at most, in to, cc and bcc together.
export const MAX_RECIPIENTS = 50;

// A References header keeps the last 20 Message-IDs of the thread.
const MAX_REFERENCES = 20;

const Address = z.union([z.string().email(), z.object({ email: z.string().email(), name: z.string().optional() })]);
export type Address = z.infer<typeof Address>;

const SendInput = z
  .object({
    to: z.union([Address, z.array(Address).min(1)]),
    cc: z.array(Address).optional(),
    replyTo: z.string().email().optional(),
    // The address of the sender is the address of the mailbox.
    fromName: z.string().optional(),
    subject: z.string().max(998),
    text: z.string().optional(),
    html: z.string().optional(),
    // A second send with the same key queues nothing.
    key: z.string().min(1).optional(),
  })
  .refine((a) => a.text !== undefined || a.html !== undefined, "a message needs text or html");
export type SendInput = z.input<typeof SendInput>;

const ReplyInput = z
  .object({
    id: z.string(),
    text: z.string().optional(),
    html: z.string().optional(),
    // Also send to the other recipients of the message.
    all: z.boolean().optional(),
    fromName: z.string().optional(),
  })
  .refine((a) => a.text !== undefined || a.html !== undefined, "a message needs text or html");
export type ReplyInput = z.input<typeof ReplyInput>;

const MarkReadInput = z.object({ id: z.string(), read: z.boolean() });
const MoveInput = z.object({ id: z.string(), folder: z.enum(["inbox", "trash"]) });

function parse<T extends z.ZodTypeAny>(schema: T, args: unknown): z.output<T> {
  const r = schema.safeParse(args);
  if (!r.success) throw new DurabaseError(ErrorCode.InvalidParams, r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

function list(a: Address | Address[]): Address[] {
  return Array.isArray(a) ? a : [a];
}

function emailOf(a: Address): string {
  return (typeof a === "string" ? a : a.email).toLowerCase();
}

function checkRecipients(to: Address[], cc: Address[]) {
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw new DurabaseError(ErrorCode.InvalidParams, `a message has ${MAX_RECIPIENTS} recipients at most`);
  }
}

type Queued = { id: string; queued: boolean };

type OutRow = Omit<Tables["messages"]["insert"], "id" | "folder" | "from_address" | "due_at" | "created_at">;

// Writes one row to the outbox. The Mailbox class sets the alarm after the
// call.
function queue(tx: Tx<Tables>, key: string | undefined, row: OutRow): Queued {
  const id = crypto.randomUUID();
  const first = tx.insertOrIgnore("messages", {
    ...row,
    id,
    thread_id: row.thread_id || id,
    send_key: key ?? null,
    folder: "outbox",
    from_address: address(tx),
    due_at: tx.now,
    created_at: tx.now,
  });
  if (first) return { id, queued: true };

  const existing = tx.from("messages").select("id").eq("send_key", key!).one();
  return { id: existing.id, queued: false };
}

function address(tx: Tx<Tables>): string {
  if (!tx.name) throw new Error("the mailbox has no address. Get its stub with idFromName(address).");
  return tx.name;
}

export const send = fn((tx, args: SendInput): Queued => {
  const a = parse(SendInput, args);
  const to = list(a.to);
  const cc = a.cc ?? [];
  checkRecipients(to, cc);

  return queue(tx, a.key, {
    thread_id: "",
    from_name: a.fromName ?? null,
    to_addresses: JSON.stringify(to),
    cc_addresses: cc.length ? JSON.stringify(cc) : null,
    reply_to: a.replyTo ?? null,
    subject: a.subject,
    text: a.text ?? null,
    html: a.html ?? null,
  });
});

// Answers a message in its thread. The reply goes to the Reply-To address of
// an inbound message, or else to its sender. The reply to a sent message goes
// to the same recipients.
export const reply = fn((tx, args: ReplyInput): Queued => {
  const a = parse(ReplyInput, args);
  const parent = tx.from("messages").select("*").eq("id", a.id).maybeOne();
  if (!parent) throw new Error(`the mailbox has no message ${a.id}`);

  const self = address(tx);
  const inbound = parent.folder === "inbox" || parent.folder === "trash";
  const parentTo = JSON.parse(parent.to_addresses) as Address[];
  const parentCc = parent.cc_addresses ? (JSON.parse(parent.cc_addresses) as Address[]) : [];

  const to: Address[] = inbound ? [parent.reply_to ?? parent.from_address] : parentTo;
  const others = a.all ? [...(inbound ? parentTo : []), ...parentCc] : [];
  const seen = new Set([self, ...to.map(emailOf)]);
  const cc = others.filter((o) => {
    const e = emailOf(o);
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  checkRecipients(to, cc);

  const refs = [...(parent.refs ?? "").split(/\s+/), parent.message_id ?? ""].filter(Boolean).slice(-MAX_REFERENCES);

  return queue(tx, undefined, {
    thread_id: parent.thread_id,
    in_reply_to: parent.message_id,
    refs: refs.length ? refs.join(" ") : null,
    from_name: a.fromName ?? null,
    to_addresses: JSON.stringify(to),
    cc_addresses: cc.length ? JSON.stringify(cc) : null,
    subject: /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`,
    text: a.text ?? null,
    html: a.html ?? null,
  });
});

export const mark_read = fn((tx, args: z.input<typeof MarkReadInput>): void => {
  const a = parse(MarkReadInput, args);
  const changed = tx.from("messages").update({ read: a.read ? 1 : 0 }).eq("id", a.id).run();
  if (changed === 0) throw new Error(`the mailbox has no message ${a.id}`);
});

// Moves an inbound message to the trash, or back to the inbox. A message in
// the outbox, in sent or in failed cannot move.
export const move = fn((tx, args: z.input<typeof MoveInput>): void => {
  const a = parse(MoveInput, args);
  const changed = tx.from("messages").update({ folder: a.folder }).eq("id", a.id).in("folder", ["inbox", "trash"]).run();
  if (changed === 0) throw new Error(`the mailbox has no inbound message ${a.id}`);
});
