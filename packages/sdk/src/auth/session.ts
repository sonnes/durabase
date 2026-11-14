// The session of a request, in the Worker. The browser sends it in two
// HttpOnly cookies. Other clients can send the access token in an
// Authorization: Bearer header.
//
// The Worker checks the access token with WebCrypto and no DO call. Only an
// expired access token goes to the Auth DO, with the refresh token.

import { ANON, type Auth } from "../caller";
import type { AuthDO } from "./auth";
import { CODE_MINUTES, type User } from "./functions";
import { ACCESS_SECONDS, REFRESH_SECONDS, signAccess, signRefresh, verifyAccess, verifyRefresh } from "./tokens";

export const ACCESS_COOKIE = "__Host-durabase-access";
export const REFRESH_COOKIE = "__Host-durabase-refresh";

// The nonce of a sign-in. It stops login CSRF through the link of the email:
// an attacker asks for a link to the account of the attacker, and makes the
// browser of another person open it. That person then works in the account of
// the attacker.
//
// signInWithOtp gives the browser a random nonce in this cookie. The Auth DO
// keeps the hash of the link token and the nonce together (linkHash), so the
// callback accepts a link only with the cookie of the browser that asked for
// it. Script cannot read the cookie, and the __Host- prefix stops a write
// from a subdomain. The 6-digit code has no nonce: a person types it into the
// page that asked for it, also on another device.
export const SIGNIN_COOKIE = "__Host-durabase-signin";
const NONCE = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  auth: Auth;
  // The session id, after sign-in.
  sid?: string;
  // The Set-Cookie headers for the response.
  cookies: string[];
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function signInCookie(nonce: string): string {
  return cookie(SIGNIN_COOKIE, nonce, CODE_MINUTES * 60);
}

export function clearSignInCookie(): string {
  return cookie(SIGNIN_COOKIE, "", 0);
}

// The nonce of the browser, or undefined if the browser has none.
export function readNonce(request: Request): string | undefined {
  const nonce = readCookies(request).get(SIGNIN_COOKIE);
  return nonce !== undefined && NONCE.test(nonce) ? nonce : undefined;
}

export function clearCookies(): string[] {
  return [cookie(ACCESS_COOKIE, "", 0), cookie(REFRESH_COOKIE, "", 0)];
}

export async function sessionCookies(secret: string, user: User, sid: string, counter: number): Promise<string[]> {
  return [
    cookie(ACCESS_COOKIE, await signAccess(secret, user, sid), ACCESS_SECONDS),
    cookie(REFRESH_COOKIE, await signRefresh(secret, sid, counter), REFRESH_SECONDS),
  ];
}

export function readCookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

// A browser request to /auth must come from a page of the site. Else another
// site could sign the user in to its own account (login CSRF). A request with
// no Origin is not from a browser.
export function sameOrigin(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

export async function authenticate(request: Request, secret: string | undefined, authDO: () => DurableObjectStub<AuthDO>): Promise<Session> {
  if (!secret) return { auth: ANON, cookies: [] };

  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const caller = await verifyAccess(secret, header.slice(7).trim());
    if (!caller) return { auth: ANON, cookies: [] };
    const { sid, ...auth } = caller;
    return { auth, sid, cookies: [] };
  }

  const jar = readCookies(request);
  const access = jar.get(ACCESS_COOKIE);
  const refresh = jar.get(REFRESH_COOKIE);
  if (!access && !refresh) return { auth: ANON, cookies: [] };
  // A browser sends Origin with each POST. A POST with a cookie and another
  // Origin, or no Origin, is not from a page of the site. It goes on as anon.
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (!isRead && request.headers.get("origin") !== new URL(request.url).origin) return { auth: ANON, cookies: [] };

  if (access) {
    const caller = await verifyAccess(secret, access);
    if (caller) {
      const { sid, ...auth } = caller;
      return { auth, sid, cookies: [] };
    }
  }
  if (!refresh) return { auth: ANON, cookies: clearCookies() };

  const token = await verifyRefresh(secret, refresh);
  if (!token) return { auth: ANON, cookies: clearCookies() };
  const r = await authDO().refresh(token.sid, token.counter);
  if (!r.ok) return { auth: ANON, cookies: clearCookies() };
  return {
    auth: { role: "authenticated", sub: r.user.id, email: r.user.email, groups: r.user.groups },
    sid: r.sid,
    cookies: await sessionCookies(secret, r.user, r.sid, r.counter),
  };
}
