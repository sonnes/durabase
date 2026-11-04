-- The schema of the Mailbox DO. The SDK owns it: `durabase db diff` writes
-- the migrations, and `durabase gen` writes mailbox.gen.ts. Edit this file,
-- not the migrations.

-- One row for each message, in or out. The folder is the state of the
-- message. An outbound message goes from outbox to sent, or to failed.
create table messages (
  id text primary key,
  folder text not null check (folder in ('inbox', 'outbox', 'sent', 'failed', 'trash')),
  -- The id of the first message of the thread.
  thread_id text not null,
  -- The key of a send. A second send with the same key queues nothing.
  send_key text unique,
  -- The Message-ID header, with the angle brackets.
  message_id text,
  in_reply_to text,
  -- The References header: the Message-IDs of the thread, with spaces.
  refs text,
  from_address text not null,
  from_name text,
  -- JSON arrays of addresses.
  to_addresses text not null,
  cc_addresses text,
  reply_to text,
  subject text not null,
  text text,
  html text,
  -- JSON: [{ filename, type, size, key }]. key is the R2 key of the bytes.
  attachments text,
  -- The R2 key of the raw MIME message of an inbound message.
  raw_key text,
  read integer not null default 0,
  attempts integer not null default 0,
  -- The time of the next try of a message in the outbox.
  due_at integer,
  -- The last error of a send.
  error text,
  -- The time that the mailbox received or queued the message.
  created_at integer not null,
  sent_at integer
);
create index messages_folder on messages (folder, created_at);
create index messages_thread on messages (thread_id, created_at);
create index messages_message_id on messages (message_id);
create index messages_due on messages (due_at);
