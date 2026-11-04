package schema

import (
	"slices"
	"strings"

	"github.com/sonnes/durabase/cli/internal/sqltext"
)

// Export returns the schema as SQL, in the form that sqldef reads. Each name
// of a table, a column or an object is in double quotes, because the parser
// of sqldef refuses some names that SQLite accepts, such as "value".
func Export(snap *Snapshot) string {
	names := snap.names()

	var parts []string
	for _, name := range snap.TableNames() {
		parts = append(parts, quoteNames(snap.Tables[name].SQL, names)+";")
	}
	for _, typ := range []string{"view", "index", "trigger"} {
		for _, o := range snap.objectsOfType(typ) {
			parts = append(parts, quoteNames(o.SQL, names)+";")
		}
	}
	return strings.Join(parts, "\n\n")
}

// names returns the names of the tables, the columns and the objects, in
// lower case.
func (s *Snapshot) names() map[string]bool {
	names := map[string]bool{}
	for _, t := range s.Tables {
		names[strings.ToLower(t.Name)] = true
		for _, c := range t.Columns {
			names[strings.ToLower(c.Name)] = true
		}
	}
	for _, o := range s.Objects {
		names[strings.ToLower(o.Name)] = true
	}
	return names
}

// quoteNames puts each word of s that is in names in double quotes. A word
// after a column name is its type, and stays as it is.
func quoteNames(s string, names map[string]bool) string {
	var b strings.Builder
	prevName := false
	for _, t := range sqltext.Lex(s) {
		switch t.Kind {
		case sqltext.Space, sqltext.Comment:
			b.WriteString(t.Text)
			continue
		case sqltext.Ident:
			b.WriteString(t.Text)
			prevName = true
			continue
		case sqltext.Word:
			isName := names[strings.ToLower(t.Text)] && !prevName
			if isName {
				b.WriteString(sqltext.QuoteIdent(t.Text))
				prevName = true
				continue
			}
		}
		b.WriteString(t.Text)
		prevName = false
	}
	return b.String()
}

func (s *Snapshot) objectsOfType(typ string) []Object {
	var out []Object
	for _, o := range s.Objects {
		if o.Type == typ {
			out = append(out, o)
		}
	}
	slices.SortFunc(out, func(a, b Object) int {
		return strings.Compare(a.Name, b.Name)
	})
	return out
}
