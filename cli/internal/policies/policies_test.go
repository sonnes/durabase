package policies

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"regexp"
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
			name: "files policies",
			yaml: "files://media/avatars/*:\n  insert: { $auth.role: { eq: authenticated } }\n  delete: { owner_id: { eq: $auth.sub } }\nfiles://printables:\n  select: false\n",
			want: []Policy{
				{
					URI:    "files://media/avatars/*",
					Action: "delete",
					Rule:   `{"owner_id":{"eq":"$auth.sub"}}`,
				},
				{
					URI:    "files://media/avatars/*",
					Action: "insert",
					Rule:   `{"$auth.role":{"eq":"authenticated"}}`,
				},
				{
					URI:    "files://printables",
					Action: "select",
					Rule:   "false",
				},
			},
		},
		{
			name: "like and in on a var",
			yaml: "db://shop/products:\n  insert:\n    - { $auth.email: { like: \"%@littleplay.co\" } }\n    - { $auth.role: { in: [service, authenticated] } }\n",
			want: []Policy{
				{
					URI:    "db://shop/products",
					Action: "insert",
					Rule:   `[{"$auth.email":{"like":"%@littleplay.co"}},{"$auth.role":{"in":["service","authenticated"]}}]`,
				},
			},
		},
		{
			name: "in with the groups of the caller",
			yaml: "db://shop/orders:\n  select: { state: { in: $auth.groups } }\n",
			want: []Policy{
				{
					URI:    "db://shop/orders",
					Action: "select",
					Rule:   `{"state":{"in":"$auth.groups"}}`,
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
			want: "policies.yaml:1: ftp://shop/orders: the key must be a table, such as db://shop/orders, or files, such as files://media/avatars/*",
		},
		{
			name: "no table",
			yaml: "db://shop:\n  select: true\n",
			want: "policies.yaml:1: db://shop: the key must be a table, such as db://shop/orders, or files, such as files://media/avatars/*",
		},
		{
			name: "a files rule with a column that objects does not have",
			yaml: "files://media/*:\n  select: { owner: { eq: $auth.sub } }\n",
			want: "policies.yaml:2: files://media/* select: objects has no column owner",
		},
		{
			name: "a files rule with a table of the app",
			yaml: "files://media/*:\n  select: { orders: { id: { eq: x } } }\n",
			want: "policies.yaml:2: files://media/* select: objects has no column orders",
		},
		{
			name: "a star that is not at the end",
			yaml: "files://media/*/x:\n  select: true\n",
			want: "policies.yaml:1: files://media/*/x: the key must be a table, such as db://shop/orders, or files, such as files://media/avatars/*",
		},
		{
			name: "eq on a list var",
			yaml: "db://shop/orders:\n  select: { $auth.groups: { eq: staff } }\n",
			want: "policies.yaml:2: db://shop/orders select: $auth.groups is a list. Use has, such as { has: staff }",
		},
		{
			name: "has with a list",
			yaml: "db://shop/orders:\n  select: { $auth.groups: { has: [staff] } }\n",
			want: "policies.yaml:2: db://shop/orders select: has needs one value",
		},
		{
			name: "$row in a list of in",
			yaml: "db://shop/order_items:\n  select: { orders: { id: { in: [$row.order_id] } } }\n",
			want: "policies.yaml:2: db://shop/order_items select: in needs a list of values, or $auth.groups",
		},
		{
			name: "in with one value",
			yaml: "db://shop/orders:\n  select: { state: { in: paid } }\n",
			want: "policies.yaml:2: db://shop/orders select: in needs a list of values, or $auth.groups",
		},
		{
			name: "eq with a list",
			yaml: "db://shop/orders:\n  select: { state: { eq: [paid] } }\n",
			want: "policies.yaml:2: db://shop/orders select: eq needs one value",
		},
		{
			name: "eq with a list var",
			yaml: "db://shop/orders:\n  select: { state: { eq: $auth.groups } }\n",
			want: "policies.yaml:2: db://shop/orders select: eq needs one value",
		},
		{
			name: "is with text",
			yaml: "db://shop/orders:\n  select: { state: { is: paid } }\n",
			want: "policies.yaml:2: db://shop/orders select: is needs null, true or false",
		},
		{
			name: "a files key that ends in a slash",
			yaml: "files://media/:\n  select: true\n",
			want: `policies.yaml:1: files://media/: the key ends in "/". Use "*" for each file, such as files://media/avatars/*`,
		},
		{
			name: "a files prefix that ends in a slash",
			yaml: "files://media/avatars/:\n  select: true\n",
			want: `policies.yaml:1: files://media/avatars/: the key ends in "/". Use "*" for each file, such as files://media/avatars/*`,
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

// TestOperatorsMatchSDK makes sure that the CLI and the Durable Object accept
// the same operators. The SDK keeps its table in packages/sdk/src/policy.ts.
func TestOperatorsMatchSDK(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "sdk", "src", "policy.ts"))
	require.NoError(t, err)

	line := regexp.MustCompile(`(?m)^  (column|var|list): \[([^\]]*)\],`)
	word := regexp.MustCompile(`"([a-z]+)"`)
	got := map[string][]string{}
	for _, m := range line.FindAllStringSubmatch(string(text), -1) {
		for _, w := range word.FindAllStringSubmatch(m[2], -1) {
			got[m[1]] = append(got[m[1]], w[1])
		}
	}
	assert.Equal(t, operators, got)
}
