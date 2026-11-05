// The test Worker: the Database DO with the test schema and functions, the
// Mailbox DO, the Auth DO, the Files DO, and the durabase routes of serve().

import { auth, database, files, mailbox, serve } from "../src";
import { migrations, policies } from "./durabase.gen";
import * as functions from "./functions";

export const Database = database({ migrations, functions, policies });
export const Mailbox = mailbox();
export const Auth = auth({ from: "orders@shop.example", site: "https://shop.example" });
export const Files = files({
  buckets: {
    media: { public: true, maxSize: 1000, types: ["image/*", "text/plain"] },
    printables: { maxSize: 10_000, types: ["application/pdf"] },
  },
  policies,
});

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    return (await serve(request, env)) ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
