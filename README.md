# durabase

The developer experience of Supabase, on Cloudflare Durable Objects.

You write SQL schema files and plain functions. durabase writes the migrations and the TypeScript types, and it owns the Durable Object. Your Worker exports the class in one line, and a client in the style of supabase-js reads and writes rows over JSON-RPC 2.0. A mailbox for each email address uses the same client.

> **Status:** 0.1, before the first release. The API can change without notice.

## What You Get

| Part | What it does |
|---|---|
| `database()` | A Durable Object with SQLite. It applies your migrations on the first call after a deploy, and answers JSON-RPC 2.0 calls for rows and functions. |
| `durabase db diff` | Compares your schema files with your migrations, and writes the next migration. |
| `durabase gen` | Writes the row types, the function types and the migrations into one TypeScript file. |
| `createClient()` | `from().select().eq()`, `insert()`, `update()`, `delete()`, `rpc()` and `batch()`, typed from your schema. |
| `fn()` | A function that runs in the Durable Object, in one SQLite transaction. |
| `mailbox()` | A Durable Object for one email address: the inbox, the outbox and sent. It sends with Cloudflare Email Service and receives with Email Routing. |

## Install

```bash
pnpm add @durabase/sdk
```

The package includes the `durabase` CLI. npm installs the binary for your platform as an optional dependency.

## Quick Start

### 1. Write the Schema

Put the desired state of your database in `durabase/schema/*.sql`. Edit these files, not the migrations.

```sql
-- durabase/schema/orders.sql
create table orders (
  id text primary key,
  state text not null check (state in ('pending', 'paid', 'shipped')),
  amount integer not null,
  created_at integer not null
);

create table order_items (
  order_id text not null references orders (id),
  product_id text not null,
  quantity integer not null,
  primary key (order_id, product_id)
);
```

### 2. Write the Migration and the Types

```bash
npx durabase db diff -f init
npx durabase gen -out src/durabase.gen.ts -functions durabase/functions
```

The first command writes `durabase/migrations/0001_init.sql`. The second command writes `src/durabase.gen.ts`, with the type of each row and the list of migrations. A `CHECK (state IN (...))` becomes a union type: `"pending" | "paid" | "shipped"`.

Run both commands again after each change to a schema file.

### 3. Write Functions

A function gets `tx`, which reads and writes rows with no `await`. If the function throws, SQLite rolls back all its writes.

```ts
// durabase/functions/index.ts
import { createFn } from "@durabase/sdk";
import type { Tables } from "../../src/durabase.gen";

const fn = createFn<Tables>();

export const pay_order = fn((tx, a: { id: string }) => {
  const changed = tx.from("orders").update({ state: "paid" }).eq("id", a.id).eq("state", "pending").run();
  if (changed === 0) throw new Error(`order ${a.id} is not pending`);
});
```

A function cannot be `async`, because it runs inside `transactionSync`.

### 4. Export the Durable Object

```ts
// src/index.ts
import { database } from "@durabase/sdk";
import { migrations } from "./durabase.gen";
import * as functions from "../durabase/functions";

export const Database = database({ migrations, functions });
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "DB", "class_name": "Database" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Database"] }]
}
```

### 5. Use the Client

```ts
import { createClient } from "@durabase/sdk";
import type { Database } from "./durabase.gen";

const db = createClient<Database>(env.DB);

const { data, error } = await db
  .from("orders")
  .select("id", "state", { order_items: ["product_id", "quantity"] })
  .eq("state", "paid")
  .order("created_at", { ascending: false })
  .limit(20);

await db.rpc("pay_order", { id: "o_1" });
```

`select()` takes one argument for each column. An object embeds the rows of a table that has a foreign key to this table, or that this table points to. A wrong column name fails to compile.

`batch()` sends several calls in one request, and the Durable Object runs them in one transaction. If one call fails, no call changes a row:

```ts
const [order, items] = await db.batch([
  db.from("orders").insert({ id: "o_2", state: "pending", amount: 900, created_at: Date.now() }),
  db.from("order_items").insert([{ order_id: "o_2", product_id: "bricks", quantity: 3 }]),
]);
```

The client accepts three targets:

| Target | Use |
|---|---|
| `createClient(env.DB, { name })` | In a Worker. The call goes over Workers RPC to the Durable Object with this name. The default name is `db`. |
| `createClient({ url: "/db" })` | In a browser. The call goes to a route that `serveDb()` serves. |
| `createClient({ fetcher })` | Through a service binding. |

## Serve the Database over HTTP

```ts
import { serveDb } from "@durabase/sdk";

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/db") return serveDb(request, env.DB);
    return new Response("not found", { status: 404 });
  },
};
```

> **CAUTION:** The route has no key and no policy. Anyone who can reach it can read, change and delete every row. Do not serve a database with private data on a public route.

## Mailbox

A `Mailbox` Durable Object keeps the mail of one email address. durabase owns its schema, so you write no SQL for it.

```ts
import { mailbox, receiveEmail } from "@durabase/sdk";

export const Mailbox = mailbox();

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    await receiveEmail(message, env.MAILBOX, { addresses: ["help@example.com"] });
  },
};
```

The Worker needs three bindings. You can change the binding names with `mailbox({ email, bucket })`.

| Binding | Type | Use |
|---|---|---|
| `MAILBOX` | Durable Object, class `Mailbox` | The mailboxes. The name of each one is its address, in lower case. |
| `EMAIL` | `send_email` | Sends the outbox. |
| `MAILBOX_FILES` | R2 bucket | Keeps the raw message and the attachments of each inbound message. |

Send, read and reply with the database client:

```ts
import { createClient, type Mailbox } from "@durabase/sdk";

const mail = createClient<Mailbox>(env.MAILBOX, { name: "orders@example.com" });

await mail.rpc("send", {
  to: "asha@example.com",
  subject: "Your order",
  text: "Thanks for your order.",
  key: "order-o_1", // a second send with this key queues nothing
});

const { data: inbox } = await mail
  .from("messages")
  .select("id", "from_address", "subject", "read")
  .eq("folder", "inbox");

await mail.rpc("reply", { id: inbox![0].id, text: "We sent it today." });
```

- `send()` and `reply()` write the message to the outbox. An alarm sends it. If a send fails, the alarm tries again after 1, 2, 4 and more minutes, at most 6 hours apart. After 12 tries, the message goes to the `failed` folder, with the error.
- `reply()` sets `In-Reply-To` and `References`, so the reply stays in the thread.
- The client can only select rows. Each change goes through `send`, `reply`, `mark_read` or `move`.
- Mail to an address that is not in `addresses` gets a permanent SMTP error.

## Protocol

Each call is a JSON-RPC 2.0 request. A batch is an array of requests, and it runs in one transaction.

| Method | Params |
|---|---|
| `select` | `table`, `columns`, `where`, `order`, `limit`, `offset` |
| `insert` | `table`, `rows`, `onConflict`, `returning` |
| `update` | `table`, `set`, `where` (required), `returning` |
| `delete` | `table`, `where` (required), `returning` |
| `fn.<name>` | The arguments of the function |

```json
{"jsonrpc":"2.0","id":1,"method":"select","params":{"table":"orders","columns":["id","state"],"where":{"state":{"eq":"paid"}}}}
```

The Durable Object accepts only the table and column names of its schema. Each value becomes a SQL binding.

| Code | Meaning |
|---|---|
| -32700 | The body is not JSON. |
| -32600 | The request is not a JSON-RPC 2.0 request. |
| -32601 | The method or the function does not exist. |
| -32602 | A param is not correct, such as an unknown column. |
| -32000 | A migration failed. Each call gets this error until a deploy corrects the migration. |
| -32001 | Another call of the batch failed, so SQLite rolled back this call. |
| -32002 | SQLite refused the statement. |
| -32003 | The function threw an error. |
| -32004 | `single()` got no row, or more than one row. |
| -32603 | An internal error. |

## Limits

- `db diff` uses [sqldef](https://github.com/sqldef/sqldef). SQLite cannot change a CHECK constraint or the type of a column with `ALTER TABLE`, and `db diff` writes no migration for these changes.
- There are no API keys and no row policies.
- A Durable Object holds one SQLite database. One name is one database.

## Development

```bash
pnpm install
pnpm build:cli   # builds cli/bin/durabase
pnpm test        # the SDK tests in workerd, and the CLI tests
pnpm typecheck
make -C cli check  # the Go lint
```

`AGENTS.md` has the rules for the Go code and the TypeScript code.

## License

[MIT](LICENSE)
