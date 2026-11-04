// Inbound mail. Email Routing calls the email() handler of the Worker, and
// receiveEmail() gives the message to the Mailbox DO of its address. The DO
// keeps the raw message and each attachment in R2, and the parsed message in
// SQLite.

import PostalMime, { type Address as ParsedAddress, type Email } from "postal-mime";
import type { MailboxDO } from "./mailbox";
import { angle } from "./outbox";

export interface Envelope {
  // The address of the SMTP MAIL FROM.
  from: string;
  // The address of the mailbox, in lower case.
  to: string;
  // The size of the raw message, in bytes.
  size: number;
}

export interface ReceiveOptions {
  // The addresses that have a mailbox. Mail to another address gets a
  // permanent SMTP error.
  addresses: string[];
  locationHint?: DurableObjectLocationHint;
}

export async function receiveEmail(
  message: ForwardableEmailMessage,
  namespace: DurableObjectNamespace<MailboxDO>,
  options: ReceiveOptions,
): Promise<void> {
  const to = message.to.toLowerCase();
  if (!options.addresses.some((a) => a.toLowerCase() === to)) {
    message.setReject("no such mailbox");
    return;
  }
  const id = namespace.idFromName(to);
  const stub = namespace.get(id, options.locationHint ? { locationHint: options.locationHint } : undefined);
  await stub.receive(message.raw, { from: message.from, to, size: message.rawSize });
}

// A SQLite value in a DO holds 2 MB at most. A longer text or HTML body stays
// only in the raw message in R2.
const MAX_BODY = 1_000_000;

export interface Attachment {
  filename: string;
  type: string;
  size: number;
  // The R2 key of the bytes.
  key: string;
}

// Keeps one inbound message. The raw message goes to R2 at
// "<address>/<id>/message.eml", and attachment n at "<address>/<id>/<n>".
export async function receive(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  address: string,
  raw: ReadableStream,
  envelope: Envelope,
): Promise<void> {
  const bytes = new Uint8Array(await new Response(raw).arrayBuffer());
  const email = await PostalMime.parse(bytes);
  const messageId = angle(email.messageId);
  if (messageId && known(storage.sql, messageId)) return;

  const id = crypto.randomUUID();
  const prefix = `${address}/${id}`;
  const rawKey = `${prefix}/message.eml`;
  await bucket.put(rawKey, bytes, { httpMetadata: { contentType: "message/rfc822" } });

  const attachments: Attachment[] = [];
  for (const [i, a] of email.attachments.entries()) {
    const key = `${prefix}/${i + 1}`;
    const filename = a.filename ?? `attachment-${i + 1}`;
    const content = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
    await bucket.put(key, content, { httpMetadata: { contentType: a.mimeType }, customMetadata: { filename } });
    attachments.push({ filename, type: a.mimeType, size: content.byteLength, key });
  }

  const inReplyTo = angle(email.inReplyTo);
  const refs = email.references?.trim() || null;
  const now = Date.now();

  storage.transactionSync(() => {
    // A second delivery of the message can arrive while the R2 writes run.
    if (messageId && known(storage.sql, messageId)) return;
    storage.sql.exec(
      `INSERT INTO messages (id, folder, thread_id, message_id, in_reply_to, refs, from_address, from_name,
         to_addresses, cc_addresses, reply_to, subject, text, html, attachments, raw_key, created_at)
       VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      threadOf(storage.sql, [inReplyTo, ...(refs ?? "").split(/\s+/).reverse()]) ?? id,
      messageId,
      inReplyTo,
      refs,
      email.from?.address?.toLowerCase() ?? envelope.from.toLowerCase(),
      email.from?.name || null,
      JSON.stringify(addresses(email.to, [envelope.to])),
      email.cc?.length ? JSON.stringify(addresses(email.cc, [])) : null,
      email.replyTo?.length ? (addresses(email.replyTo, [])[0] ?? null) : null,
      email.subject ?? "",
      clip(email.text),
      clip(email.html),
      attachments.length ? JSON.stringify(attachments) : null,
      rawKey,
      now,
    );
  });
}

function known(sql: SqlStorage, messageId: string): boolean {
  return sql.exec("SELECT 1 FROM messages WHERE message_id = ? AND folder IN ('inbox', 'trash') LIMIT 1", messageId).toArray().length > 0;
}

// The thread of the first Message-ID that the mailbox has.
function threadOf(sql: SqlStorage, ids: (string | null)[]): string | null {
  for (const id of ids) {
    const m = angle(id);
    if (!m) continue;
    const row = sql.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1", m).toArray()[0];
    if (row) return row.thread_id;
  }
  return null;
}

function addresses(list: ParsedAddress[] | undefined, fallback: string[]): string[] {
  const out: string[] = [];
  for (const a of list ?? []) {
    if (a.address) out.push(a.address.toLowerCase());
    for (const g of a.group ?? []) if (g.address) out.push(g.address.toLowerCase());
  }
  return out.length ? out : fallback;
}

function clip(body: Email["text"]): string | null {
  if (body === undefined || body.length > MAX_BODY) return null;
  return body;
}
