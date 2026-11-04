-- The test schema: a small shop.
create table orders (
  id text primary key,
  state text not null default 'pending' check (state in ('pending', 'paid', 'shipped')),
  amount_paise integer not null,
  customer text not null,
  created_at integer not null default 0,
  notes text
);
create index orders_created on orders (created_at);

create table order_items (
  order_id text not null references orders (id),
  product_id text not null,
  title text not null,
  quantity integer not null,
  primary key (order_id, product_id)
);

create table counters (
  name text primary key,
  value integer not null
);

create table webhook_events (
  event_id text primary key,
  received_at integer not null
);
