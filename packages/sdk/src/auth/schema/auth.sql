-- The schema of the Auth DO. The SDK owns it: `durabase db diff` writes the
-- migrations, and `durabase gen` writes auth.gen.ts. Edit this file, not the
-- migrations.

-- One row for each person who signed in. The row comes on the first verify,
-- so an email that nobody confirmed has no row.
create table users (
  -- A random UUID. The access token carries it as sub.
  id text primary key,
  -- In lower case.
  email text not null unique,
  -- A JSON list of group names. Only the service role writes it.
  groups text not null default '[]',
  created_at integer not null,
  last_sign_in_at integer
);

-- One row for each sign-in email that is open. The email holds a link and a
-- 6-digit code. The DO keeps only their hashes.
create table codes (
  -- SHA-256 of the link token.
  link_hash text primary key,
  -- HMAC of the email and the code.
  code_hash text not null,
  email text not null,
  expires_at integer not null,
  -- The wrong codes so far. After 5, the code stops.
  tries integer not null default 0,
  created_at integer not null
);
create index codes_email on codes (email, created_at);

-- One row for each address that got a wrong code in the last 24 hours. After
-- 20 wrong codes, no code of the address signs in until the 24 hours end.
create table wrong_codes (
  email text primary key,
  -- The time of the first wrong code of the 24 hours.
  since integer not null,
  count integer not null
);

-- One row for each signed-in device. The refresh token holds the id and a
-- counter. Each refresh adds 1 to the counter.
create table sessions (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  counter integer not null default 0,
  refreshed_at integer not null,
  not_after integer not null,
  revoked_at integer,
  created_at integer not null
);
create index sessions_user on sessions (user_id);
