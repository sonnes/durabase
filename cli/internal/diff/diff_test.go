package diff

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/sonnes/durabase/cli/internal/schema"
	"github.com/sonnes/durabase/cli/internal/sqltext"
)

const ordersV1 = `
create table orders (
  id text primary key,
  state text not null check (state in ('pending', 'paid')),
  amount_paise integer not null
);
create table order_items (
  order_id text not null references orders (id),
  product_id text not null,
  quantity integer not null,
  primary key (order_id, product_id)
);
create index orders_state on orders (state);
`

func open(t *testing.T, script string) *sql.DB {
	t.Helper()
	ctx := context.Background()

	db, err := schema.Open(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { assert.NoError(t, db.Close()) })

	require.NoError(t, schema.Exec(ctx, db, sqltext.Split(script)))
	return db
}

func TestPlan(t *testing.T) {
	tests := []struct {
		name         string
		current      string
		desired      string
		want         []string // a part of each statement, in lower case
		wantWarnings int
	}{
		{
			name:    "no change",
			current: ordersV1,
			desired: ordersV1,
		},
		{
			name:    "empty start",
			current: "",
			desired: ordersV1,
			want: []string{
				"create table",
				"create table",
				"create index",
			},
		},
		{
			name:    "add a column",
			current: ordersV1,
			desired: strings.Replace(
				ordersV1,
				"amount_paise integer not null",
				"amount_paise integer not null,\n  notes text",
				1,
			),
			want: []string{"add column"},
		},
		{
			name:    "new table and index",
			current: ordersV1,
			desired: ordersV1 + `
create table webhook_events (event_id text primary key, received_at integer not null);
create index orders_amount on orders (amount_paise);`,
			want: []string{
				"create table",
				"create index",
			},
		},
		{
			name:         "drop a column",
			current:      ordersV1,
			desired:      strings.Replace(ordersV1, ",\n  amount_paise integer not null", "", 1),
			want:         []string{"drop column"},
			wantWarnings: 1,
		},
		{
			name:    "a column named like a keyword",
			current: "create table counters (name text primary key, value integer not null);",
			desired: `create table counters (name text primary key, value integer not null, note text);
create index counters_value on counters (value);`,
			want: []string{
				"add column",
				"create index",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := Plan(
				context.Background(),
				open(t, tt.current),
				open(t, tt.desired),
			)
			require.NoError(t, err)

			require.Len(t, res.Statements, len(tt.want), "statements: %q", res.Statements)
			for i, part := range tt.want {
				assert.Contains(t, strings.ToLower(res.Statements[i]), part)
			}
			assert.Len(t, res.Warnings, tt.wantWarnings)
		})
	}
}

func TestPlanDropsTheLinesOfComments(t *testing.T) {
	desired := `create table notes (
  -- the key
  id text primary key,
  body text -- the text
);`

	res, err := Plan(context.Background(), open(t, ""), open(t, desired))
	require.NoError(t, err)

	require.Len(t, res.Statements, 1)
	for line := range strings.SplitSeq(res.Statements[0], "\n") {
		assert.NotEmpty(t, strings.TrimSpace(line), "statement: %q", res.Statements[0])
	}
}
