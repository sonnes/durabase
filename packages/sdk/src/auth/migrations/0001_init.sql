CREATE TABLE "codes" (
  "link_hash" text primary key,
  "code_hash" text not null,
  "email" text not null,
  "expires_at" integer not null,
  "tries" integer not null default 0,
  "created_at" integer not null
);

CREATE TABLE "users" (
  "id" text primary key,
  "email" text not null unique,
  "groups" text not null default '[]',
  "created_at" integer not null,
  "last_sign_in_at" integer
);

CREATE TABLE "sessions" (
  "id" text primary key,
  "user_id" text not null references "users" ("id") on delete cascade,
  "counter" integer not null default 0,
  "refreshed_at" integer not null,
  "not_after" integer not null,
  "revoked_at" integer,
  "created_at" integer not null
);

CREATE INDEX "codes_email" on "codes" ("email", "created_at");

CREATE INDEX "sessions_user" on "sessions" ("user_id");
