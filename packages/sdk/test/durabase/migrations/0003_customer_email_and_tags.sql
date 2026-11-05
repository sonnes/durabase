ALTER TABLE "orders" ADD COLUMN "customer_email" text;

CREATE TABLE "tags" (
  "name" text primary key,
  "owner" text not null
) without rowid;
