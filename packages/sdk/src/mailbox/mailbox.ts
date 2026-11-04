// The Mailbox Durable Object. One DO holds the mail of one address: the
// inbox, the outbox and sent. A project exports it with one line:
//
//   export const Mailbox = mailbox();
//
// The SDK owns the schema. The class is a Database DO with the mailbox
// functions, select only for the rows, an alarm that sends the outbox, and
// receive() for inbound mail.

import { database } from "../database";
import * as functions from "./functions";
import { migrations } from "./mailbox.gen";
import { scheduleAlarm, sendDue } from "./outbox";
import { receive, type Envelope } from "./receive";

export interface MailboxOptions {
  // The name of the send_email binding. The default is "EMAIL".
  email?: string;
  // The name of the R2 binding for the raw messages and the attachments.
  // The default is "MAILBOX_FILES".
  bucket?: string;
}

export function mailbox(options: MailboxOptions = {}) {
  const emailBinding = options.email ?? "EMAIL";
  const bucketBinding = options.bucket ?? "MAILBOX_FILES";
  const Base = database({ migrations, functions, rows: "read" });

  return class Mailbox extends Base {
    // The DO name is the address. createClient() and receiveEmail() get the
    // DO with idFromName(address).
    get address(): string {
      const name = this.ctx.id.name;
      if (!name) throw new Error("the mailbox has no address. Get its stub with idFromName(address).");
      return name;
    }

    // send() and reply() only write a row. The alarm sends it.
    override async rpc(body: unknown) {
      const out = await super.rpc(body);
      await scheduleAlarm(this.ctx.storage);
      return out;
    }

    async receive(raw: ReadableStream, envelope: Envelope): Promise<void> {
      await receive(this.ctx.storage, this.binding<R2Bucket>(bucketBinding), this.address, raw, envelope);
    }

    // With no send_email binding, the outbox waits. The next send() sets
    // the alarm again.
    async alarm(): Promise<void> {
      const email = (this.env as unknown as Record<string, unknown>)[emailBinding] as SendEmail | undefined;
      if (!email) {
        console.error(`the Mailbox DO has no binding ${emailBinding}. The outbox waits.`);
        return;
      }
      await sendDue(this.ctx.storage, email, this.address);
    }

    private binding<T>(name: string): T {
      const value = (this.env as unknown as Record<string, unknown>)[name];
      if (!value) throw new Error(`the Mailbox DO has no binding ${name}`);
      return value as T;
    }
  };
}

export type MailboxDO = InstanceType<ReturnType<typeof mailbox>>;
