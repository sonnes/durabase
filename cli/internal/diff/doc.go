// Package diff finds the statements that change the replayed migrations into
// the schema files.
//
// sqldef writes the statements: new tables, new columns, indexes, views,
// triggers and drops. [Plan] runs the statements on the replayed database, so
// a statement that SQLite refuses fails in the CLI and not in the Durable
// Object.
package diff
