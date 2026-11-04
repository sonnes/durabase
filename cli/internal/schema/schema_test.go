package schema

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"durabase/cli/internal/sqltext"
)

const shopSQL = `
create table orders (
  id text primary key,
  state text not null default 'pending' check (state in ('pending', 'paid')),
  notes text
) strict;
create table order_items (
  order_id text not null references orders (id),
  value integer not null
);
create index order_items_value on order_items (value);
`

func load(t *testing.T, script string) *Snapshot {
	t.Helper()
	ctx := context.Background()

	db, err := Open(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { assert.NoError(t, db.Close()) })

	require.NoError(t, Exec(ctx, db, sqltext.Split(script)))
	snap, err := Read(ctx, db)
	require.NoError(t, err)
	return snap
}

func TestRead(t *testing.T) {
	snap := load(t, shopSQL)

	assert.Equal(t, []string{"order_items", "orders"}, snap.TableNames())

	orders := snap.Tables["orders"]
	assert.Equal(t, []string{"state in('pending','paid')"}, orders.Checks)
	assert.Equal(t, "strict", orders.Options)

	state := orders.Column("STATE")
	require.NotNil(t, state)
	assert.True(t, state.NotNull)
	assert.Equal(t, "'pending'", *state.Default)
	assert.Equal(t, 1, orders.Column("id").PK)

	items := snap.Tables["order_items"]
	assert.Equal(t, []ForeignKey{
		{
			Table: "orders",
			From:  []string{"order_id"},
			To:    []string{"id"},
		},
	}, items.ForeignKeys)

	assert.Contains(t, snap.Objects, "index:order_items_value")
}

func TestExportQuotesNames(t *testing.T) {
	snap := load(t, shopSQL)

	out := Export(snap)

	assert.Contains(t, out, `"value" integer not null`)
	assert.Contains(t, out, `CREATE INDEX "order_items_value" on "order_items" ("value")`)
}

func TestExecRollsBack(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx)
	require.NoError(t, err)
	defer func() { assert.NoError(t, db.Close()) }()

	err = Exec(ctx, db, []string{
		"create table a (x text)",
		"select * from nope",
	})
	require.Error(t, err)

	snap, err := Read(ctx, db)
	require.NoError(t, err)
	assert.Empty(t, snap.Tables)
}
