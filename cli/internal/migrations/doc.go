// Package migrations reads and writes the migration files of a project.
//
// A migration file is <dir>/migrations/NNNN_name.sql. The CLI writes each
// file, and nobody edits it after a deploy. [List] reads the files in version
// order, and [Replay] runs them on an in-memory database. [LoadSchema] runs
// the schema files, the desired state, on another database.
package migrations
