CREATE TABLE "messages" (
  "id" text primary key,
  "folder" text not null check ("folder" in ('inbox', 'outbox', 'sent', 'failed', 'trash')),
  "thread_id" text not null,
  "send_key" text unique,
  "message_id" text,
  "in_reply_to" text,
  "refs" text,
  "from_address" text not null,
  "from_name" text,
  "to_addresses" text not null,
  "cc_addresses" text,
  "reply_to" text,
  "subject" text not null,
  "text" text,
  "html" text,
  "attachments" text,
  "raw_key" text,
  "read" integer not null default 0,
  "attempts" integer not null default 0,
  "due_at" integer,
  "error" text,
  "created_at" integer not null,
  "sent_at" integer
);

CREATE INDEX "messages_due" on "messages" ("due_at");

CREATE INDEX "messages_folder" on "messages" ("folder", "created_at");

CREATE INDEX "messages_message_id" on "messages" ("message_id");

CREATE INDEX "messages_thread" on "messages" ("thread_id", "created_at");
