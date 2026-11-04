declare global {
  namespace Cloudflare {
    interface Env {
      DB: DurableObjectNamespace;
      MAILBOX: DurableObjectNamespace<import("../src").MailboxDO>;
      MAILBOX_FILES: R2Bucket;
    }
  }
}
export {};
