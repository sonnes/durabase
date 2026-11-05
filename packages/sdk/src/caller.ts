// The caller of a call. Code with a binding to the DO is the service role
// and skips the policies. A call over HTTP is anon, or authenticated after
// sign-in.

export type Auth =
  | { role: "service" }
  | { role: "anon" }
  | { role: "authenticated"; sub: string; email: string; groups: string[] };

export const SERVICE: Auth = { role: "service" };
export const ANON: Auth = { role: "anon" };
