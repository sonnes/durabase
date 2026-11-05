package policies

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/goccy/go-yaml"
	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/parser"

	"github.com/sonnes/durabase/cli/internal/schema"
)

// Policy is one rule of one action on a table or a column.
type Policy struct {
	URI    string // db://shop/orders, or db://shop/orders#customer
	Action string // select, insert, update or delete
	Rule   string // the rule, as JSON with sorted keys
}

var actions = []string{
	"select",
	"insert",
	"update",
	"delete",
}

// operators are the operators of a rule, by the kind of the left side: a
// column, a var with one value, or a list var. The SDK has the same table in
// packages/sdk/src/policy.ts, and a test compares the two.
var operators = map[string][]string{
	"column": {"eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "is"},
	"var":    {"eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "is"},
	"list":   {"has"},
}

// listVar is the one var that holds a list.
const listVar = "$auth.groups"

var vars = []string{
	"$auth.role",
	"$auth.sub",
	"$auth.email",
	"$auth.groups",
	"$ns",
	"$now",
}

// pattern matches db://<namespace or *>/<table>[#column].
var pattern = regexp.MustCompile(`^db://([a-z0-9][a-z0-9_.-]*|\*)/([A-Za-z_][A-Za-z0-9_]*)(?:#([A-Za-z_][A-Za-z0-9_]*))?$`)

// filesPattern matches files://<bucket>, files://<bucket>/<prefix>* and
// files://<bucket>/<name>.
var filesPattern = regexp.MustCompile(`^files://[a-z0-9][a-z0-9_.-]*(/[^*#?]*\*?)?$`)

// filesSnap holds the objects table of the Files DO, which the SDK owns. A
// files rule can name only its columns.
var filesSnap = &schema.Snapshot{
	Tables: map[string]*schema.Table{
		"objects": {
			Name: "objects",
			Columns: []schema.Column{
				{Name: "bucket"},
				{Name: "name"},
				{Name: "owner_id"},
				{Name: "version"},
				{Name: "size"},
				{Name: "type"},
				{Name: "etag"},
				{Name: "metadata"},
				{Name: "created_at"},
				{Name: "updated_at"},
			},
		},
	},
}

// folderKey matches a files key that ends in "/".
var folderKey = regexp.MustCompile(`^files://[^/]+/(.*/)?$`)

var errFolderKey = errors.New(`the key ends in "/". Use "*" for each file, such as files://media/avatars/*`)

const keyHelp = "the key must be a table, such as db://shop/orders, or files, such as files://media/avatars/*"

// Load reads the policies file at path. A project with no file has no
// policies.
func Load(path string, snap *schema.Snapshot) ([]Policy, error) {
	text, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Parse(path, text, snap)
}

// Parse reads the text of a policies file, and checks each rule against the
// tables of snap. The policies come back sorted by URI and action.
func Parse(path string, text []byte, snap *schema.Snapshot) ([]Policy, error) {
	file, err := parser.ParseBytes(text, 0)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}

	var out []Policy
	for _, doc := range file.Docs {
		entries, err := mapping(doc.Body)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		for _, entry := range entries {
			got, err := parseEntry(snap, entry)
			if err != nil {
				return nil, fmt.Errorf("%s:%w", path, err)
			}
			out = append(out, got...)
		}
	}

	slices.SortFunc(out, func(a, b Policy) int {
		return strings.Compare(a.URI+" "+a.Action, b.URI+" "+b.Action)
	})
	return out, nil
}

// lineError is an error at a line of the file.
func lineError(node ast.Node, format string, a ...any) error {
	return fmt.Errorf("%d: %s", node.GetToken().Position.Line, fmt.Sprintf(format, a...))
}

func mapping(node ast.Node) ([]*ast.MappingValueNode, error) {
	switch n := node.(type) {
	case nil:
		return nil, nil
	case *ast.MappingNode:
		return n.Values, nil
	case *ast.MappingValueNode:
		return []*ast.MappingValueNode{n}, nil
	}
	return nil, lineError(node, "the file must be a map of URIs")
}

func parseEntry(snap *schema.Snapshot, entry *ast.MappingValueNode) ([]Policy, error) {
	uri := entry.Key.String()
	table, column, snap, err := target(snap, uri)
	if err != nil {
		return nil, lineError(entry.Key, "%s: %v", uri, err)
	}

	rules, err := mapping(entry.Value)
	if err != nil {
		return nil, lineError(entry.Key, "%s: the value must be a map of actions", uri)
	}

	out := make([]Policy, 0, len(rules))
	for _, r := range rules {
		action := r.Key.String()
		if !slices.Contains(actions, action) {
			return nil, lineError(r.Key, "%s %s: the action must be select, insert, update or delete", uri, action)
		}

		var rule any
		err := yaml.NodeToValue(r.Value, &rule)
		if err != nil {
			return nil, lineError(r.Key, "%s %s: %v", uri, action, err)
		}

		_, isBool := rule.(bool)
		if column != "" && !isBool {
			return nil, lineError(r.Key, "%s %s: the rule of a column must be true or false", uri, action)
		}
		c := checker{snap: snap}
		err = c.rule(rule, table, nil)
		if err != nil {
			return nil, lineError(r.Key, "%s %s: %v", uri, action, err)
		}

		text, err := json.Marshal(rule)
		if err != nil {
			return nil, lineError(r.Key, "%s %s: %v", uri, action, err)
		}
		out = append(out, Policy{
			URI:    uri,
			Action: action,
			Rule:   string(text),
		})
	}
	return out, nil
}

// target returns the table and the column of a key, and the schema that its
// rules can name.
func target(snap *schema.Snapshot, uri string) (*schema.Table, string, *schema.Snapshot, error) {
	if folderKey.MatchString(uri) {
		return nil, "", nil, errFolderKey
	}
	if filesPattern.MatchString(uri) {
		return filesSnap.Tables["objects"], "", filesSnap, nil
	}

	m := pattern.FindStringSubmatch(uri)
	if m == nil {
		return nil, "", nil, errors.New(keyHelp)
	}
	table := findTable(snap, m[2])
	if table == nil {
		return nil, "", nil, fmt.Errorf("no table %s", m[2])
	}
	column := m[3]
	if column != "" && table.Column(column) == nil {
		return nil, "", nil, fmt.Errorf("%s has no column %s", table.Name, column)
	}
	return table, column, snap, nil
}

func findTable(snap *schema.Snapshot, name string) *schema.Table {
	for _, t := range snap.Tables {
		if strings.EqualFold(t.Name, name) {
			return t
		}
	}
	return nil
}

// checker checks a rule against the schema, as the Durable Object reads it.
type checker struct {
	snap *schema.Snapshot
}

// rule checks a rule on table. outer is the table of the row that $row
// names, inside a table key.
func (c checker) rule(v any, table, outer *schema.Table) error {
	switch r := v.(type) {
	case bool:
		return nil
	case []any:
		for _, item := range r {
			_, isObject := item.(map[string]any)
			if !isObject {
				return errors.New("each item of a list must be an object")
			}
			err := c.rule(item, table, outer)
			if err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		return c.object(r, table, outer)
	}
	return errors.New("a rule must be true, false, an object or a list")
}

func (c checker) object(r map[string]any, table, outer *schema.Table) error {
	keys := make([]string, 0, len(r))
	for k := range r {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	for _, k := range keys {
		err := c.condition(k, r[k], table, outer)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c checker) condition(key string, v any, table, outer *schema.Table) error {
	if strings.HasPrefix(key, "$") {
		if !slices.Contains(vars, key) {
			return fmt.Errorf("unknown var %s", key)
		}
		kind := "var"
		if key == listVar {
			kind = "list"
		}
		return c.operators(v, kind, nil)
	}
	if table.Column(key) != nil {
		return c.operators(v, "column", outer)
	}

	other := findTable(c.snap, key)
	if other == nil {
		return fmt.Errorf("%s has no column %s", table.Name, key)
	}
	return c.rule(v, other, table)
}

// operators checks { eq: value, … }. kind is the kind of the left side:
// column, var or list. outer is the table that $row names, or nil.
func (c checker) operators(v any, kind string, outer *schema.Table) error {
	ops, ok := v.(map[string]any)
	if !ok {
		return errors.New("a condition must be an object of operators, such as { eq: paid }")
	}
	names := make([]string, 0, len(ops))
	for op := range ops {
		names = append(names, op)
	}
	slices.Sort(names)

	for _, op := range names {
		err := c.operator(op, ops[op], kind, outer)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c checker) operator(op string, value any, kind string, outer *schema.Table) error {
	known := slices.Contains(operators["column"], op) || slices.Contains(operators["list"], op)
	if !known {
		return fmt.Errorf("unknown operator %s", op)
	}
	if !slices.Contains(operators[kind], op) {
		if kind == "list" {
			return fmt.Errorf("%s is a list. Use has, such as { has: staff }", listVar)
		}
		return errors.New("has is only for a list var, such as $auth.groups")
	}

	switch op {
	case "in":
		return c.list(value)
	case "is":
		isFlag := value == nil || value == true || value == false
		if !isFlag {
			return errors.New("is needs null, true or false")
		}
		return nil
	}
	_, isList := value.([]any)
	if isList || value == listVar {
		return fmt.Errorf("%s needs one value", op)
	}
	return c.value(value, outer)
}

// list checks the value of in: a list of plain values, or $auth.groups.
func (c checker) list(v any) error {
	errList := errors.New("in needs a list of values, or $auth.groups")
	if v == listVar {
		return nil
	}
	items, ok := v.([]any)
	if !ok {
		return errList
	}
	for _, item := range items {
		if isVar(item) {
			return errList
		}
	}
	return nil
}

// isVar reports whether v is a var, such as $auth.email. "$$5" is the text "$5".
func isVar(v any) bool {
	s, ok := v.(string)
	return ok && strings.HasPrefix(s, "$") && !strings.HasPrefix(s, "$$")
}

// value checks one value: a plain value, a var or $row.<column>.
func (c checker) value(v any, outer *schema.Table) error {
	if !isVar(v) {
		return nil
	}
	s, _ := v.(string)

	column, isRow := strings.CutPrefix(s, "$row.")
	if !isRow {
		if !slices.Contains(vars, s) {
			return fmt.Errorf("unknown var %s", s)
		}
		return nil
	}
	if outer == nil {
		return errors.New("$row is only for a table key")
	}
	if outer.Column(column) == nil {
		return fmt.Errorf("%s has no column %s", outer.Name, column)
	}
	return nil
}
