ALTER TABLE "orders" ADD COLUMN "customer_email" text;

INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://*/counters', 'select', '[{"$auth.groups":{"has":"staff"}},{"name":{"eq":"public"}}]');

INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://*/order_items', 'select', '{"orders":{"customer_email":{"eq":"$auth.email"},"id":{"eq":"$row.order_id"}}}');

INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://*/orders', 'insert', '{"customer_email":{"eq":"$auth.email"}}');

INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://*/orders', 'select', '{"customer_email":{"eq":"$auth.email"}}');

INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://*/orders', 'update', '{"customer_email":{"eq":"$auth.email"}}');

INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://*/orders#customer', 'select', 'false');
