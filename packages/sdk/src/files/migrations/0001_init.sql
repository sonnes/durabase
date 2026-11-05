CREATE TABLE "objects" (
  "bucket" text not null,
  "name" text not null,
  "owner_id" text,
  "version" text not null,
  "size" integer not null,
  "type" text not null,
  "etag" text not null,
  "metadata" text,
  "created_at" integer not null,
  "updated_at" integer not null,
  primary key ("bucket", "name")
);
