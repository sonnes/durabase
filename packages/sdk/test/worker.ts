// The test Worker: the Database DO with the test schema and functions, the
// Mailbox DO, the Auth DO, and the durabase routes of serve().

import { auth, database, mailbox, serve } from "../src";
import { migrations } from "./durabase.gen";
import * as functions from "./functions";

export const Database = database({ migrations, functions });
export const Mailbox = mailbox();
export const Auth = auth({ from: "orders@shop.example", site: "https://shop.example" });

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    return (await serve(request, env)) ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
