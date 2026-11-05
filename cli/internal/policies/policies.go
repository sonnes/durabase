package policies

import (
	"context"
	"database/sql"
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

var operators = []string{
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"is",
	"like",
	"has",
}

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
		return c.operators(v, key, nil)
	}
	if table.Column(key) != nil {
		return c.operators(v, "", outer)
	}

	other := findTable(c.snap, key)
	if other == nil {
		return fmt.Errorf("%s has no column %s", table.Name, key)
	}
	return c.rule(v, other, table)
}

// operators checks { eq: value, … }. varKey is the var on the left, or "".
func (c checker) operators(v any, varKey string, outer *schema.Table) error {
	ops, ok := v.(map[string]any)
	if !ok {
		return errors.New("a condition must be an object of operators, such as { eq: paid }")
	}
	for op, value := range ops {
		if !slices.Contains(operators, op) {
			return fmt.Errorf("unknown operator %s", op)
		}
		isListVar := varKey == "$auth.groups"
		if op == "has" && !isListVar {
			return errors.New("has is only for a list var, such as $auth.groups")
		}
		err := c.value(value, outer)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c checker) value(v any, outer *schema.Table) error {
	if list, ok := v.([]any); ok {
		for _, item := range list {
			err := c.value(item, outer)
			if err != nil {
				return err
			}
		}
		return nil
	}

	s, ok := v.(string)
	isVar := ok && strings.HasPrefix(s, "$") && !strings.HasPrefix(s, "$$")
	if !isVar {
		return nil
	}

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

// Diff returns the statements that change the db:// policies of db into
// desired. The policies of other schemes stay. The files:// policies go to
// the Files DO with durabase gen, not to the migrations.
func Diff(ctx context.Context, db *sql.DB, desired []Policy) ([]string, error) {
	current, err := read(ctx, db)
	if err != nil {
		return nil, err
	}

	var out []string
	seen := map[string]bool{}
	for _, p := range desired {
		isDB := strings.HasPrefix(p.URI, "db://")
		if !isDB {
			continue
		}
		k := p.URI + " " + p.Action
		seen[k] = true
		rule, exists := current[k]
		if exists && rule == p.Rule {
			continue
		}
		out = append(out, fmt.Sprintf(
			"INSERT OR REPLACE INTO _durabase_policies (uri, action, rule) VALUES (%s, %s, %s)",
			quote(p.URI),
			quote(p.Action),
			quote(p.Rule),
		))
	}

	gone := make([]string, 0, len(current))
	for k := range current {
		if !seen[k] {
			gone = append(gone, k)
		}
	}
	slices.Sort(gone)
	for _, k := range gone {
		uri, action, _ := strings.Cut(k, " ")
		out = append(out, fmt.Sprintf(
			"DELETE FROM _durabase_policies WHERE uri = %s AND action = %s",
			quote(uri),
			quote(action),
		))
	}
	return out, nil
}

func read(ctx context.Context, db *sql.DB) (current map[string]string, err error) {
	rows, err := db.QueryContext(ctx, "SELECT uri, action, rule FROM _durabase_policies WHERE uri LIKE 'db://%'")
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()

	current = map[string]string{}
	for rows.Next() {
		var uri, action, rule string
		err := rows.Scan(&uri, &action, &rule)
		if err != nil {
			return nil, err
		}
		current[uri+" "+action] = rule
	}
	return current, rows.Err()
}

func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
