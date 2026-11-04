// Serves the Database DO at a route of the Worker:
//
//   if (url.pathname === "/db") return serveDb(request, env.DB);
//
// The route has no key and no policy. Anyone who can reach it can read,
// change and delete every row.

import { DEFAULT_NAME, type ClientOptions } from "./client";

export function serveDb(request: Request, namespace: DurableObjectNamespace, options: ClientOptions = {}): Promise<Response> {
  const id = namespace.idFromName(options.name ?? DEFAULT_NAME);
  const stub = namespace.get(id, options.locationHint ? { locationHint: options.locationHint } : undefined);
  return stub.fetch(request);
}
