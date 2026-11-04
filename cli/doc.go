// Command durabase writes migrations from SQL schema files, and writes the
// TypeScript types for the durabase client.
//
//	durabase db diff -f <name> [-dir durabase]
//	durabase gen [-dir durabase] [-out durabase/durabase.gen.ts] [-functions <dir>]
//	durabase version
//
// The project folder (-dir) holds schema/*.sql, the desired state that the
// developer edits, and migrations/*.sql, which durabase writes.
package main
