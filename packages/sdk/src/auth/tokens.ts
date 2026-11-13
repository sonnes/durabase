// The signed values of auth, made with WebCrypto from the Worker secret
// DURABASE_AUTH_SECRET. Each value has its own prefix, so a signature of one
// kind is never valid as another kind.
//
//   access token   an HS256 JWT, for 1 hour
//   refresh token  r1.<session id>.<counter>.<signature>, as in Supabase
//   code hash      HMAC of the email and the 6-digit code
//   link hash      SHA-256 of the random link token

import type { Auth } from "../caller";

export const ACCESS_SECONDS = 60 * 60;
export const REFRESH_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(secret: string, data: string): Promise<string> {
  return base64url(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(data)));
}

async function verify(secret: string, data: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await key(secret), fromBase64url(signature), encoder.encode(data));
  } catch {
    return false;
  }
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// A 6-digit code, with no bias.
export function randomCode(): string {
  const max = 4_294_000_000; // 4294 × 10^6, below 2^32
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < max) return String(n % 1_000_000).padStart(6, "0");
  }
}

export async function linkHash(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(`link.${token}`)));
}

export async function codeHash(secret: string, email: string, code: string): Promise<string> {
  return sign(secret, `code.${email}.${code}`);
}

export interface AccessClaims {
  sub: string;
  email: string;
  role: "authenticated";
  groups: string[];
  sid: string;
  iat: number;
  exp: number;
}

const JWT_HEADER = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

export async function signAccess(
  secret: string,
  user: { id: string; email: string; groups: string[] },
  sid: string,
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const claims: AccessClaims = {
    sub: user.id,
    email: user.email,
    role: "authenticated",
    groups: user.groups,
    sid,
    iat,
    exp: iat + ACCESS_SECONDS,
  };
  const body = `${JWT_HEADER}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  // A standard HS256 JWT. Each other HMAC input of this file starts with a
  // word and a dot, so no other value can pass as a JWT.
  return `${body}.${await sign(secret, body)}`;
}

// The caller of an access token, or undefined if the token is not valid.
export async function verifyAccess(secret: string, token: string, now = Date.now()): Promise<(Auth & { role: "authenticated"; sid: string }) | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== JWT_HEADER) return undefined;
  if (!(await verify(secret, `${parts[0]}.${parts[1]}`, parts[2]))) return undefined;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]))) as AccessClaims;
  } catch {
    return undefined;
  }
  if (claims.role !== "authenticated" || typeof claims.exp !== "number" || claims.exp * 1000 <= now) return undefined;
  return { role: "authenticated", sub: claims.sub, email: claims.email, groups: claims.groups ?? [], sid: claims.sid };
}

export async function signRefresh(secret: string, sid: string, counter: number): Promise<string> {
  const body = `r1.${sid}.${counter}`;
  return `${body}.${await sign(secret, `refresh.${body}`)}`;
}

export async function verifyRefresh(secret: string, token: string): Promise<{ sid: string; counter: number } | undefined> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "r1") return undefined;
  const counter = Number(parts[2]);
  if (!Number.isSafeInteger(counter) || counter < 0) return undefined;
  if (!(await verify(secret, `refresh.${parts[0]}.${parts[1]}.${parts[2]}`, parts[3]))) return undefined;
  return { sid: parts[1], counter };
}

// The signature of a link to a private file.
export async function signFile(secret: string, path: string, exp: number): Promise<string> {
  return sign(secret, `file.${path}.${exp}`);
}

export async function verifyFile(secret: string, path: string, exp: number, signature: string, now = Date.now()): Promise<boolean> {
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return false;
  return verify(secret, `file.${path}.${exp}`, signature);
}

// The signature of a value that an app puts in a link, such as the email of a
// confirm link. The app gives each kind of value its own prefix, such as
// "confirm:".
export async function signValue(secret: string, value: string): Promise<string> {
  return sign(secret, `value.${value}`);
}

export async function verifyValue(secret: string, value: string, signature: string): Promise<boolean> {
  return verify(secret, `value.${value}`, signature);
}
