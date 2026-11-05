// The functions of the Auth DO. Each one runs in one transaction and gets
// only hashes: the Auth DO hashes the link token and the code before it
// calls a function (auth.ts). All functions are private, so only code with
// a binding can call them.

import { z } from "zod";
import { createFn } from "../fn";
import { DurabaseError, ErrorCode } from "../protocol";
import type { Tables } from "./auth.gen";

const fn = createFn<Tables>();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CODE_MINUTES = 10;
export const CODES_PER_HOUR = 5;
export const TRIES_PER_CODE = 5;
export const SESSION_DAYS = 30;
// A refresh token one step old still works for this time. Two tabs can
// refresh at the same time, or a response can get lost.
export const REUSE_MS = 60_000;

export interface User {
  id: string;
  email: string;
  groups: string[];
}

export type Verified = { ok: true; user: User; sid: string; counter: number } | { ok: false; reason: "invalid" | "expired" | "tries" };
export type Refreshed = { ok: true; user: User; sid: string; counter: number } | { ok: false };

function parse<T extends z.ZodTypeAny>(schema: T, args: unknown): z.output<T> {
  const r = schema.safeParse(args);
  if (!r.success) throw new DurabaseError(ErrorCode.InvalidParams, r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

function toUser(row: { id: string; email: string; groups: string }): User {
  return { id: row.id, email: row.email, groups: JSON.parse(row.groups) as string[] };
}

const StartInput = z.object({ email: z.string().email(), link_hash: z.string(), code_hash: z.string() });

// Opens a sign-in. Refuses after 5 emails in 1 hour for one address.
export const start = fn((tx, args: z.input<typeof StartInput>) => {
  const a = parse(StartInput, args);
  tx.sql("DELETE FROM codes WHERE expires_at < ?", tx.now - HOUR);
  const [{ n }] = tx.sql<{ n: number }>("SELECT count(*) AS n FROM codes WHERE email = ? AND created_at > ?", a.email, tx.now - HOUR);
  if (n >= CODES_PER_HOUR) {
    throw new DurabaseError(ErrorCode.Forbidden, "too many sign-in emails. Try again in 1 hour.", { reason: "rate-limit" });
  }
  tx.from("codes")
    .insert({
      link_hash: a.link_hash,
      code_hash: a.code_hash,
      email: a.email,
      expires_at: tx.now + CODE_MINUTES * MINUTE,
      tries: 0,
      created_at: tx.now,
    })
    .run();
});

const VerifyInput = z.union([
  z.object({ link_hash: z.string() }),
  z.object({ email: z.string().email(), code_hash: z.string() }),
]);

// Accepts a link or a code. On success, it removes the open codes of the
// email, makes the user row if it is new, and opens a session.
export const verify = fn((tx, args: z.input<typeof VerifyInput>): Verified => {
  const a = parse(VerifyInput, args);
  let email: string;
  if ("link_hash" in a) {
    const row = tx.from("codes").select("email", "expires_at").eq("link_hash", a.link_hash).maybeOne();
    if (!row) return { ok: false, reason: "invalid" };
    if (row.expires_at <= tx.now) return { ok: false, reason: "expired" };
    email = row.email;
  } else {
    const open = tx.from("codes").select("code_hash", "tries").eq("email", a.email).gt("expires_at", tx.now).all();
    if (open.length === 0) return { ok: false, reason: "expired" };
    const live = open.filter((c) => c.tries < TRIES_PER_CODE);
    if (live.length === 0) return { ok: false, reason: "tries" };
    if (!live.some((c) => c.code_hash === a.code_hash)) {
      tx.sql("UPDATE codes SET tries = tries + 1 WHERE email = ?", a.email);
      return { ok: false, reason: "invalid" };
    }
    email = a.email;
  }

  tx.sql("DELETE FROM codes WHERE email = ?", email);
  tx.insertOrIgnore("users", { id: crypto.randomUUID(), email, groups: "[]", created_at: tx.now });
  tx.sql("UPDATE users SET last_sign_in_at = ? WHERE email = ?", tx.now, email);
  const user = tx.from("users").select("id", "email", "groups").eq("email", email).one();

  const sid = crypto.randomUUID();
  tx.from("sessions")
    .insert({ id: sid, user_id: user.id, counter: 0, refreshed_at: tx.now, not_after: tx.now + SESSION_DAYS * DAY, created_at: tx.now })
    .run();
  return { ok: true, user: toUser(user), sid, counter: 0 };
});

const RefreshInput = z.object({ sid: z.string(), counter: z.number().int().nonnegative() });

// Moves the counter of the session on by 1. The token of the last step
// still works for 1 minute, and gets the current counter.
export const refresh = fn((tx, args: z.input<typeof RefreshInput>): Refreshed => {
  const a = parse(RefreshInput, args);
  const s = tx
    .from("sessions")
    .select("user_id", "counter", "refreshed_at", "not_after", "revoked_at")
    .eq("id", a.sid)
    .maybeOne();
  if (!s || s.revoked_at !== null || s.not_after <= tx.now) return { ok: false };

  let counter: number;
  if (a.counter === s.counter) {
    counter = s.counter + 1;
    tx.from("sessions").update({ counter, refreshed_at: tx.now }).eq("id", a.sid).run();
  } else if (a.counter === s.counter - 1 && tx.now - s.refreshed_at < REUSE_MS) {
    counter = s.counter;
  } else {
    return { ok: false };
  }
  const user = tx.from("users").select("id", "email", "groups").eq("id", s.user_id).maybeOne();
  if (!user) return { ok: false };
  return { ok: true, user: toUser(user), sid: a.sid, counter };
});

export const sign_out = fn((tx, args: { sid: string }) => {
  tx.from("sessions").update({ revoked_at: tx.now }).eq("id", args.sid).run();
});

export const get_user = fn((tx, args: { id: string }): User | null => {
  const user = tx.from("users").select("id", "email", "groups").eq("id", args.id).maybeOne();
  return user ? toUser(user) : null;
});

const GroupsInput = z.object({ id: z.string(), groups: z.array(z.string().min(1)) });

// The next access token of the user carries the groups.
export const set_groups = fn((tx, args: z.input<typeof GroupsInput>) => {
  const a = parse(GroupsInput, args);
  const n = tx.from("users").update({ groups: JSON.stringify(a.groups) }).eq("id", a.id).run();
  if (n === 0) throw new DurabaseError(ErrorCode.InvalidParams, `no user: ${a.id}`);
});
