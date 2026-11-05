// Package policies reads durabase/policies.yaml.
//
// Each key of the file is the URI of a table, a column or files, such as
// db://shop/orders, db://shop/orders#customer or files://media/avatars/*.
// Each value maps an action (select, insert, update or delete) to a rule. A
// rule is the where JSON of a query, with vars such as $auth.email in place of
// values. [Parse] checks each column, table, var and operator against the
// schema, so a typo fails in the CLI and not on a request. durabase gen
// writes the policies into durabase.gen.ts, and each Durable Object gets them
// as an option.
package policies
