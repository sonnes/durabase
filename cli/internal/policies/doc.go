// Package policies reads durabase/policies.yaml and writes the statements
// that store its rules in the migrations.
//
// Each key of the file is the URI of a table or a column, such as
// db://shop/orders or db://shop/orders#customer. Each value maps an action
// (select, insert, update or delete) to a rule. A rule is the where JSON of a
// query, with vars such as $auth.email in place of values. [Parse] checks each
// column, table and var against the schema, so a typo fails in the CLI and
// not on a request. [Diff] compares the rules with the rows that the
// migrations already wrote into _durabase_policies.
package policies
