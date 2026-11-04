// Package schema reads the state of a SQLite database.
//
// The CLI uses two in-memory databases: one with the migrations replayed,
// and one with the schema files. Both have foreign keys on, as in a Durable
// Object. [Read] returns a [Snapshot] of one database: its tables, their
// columns, foreign keys and CHECK expressions, and its indexes, views and
// triggers. [Export] writes a snapshot as SQL for sqldef.
package schema
