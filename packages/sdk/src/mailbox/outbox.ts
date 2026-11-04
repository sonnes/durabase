// The outbox of the Mailbox DO. send() and reply() write a row with the
// folder "outbox". The alarm sends each due row through Email Service, and
// moves it to "sent". The code comes from the Shop DO of Little Play Co.

import type { Tables } from "./mailbox.gen";

type Row = Tables["messages"]["row"];

// The alarm tries a failed send again after 1, 2, 4 ... minutes, at most 6
// hours apart. After 12 tries, approximately one day, the row goes to
// "failed".
export const MAX_ATTEMPTS = 12;
const MAX_WAIT_MINUTES = 360;

export function retryDelay(attempts: number): number {
  return Math.min(2 ** attempts, MAX_WAIT_MINUTES) * 60_000;
}

// The alarm sends 10 rows at most. Then it sets the alarm again.
const BATCH = 10;

// Sets the alarm to the first due row in the outbox, or removes the alarm.
export async function scheduleAlarm(storage: DurableObjectStorage): Promise<void> {
  const row = storage.sql
    .exec<{ next: number | null }>("SELECT MIN(due_at) AS next FROM messages WHERE folder = 'outbox'")
    .one();
  if (row.next === null) {
    await storage.deleteAlarm();
    return;
  }
  await storage.setAlarm(row.next);
}

// Sends each due row. A row moves to "sent" only after Email Service accepts
// it, so an alarm that stops in the middle can send a message two times, but
// never zero times.
export async function sendDue(storage: DurableObjectStorage, email: SendEmail, address: string): Promise<void> {
  const due = storage.sql
    .exec<Row>("SELECT * FROM messages WHERE folder = 'outbox' AND due_at <= ? ORDER BY due_at, created_at, rowid LIMIT ?", Date.now(), BATCH)
    .toArray();

  for (const row of due) {
    await sendOne(storage.sql, email, address, row);
  }
  await scheduleAlarm(storage);
}

async function sendOne(sql: SqlStorage, email: SendEmail, address: string, row: Row): Promise<void> {
  try {
    const result = await email.send(message(address, row));
    sql.exec(
      "UPDATE messages SET folder = 'sent', message_id = ?, sent_at = ?, due_at = NULL, error = NULL WHERE id = ?",
      angle(result.messageId),
      Date.now(),
      row.id,
    );
  } catch (error) {
    const attempts = row.attempts + 1;
    const reason = errorText(error);
    console.error(`The send of message ${row.id} failed, try ${attempts}:`, reason);

    if (attempts >= MAX_ATTEMPTS) {
      sql.exec("UPDATE messages SET folder = 'failed', attempts = ?, due_at = NULL, error = ? WHERE id = ?", attempts, reason, row.id);
      return;
    }
    sql.exec(
      "UPDATE messages SET attempts = ?, due_at = ?, error = ? WHERE id = ?",
      attempts,
      Date.now() + retryDelay(row.attempts),
      reason,
      row.id,
    );
  }
}

type Message = Parameters<SendEmail["send"]>[0];

function message(address: string, row: Row): Message {
  const m: Record<string, unknown> = {
    from: row.from_name ? { email: address, name: row.from_name } : { email: address },
    to: JSON.parse(row.to_addresses),
    subject: row.subject,
  };
  if (row.cc_addresses) m.cc = JSON.parse(row.cc_addresses);
  if (row.reply_to) m.replyTo = row.reply_to;
  if (row.text !== null) m.text = row.text;
  if (row.html !== null) m.html = row.html;
  if (row.in_reply_to) m.headers = { "In-Reply-To": row.in_reply_to, References: row.refs ?? row.in_reply_to };
  return m as unknown as Message;
}

// Email Service gives an error with a code, such as E_RATE_LIMIT_EXCEEDED.
function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}

// A Message-ID in the angle brackets of the header.
export function angle(id: string | undefined | null): string | null {
  if (!id) return null;
  const t = id.trim();
  return t.startsWith("<") ? t : `<${t}>`;
}
