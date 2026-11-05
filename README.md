# durabase

[![npm](https://img.shields.io/npm/v/@durabaseio/sdk)](https://www.npmjs.com/package/@durabaseio/sdk)
[![license](https://img.shields.io/github/license/sonnes/durabase)](LICENSE)

A typed database, mailbox, auth and file store for Cloudflare Workers, built from your SQL schema. Like Supabase, but on Cloudflare.

You write SQL schema files, plain functions and policies. durabase writes the migrations and the TypeScript types, and it owns the Durable Objects. Your Worker exports each class in one line, and a client in the style of supabase-js reads and writes rows over JSON-RPC 2.0. A customer signs in with a link or a code from one email, and the policies decide which rows and files each caller can read and write.

> **Status:** 0.0.1. The API can change in each release before 1.0.

## What You Get

| Part | What it does |
|---|---|
| `database()` | A Durable Object with SQLite. It applies your migrations on the first call after a deploy, and answers JSON-RPC 2.0 calls for rows and functions. |
| `durabase db diff` | Compares your schema files with your migrations, and writes the next migration. |
| `durabase gen` | Writes the row types, the function types and the migrations into one TypeScript file. |
| `createClient()` | `from().select().eq()`, `insert()`, `update()`, `delete()`, `rpc()` and `batch()`, typed from your schema. |
| `fn()` | A function that runs in the Durable Object, in one SQLite transaction. |
| `mailbox()` | A Durable Object for one email address: the inbox, the outbox and sent. It sends with Cloudflare Email Service and receives with Email Routing. |
| `auth()` | A Durable Object that keeps the users, the sign-in codes and the sessions. |
| `files()` | A Durable Object with one row for each file. R2 keeps the bytes. |
| `serve()` | The HTTP routes of the databases, the mailboxes, sign-in and the files. |
| `policies.yaml` | The rules that decide what a caller over HTTP can read and write. |

## Install

```bash
pnpm add @durabaseio/sdk
```

The package includes the `durabase` CLI. npm installs the binary for your platform as an optional dependency.

| Package | Contents |
|---|---|
| [`@durabaseio/sdk`](https://www.npmjs.com/package/@durabaseio/sdk) | The client, `database()`, `mailbox()`, `auth()`, `files()`, `serve()`, `fn()`, and the `durabase` command |
| `@durabaseio/cli-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-x64`, `-win32-x64` | The CLI binary for one platform. Do not install these packages yourself. |

The SDK runs in Cloudflare Workers. The Durable Objects need SQLite storage: declare each class in `new_sqlite_classes`.

## Quick Start

### 1. Write the Schema

Put the desired state of your database in `durabase/schema/*.sql`. Edit these files, not the migrations.

```sql
-- durabase/schema/orders.sql
create table orders (
  id text primary key,
  state text not null check (state in ('pending', 'paid', 'shipped')),
  amount integer not null,
  customer_email text not null,
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
import { createFn } from "@durabaseio/sdk";
import type { Tables } from "../../src/durabase.gen";

const fn = createFn<Tables>();

export const pay_order = fn((tx, a: { id: string }) => {
  const changed = tx.from("orders").update({ state: "paid" }).eq("id", a.id).eq("state", "pending").run();
  if (changed === 0) throw new Error(`order ${a.id} is not pending`);
});
```

A function cannot be `async`, because it runs inside `transactionSync`.

A function made with `fn()` answers only code with a binding to the Durable Object. To let callers over HTTP call a function, make it with `fn.public()`. `tx` skips the policies, so a public function must check `tx.auth` itself:

```ts
export const my_orders = fn.public((tx) => {
  if (tx.auth.role !== "authenticated") throw new Error("sign in first");
  return tx.from("orders").select("id", "state").eq("customer_email", tx.auth.email).all();
});
```

### 4. Export the Durable Object

```ts
// src/index.ts
import { database } from "@durabaseio/sdk";
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
import { createClient } from "@durabaseio/sdk";
import type { Database } from "./durabase.gen";

const db = createClient<Database>("db://shop", env);

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
  db.from("orders").insert({ id: "o_2", state: "pending", amount: 900, customer_email: "asha@example.com", created_at: Date.now() }),
  db.from("order_items").insert([{ order_id: "o_2", product_id: "bricks", quantity: 3 }]),
]);
```

The first argument of the client is a URI. The scheme names the Durable Object, and the name after `//` is the name of the object: `db://shop` is the Database DO with the name `shop`.

| Target | Use |
|---|---|
| `createClient("db://shop", env)` | In a Worker. The call goes over Workers RPC to the binding `DB`. The caller is the service role, and the policies do not apply. |
| `createClient("db://shop")` | In a browser. The call goes to `POST /db/shop` on the site, with the session cookie. The policies apply. |
| `createClient(env.DB, { name })` | In a Worker, with a namespace. The default name is `db`. |
| `createClient({ fetcher, url })` | Through a service binding. |

The scheme `mail` uses the binding `MAILBOX`, and `files` uses `FILES` and `FILES_BUCKET`. `createClient("db://shop", env, { binding })` changes the binding.

## Serve the Routes over HTTP

`serve()` answers each durabase route, and returns `undefined` for each other path:

```ts
import { auth, files, serve } from "@durabaseio/sdk";

export const Auth = auth({ from: "orders@example.com" });

export default {
  async fetch(request: Request, env: Env) {
    return (await serve(request, env)) ?? new Response("not found", { status: 404 });
  },
};
```

| Route | URI | Does |
|---|---|---|
| `POST /db/<name>` | `db://<name>` | Row calls and functions, as JSON-RPC 2.0 |
| `POST /mail/<address>` | `mail://<address>` | The calls of a mailbox |
| `POST /auth/main` | `auth://main` | `signInWithOtp`, `verifyOtp`, `getUser` and `signOut` |
| `GET /auth/main/callback` | | The link of the sign-in email |
| `GET`, `PUT /files/<bucket>/<name>` | `files://<bucket>/<name>` | A download and an upload |
| `POST /files/<bucket>` | `files://<bucket>` | `list` and `remove` |

A call over HTTP is `anon`, or `authenticated` after sign-in. Only the policies and the public functions are open to these callers. A table with no policy gives no rows to a select, and refuses each write.

## Auth

A customer signs in with a link or a 6-digit code from one email. The Mailbox DO of the `from` address sends the email.

```ts
const db = createClient<Database>("db://shop");

await db.auth.signInWithOtp({ email: "asha@example.com" });
const { data: user, error } = await db.auth.verifyOtp({ email: "asha@example.com", code: "482913" });
await db.auth.getUser();
await db.auth.signOut();
```

The link signs in by itself and goes to `/`, or to the path in `next`. On another device, the customer types the code.

The Worker needs these bindings:

| Binding | Type | Use |
|---|---|---|
| `AUTH` | Durable Object, class `Auth` | The users, the open codes and the sessions |
| `MAILBOX` | Durable Object, class `Mailbox` | Sends the sign-in email |
| `DURABASE_AUTH_SECRET` | Secret, of 32 characters or more | Signs the tokens, the code hashes and the file links |

```bash
npx wrangler secret put DURABASE_AUTH_SECRET
```

- The Worker keeps the session in two HttpOnly cookies, `__Host-durabase-access` and `__Host-durabase-refresh`. Script on the page cannot read them.
- The access token is a JWT for 1 hour. The Worker checks it with no call to a Durable Object.
- When the access token expires, the Worker gets a new one from the Auth DO with the refresh token. A session lasts 30 days.
- A POST with the cookie must come from a page of the site. Else the call is `anon`.
- A client that is not a browser can send the access token in an `Authorization: Bearer` header.
- The Auth DO keeps only the hashes of the link and the code. A code stops after 10 minutes, or after 5 wrong tries. One address gets 5 emails in 1 hour at most.
- `env.AUTH.get(env.AUTH.idFromName("main")).setGroups(userId, ["staff"])` sets the groups of a user. The next access token carries them.

A function reads the caller from `tx.auth`:

```ts
type Auth =
  | { role: "service" } // code with a binding
  | { role: "anon" }
  | { role: "authenticated"; sub: string; email: string; groups: string[] };
```

## Policies

Write the policies in `durabase/policies.yaml`. Each key is the URI of a table, a column or a group of files. Each value gives a rule for `select`, `insert`, `update` or `delete`:

```yaml
db://shop/orders:
  select: { customer_email: { eq: $auth.email } }

db://shop/orders#customer:          # a column
  select: false

db://shop/order_items:
  select:
    orders:                         # one row of orders must match
      id: { eq: $row.order_id }
      customer_email: { eq: $auth.email }

db://*/products:                    # each namespace
  select: true

files://media/avatars/*:
  insert: { $auth.role: { eq: authenticated } }
  delete: { owner_id: { eq: $auth.sub } }
```

A rule is the `where` JSON of a query, with vars in place of values:

- An object: each condition must match. A list of objects: one object must match. `true` and `false` match each row and no row.
- The vars are `$auth.role`, `$auth.sub`, `$auth.email`, `$auth.groups`, `$ns` (the name of the Durable Object) and `$now`. A var with no value, such as `$auth.email` for `anon`, matches no row.
- `$row.<column>` names a column of the outer row, in a rule for another table.
- `has` tests a list var: `{ $auth.groups: { has: staff } }`.
- To write a text that starts with `$`, write `$$`.
- A rule for a column must be `true` or `false`. A select of `*` leaves out a closed column.

`npx durabase db diff` checks each table, column and var against the schema, and writes the `db://` rules into the next migration. A policy change reaches each Durable Object with the next deploy. `npx durabase gen` writes the `files://` rules as `filesPolicies`.

The service role skips the policies. A function also skips them.

| Call | Policy |
|---|---|
| A select | The rule filters the rows. With no rule, the result is empty. |
| An insert | Each new row must match the rule. |
| An update | The rule picks the rows. Each changed row must still match the rule. |
| A delete | The rule picks the rows. |

If a write does not match its rule, the call fails with `-32005`, and SQLite rolls back the call or the batch.

## Files

One `Files` Durable Object keeps a row for each file of all buckets. One R2 bucket keeps the bytes, at the key `<bucket>/<name>/<version>`. Each upload writes a new version.

```ts
import { files } from "@durabaseio/sdk";
import { filesPolicies } from "./durabase.gen";

export const Files = files({
  buckets: {
    media: { public: true, maxSize: 5_000_000, types: ["image/*"] },
    printables: { maxSize: 50_000_000, types: ["application/pdf"] },
  },
  policies: filesPolicies,
});
```

| Binding | Type | Use |
|---|---|---|
| `FILES` | Durable Object, class `Files` | The `objects` table |
| `FILES_BUCKET` | R2 bucket | The bytes |

```ts
const media = createClient("files://media"); // in the browser

await media.upload("avatars/asha.jpg", file);                    // the insert rule
await media.upload("avatars/asha.jpg", file, { upsert: true });  // the update rule
const { data } = await media.list("avatars/");                   // the select rule
await media.remove(["avatars/asha.jpg"]);                        // the delete rule
media.getPublicUrl("products/1.jpg");                            // /files/media/products/1.jpg

// In the Worker, as the service role:
const printables = createClient("files://printables", env);
const { data: link } = await printables.createSignedUrl("atlas/india.pdf", { expiresIn: 7 * 24 * 3600 });
```

- A download from a public bucket needs no policy. A URL with the version needs no call to the Durable Object, and a cache can keep it for 1 year.
- A signed link needs no call to the Durable Object. A new upload or a remove of the file stops the link.
- A download of a private file needs the `select` rule.
- Each download has the headers `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so an uploaded HTML file cannot run script on the site.
- An upload to a name that exists fails, unless `upsert` is true. The bucket refuses a file over `maxSize`, or of a type that is not in `types`.

## Mailbox

A `Mailbox` Durable Object keeps the mail of one email address. durabase owns its schema, so you write no SQL for it.

```ts
import { mailbox, receiveEmail } from "@durabaseio/sdk";

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
import { createClient, type Mailbox } from "@durabaseio/sdk";

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
| -32005 | A policy refused the call. |
| -32603 | An internal error. |

## Limits

- `db diff` uses [sqldef](https://github.com/sqldef/sqldef). SQLite cannot change a CHECK constraint or the type of a column with `ALTER TABLE`, and `db diff` writes no migration for these changes.
- There are no API keys. Code with a binding is the service role.
- An email scanner that opens the sign-in link uses up the link and the code of that email. The customer must then ask for a new email.
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
