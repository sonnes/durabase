// The test Worker: the Database DO with the test schema and functions, and a
// public /db route.

import { database, serveDb } from "../src";
import { migrations } from "./durabase.gen";
import * as functions from "./functions";

export const Database = database({ migrations, functions });

export default {
  async fetch(request: Request, env: { DB: DurableObjectNamespace }) {
    const url = new URL(request.url);
    if (url.pathname === "/db") return serveDb(request, env.DB);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<{ DB: DurableObjectNamespace }>;
