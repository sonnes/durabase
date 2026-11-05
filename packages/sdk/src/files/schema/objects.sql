-- The schema of the Files DO. The SDK owns it: `durabase db diff` writes the
-- migrations, and `durabase gen` writes files.gen.ts. Edit this file, not the
-- migrations.

-- One row for each file. R2 keeps the bytes at <bucket>/<name>/<version>.
-- Each upload writes a new version, so a reader never gets half a file, and
-- a URL with the version always gives the same bytes.
create table objects (
  -- A key of the buckets option, not an R2 bucket.
  bucket text not null,
  -- The path of the file in its bucket, such as avatars/asha.jpg. A folder
  -- is a prefix of the name.
  name text not null,
  -- The sub of the uploader. Null for a file from the service role.
  owner_id text,
  -- A random UUID for each upload.
  version text not null,
  size integer not null,
  -- The MIME type.
  type text not null,
  -- The etag from R2.
  etag text not null,
  -- JSON from the client.
  metadata text,
  created_at integer not null,
  updated_at integer not null,
  primary key (bucket, name)
);
