package policies

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/sonnes/durabase/cli/internal/schema"
	"github.com/sonnes/durabase/cli/internal/sqltext"
)

const shopSQL = `
create table orders (
  id text primary key,
  state text not null,
  customer text not null,
  customer_email text not null
);
create table order_items (
  order_id text not null references orders (id),
  product_id text not null,
  title text not null,
  primary key (order_id, product_id)
);
create table products (
  id text primary key,
  title text not null
);`

func open(t *testing.T, script string) *sql.DB {
	t.Helper()
	ctx := context.Background()

	db, err := schema.Open(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { assert.NoError(t, db.Close()) })

	require.NoError(t, schema.Exec(ctx, db, sqltext.Split(script)))
	return db
}

func snapshot(t *testing.T) *schema.Snapshot {
	t.Helper()
	snap, err := schema.Read(context.Background(), open(t, shopSQL))
	require.NoError(t, err)
	return snap
}

func TestParse(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want []Policy
	}{
		{
			name: "a rule with a var",
			yaml: "db://shop/orders:\n  select: { customer_email: { eq: $auth.email } }\n",
			want: []Policy{
				{
					URI:    "db://shop/orders",
					Action: "select",
					Rule:   `{"customer_email":{"eq":"$auth.email"}}`,
				},
			},
		},
		{
			name: "a column and true",
			yaml: "db://shop/orders#customer:\n  select: false\ndb://shop/products:\n  select: true\n",
			want: []Policy{
				{
					URI:    "db://shop/orders#customer",
					Action: "select",
					Rule:   "false",
				},
				{
					URI:    "db://shop/products",
					Action: "select",
					Rule:   "true",
				},
			},
		},
		{
			name: "a table key with $row",
			yaml: "db://shop/order_items:\n  select:\n    orders:\n      id: { eq: $row.order_id }\n      customer_email: { eq: $auth.email }\n",
			want: []Policy{
				{
					URI:    "db://shop/order_items",
					Action: "select",
					Rule:   `{"orders":{"customer_email":{"eq":"$auth.email"},"id":{"eq":"$row.order_id"}}}`,
				},
			},
		},
		{
			name: "a list, a var key and any namespace",
			yaml: "db://*/orders:\n  update:\n    - { customer_email: { eq: $auth.email } }\n    - { $auth.groups: { has: staff } }\n",
			want: []Policy{
				{
					URI:    "db://*/orders",
					Action: "update",
					Rule:   `[{"customer_email":{"eq":"$auth.email"}},{"$auth.groups":{"has":"staff"}}]`,
				},
			},
		},
		{
			name: "no file content",
			yaml: "",
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse("policies.yaml", []byte(tt.yaml), snapshot(t))
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestParseErrors(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want string
	}{
		{
			name: "an unknown column",
			yaml: "db://shop/orders:\n  select: { customer_mail: { eq: $auth.email } }\n",
			want: "policies.yaml:2: db://shop/orders select: orders has no column customer_mail",
		},
		{
			name: "an unknown table",
			yaml: "db://shop/order:\n  select: true\n",
			want: "policies.yaml:1: db://shop/order: no table order",
		},
		{
			name: "an unknown column in the key",
			yaml: "db://shop/orders#phone:\n  select: false\n",
			want: "policies.yaml:1: db://shop/orders#phone: orders has no column phone",
		},
		{
			name: "an unknown action",
			yaml: "db://shop/orders:\n  read: true\n",
			want: "policies.yaml:2: db://shop/orders read: the action must be select, insert, update or delete",
		},
		{
			name: "an unknown operator",
			yaml: "db://shop/orders:\n  select: { state: { equals: paid } }\n",
			want: "policies.yaml:2: db://shop/orders select: unknown operator equals",
		},
		{
			name: "an unknown var",
			yaml: "db://shop/orders:\n  select: { customer_email: { eq: $auth.mail } }\n",
			want: "policies.yaml:2: db://shop/orders select: unknown var $auth.mail",
		},
		{
			name: "$row outside a table key",
			yaml: "db://shop/orders:\n  select: { id: { eq: $row.id } }\n",
			want: "policies.yaml:2: db://shop/orders select: $row is only for a table key",
		},
		{
			name: "$row with a column of no table",
			yaml: "db://shop/order_items:\n  select: { orders: { id: { eq: $row.order } } }\n",
			want: "policies.yaml:2: db://shop/order_items select: order_items has no column order",
		},
		{
			name: "has on a column",
			yaml: "db://shop/orders:\n  select: { state: { has: paid } }\n",
			want: "policies.yaml:2: db://shop/orders select: has is only for a list var, such as $auth.groups",
		},
		{
			name: "a column rule that is not true or false",
			yaml: "db://shop/orders#customer:\n  select: { state: { eq: paid } }\n",
			want: "policies.yaml:2: db://shop/orders#customer select: the rule of a column must be true or false",
		},
		{
			name: "an unknown scheme",
			yaml: "ftp://shop/orders:\n  select: true\n",
			want: "policies.yaml:1: ftp://shop/orders: the key must be a db:// URI of a table, such as db://shop/orders",
		},
		{
			name: "no table",
			yaml: "db://shop:\n  select: true\n",
			want: "policies.yaml:1: db://shop: the key must be a db:// URI of a table, such as db://shop/orders",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse("policies.yaml", []byte(tt.yaml), snapshot(t))
			require.Error(t, err)
			assert.Equal(t, tt.want, err.Error())
		})
	}
}

func TestDiff(t *testing.T) {
	orders := Policy{
		URI:    "db://shop/orders",
		Action: "select",
		Rule:   `{"customer_email":{"eq":"$auth.email"}}`,
	}
	anyone := Policy{
		URI:    "db://shop/orders",
		Action: "select",
		Rule:   "true",
	}
	products := Policy{
		URI:    "db://shop/products",
		Action: "select",
		Rule:   "true",
	}
	tests := []struct {
		name    string
		current []Policy
		desired []Policy
		want    []string
	}{
		{
			name:    "a new policy",
			desired: []Policy{orders},
			want: []string{
				`INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://shop/orders', 'select', '{"customer_email":{"eq":"$auth.email"}}')`,
			},
		},
		{
			name:    "no change",
			current: []Policy{orders},
			desired: []Policy{orders},
		},
		{
			name:    "a changed rule",
			current: []Policy{orders},
			desired: []Policy{anyone},
			want: []string{
				`INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES ('db://shop/orders', 'select', 'true')`,
			},
		},
		{
			name:    "a removed policy",
			current: []Policy{orders, products},
			desired: []Policy{orders},
			want: []string{
				`DELETE FROM _durabase_policies WHERE uri = 'db://shop/products' AND action = 'select'`,
			},
		},
		{
			name: "a policy of another scheme stays",
			current: []Policy{
				{
					URI:    "files://media/avatars/*",
					Action: "insert",
					Rule:   "true",
				},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			db := open(t, "")
			for _, p := range tt.current {
				_, err := db.ExecContext(ctx, "INSERT INTO _durabase_policies (uri, action, rule) VALUES (?, ?, ?)", p.URI, p.Action, p.Rule)
				require.NoError(t, err)
			}

			got, err := Diff(ctx, db, tt.desired)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}
