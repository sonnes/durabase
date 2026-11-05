// The Auth Durable Object. One DO keeps the users, the open sign-in codes and
// the sessions of a realm, for all namespaces. A project exports it with one
// line:
//
//   export const Auth = auth({ from: "orders@littleplay.co" });
//
// The SDK owns the schema. The class is a Database DO with the auth
// functions and select only for the rows. Its async methods hash the tokens,
// call the functions, and send the sign-in email through the Mailbox DO.
// serve() calls these methods. The Worker signs the tokens.

import { database } from "../database";
import { DurabaseError, ErrorCode, FUNCTION_PREFIX, type RpcError, type RpcResponse } from "../protocol";
import { migrations } from "./auth.gen";
import * as functions from "./functions";
import type { Refreshed, User, Verified } from "./functions";
import { CODE_MINUTES } from "./functions";
import { codeHash, linkHash, randomCode, randomToken } from "./tokens";

export interface SignInEmail {
  email: string;
  link: string;
  code: string;
  minutes: number;
}

export interface AuthOptions {
  // The address of the Mailbox DO that sends the sign-in email.
  from: string;
  // The name in the From header. The default is no name.
  fromName?: string;
  // The origin of the link in the email, such as "https://littleplay.co".
  // The default is the origin of the request.
  site?: string;
  // The binding of the Mailbox DO. The default is "MAILBOX".
  mailbox?: string;
  // The binding of the secret. The default is "DURABASE_AUTH_SECRET".
  secret?: string;
  // The text of the sign-in email.
  email?: (m: SignInEmail) => { subject: string; text: string; html?: string };
}

export const DEFAULT_SECRET = "DURABASE_AUTH_SECRET";

function defaultEmail(m: SignInEmail): { subject: string; text: string } {
  return {
    subject: "Your sign-in link",
    text: [
      `Sign in: ${m.link}`,
      "",
      `Or type this code: ${m.code}`,
      "",
      `The link and the code stop after ${m.minutes} minutes. If you did not ask to sign in, ignore this email.`,
    ].join("\n"),
  };
}

export function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

type Stub = { rpc(body: unknown): Promise<RpcResponse | RpcResponse[] | undefined> };

export function auth(options: AuthOptions) {
  const Base = database({ migrations, functions, rows: "read", scheme: "auth" });
  const secretBinding = options.secret ?? DEFAULT_SECRET;
  const mailboxBinding = options.mailbox ?? "MAILBOX";
  const render = options.email ?? defaultEmail;

  return class Auth extends Base {
    // The realm is the name of the DO.
    get realm(): string {
      const name = this.ctx.id.name;
      if (!name) throw new Error("the Auth DO has no realm. Get its stub with idFromName(realm).");
      return name;
    }

    // Sends one email with a link and a 6-digit code. An error comes back as
    // a value, because Workers RPC drops the code of a thrown error.
    async signIn(email: string, origin: string): Promise<{ error?: RpcError }> {
      try {
        await this.#signIn(email, origin);
        return {};
      } catch (error) {
        if (error instanceof DurabaseError) return { error: error.toJSON() };
        throw error;
      }
    }

    async #signIn(email: string, origin: string): Promise<void> {
      const address = normalEmail(email);
      const token = randomToken();
      const code = randomCode();
      await this.call("start", {
        email: address,
        link_hash: await linkHash(token),
        code_hash: await codeHash(this.secret(), address, code),
      });

      const site = (options.site ?? origin).replace(/\/+$/, "");
      const link = `${site}/auth/${encodeURIComponent(this.realm)}/callback?token=${token}`;
      const message = render({ email: address, link, code, minutes: CODE_MINUTES });
      const ns = this.binding<DurableObjectNamespace>(mailboxBinding);
      const mailbox = ns.get(ns.idFromName(options.from)) as unknown as Stub;
      await unwrap(
        await mailbox.rpc({
          jsonrpc: "2.0",
          id: 1,
          method: `${FUNCTION_PREFIX}send`,
          params: { to: address, fromName: options.fromName, ...message },
        }),
      );
    }

    async verifyCode(email: string, code: string): Promise<Verified> {
      const address = normalEmail(email);
      return (await this.call("verify", { email: address, code_hash: await codeHash(this.secret(), address, code.replace(/\s/g, "")) })) as Verified;
    }

    async verifyLink(token: string): Promise<Verified> {
      return (await this.call("verify", { link_hash: await linkHash(token) })) as Verified;
    }

    async refresh(sid: string, counter: number): Promise<Refreshed> {
      return (await this.call("refresh", { sid, counter })) as Refreshed;
    }

    async signOut(sid: string): Promise<void> {
      await this.call("sign_out", { sid });
    }

    async getUser(id: string): Promise<User | null> {
      return (await this.call("get_user", { id })) as User | null;
    }

    // Only the service role calls this method. The next access token of the
    // user carries the groups.
    async setGroups(id: string, groups: string[]): Promise<void> {
      await this.call("set_groups", { id, groups });
    }

    private async call(name: string, params: unknown): Promise<unknown> {
      return unwrap(await this.rpc({ jsonrpc: "2.0", id: 1, method: `${FUNCTION_PREFIX}${name}`, params }));
    }

    private secret(): string {
      const value = (this.env as unknown as Record<string, unknown>)[secretBinding];
      if (typeof value !== "string" || value.length < 32) {
        throw new Error(`the Auth DO needs the secret ${secretBinding}, of 32 characters or more`);
      }
      return value;
    }

    private binding<T>(name: string): T {
      const value = (this.env as unknown as Record<string, unknown>)[name];
      if (!value) throw new Error(`the Auth DO has no binding ${name}`);
      return value as T;
    }
  };
}

function unwrap(res: RpcResponse | RpcResponse[] | undefined): unknown {
  const r = Array.isArray(res) ? res[0] : res;
  if (!r) throw new DurabaseError(ErrorCode.InternalError, "no response");
  if ("error" in r) throw new DurabaseError(r.error.code, r.error.message, r.error.data);
  return r.result;
}

export type AuthDO = InstanceType<ReturnType<typeof auth>>;
