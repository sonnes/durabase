// Package sqltext reads SQLite SQL as tokens.
//
// [Lex] returns every token of a text, with the spaces and the comments.
// [Split] cuts a script into statements, and keeps a trigger body in one
// statement. [Normalize] gives a normal form of an expression, so two texts
// with the same meaning compare equal.
package sqltext
