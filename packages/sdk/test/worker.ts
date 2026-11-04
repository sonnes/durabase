// The test Worker: the Database DO with the test schema and functions, a
// public /db route, and the Mailbox DO.

import { database, mailbox, serveDb } from "../src";
import { migrations } from "./durabase.gen";
import * as functions from "./functions";

export const Database = database({ migrations, functions });
export const Mailbox = mailbox();

export default {
  async fetch(request: Request, env: { DB: DurableObjectNamespace }) {
    const url = new URL(request.url);
    if (url.pathname === "/db") return serveDb(request, env.DB);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<{ DB: DurableObjectNamespace }>;
