package sqltext

import (
	"strings"
)

// Normalize returns a normal form of a SQL text. Keywords and identifiers
// are in lower case, quotes around identifiers go, and the spaces follow one
// rule. String literals do not change.
func Normalize(s string) string {
	var b strings.Builder
	var prev string
	for i, t := range Code(s) {
		text := t.Text
		switch t.Kind {
		case Word:
			text = strings.ToLower(text)
		case Ident:
			text = strings.ToLower(Unquote(text))
		}
		if i > 0 && needsSpace(prev, text) {
			b.WriteByte(' ')
		}
		b.WriteString(text)
		prev = text
	}
	return b.String()
}

func needsSpace(prev, next string) bool {
	switch prev {
	case "(", ".", ",":
		return false
	}
	switch next {
	case "(", ")", ",", ".":
		return false
	}
	return true
}

// Unquote removes the quotes around an identifier.
func Unquote(s string) string {
	if len(s) < 2 {
		return s
	}
	inner := s[1 : len(s)-1]
	switch s[0] {
	case '"':
		return strings.ReplaceAll(inner, `""`, `"`)
	case '`':
		return strings.ReplaceAll(inner, "``", "`")
	case '[':
		return inner
	}
	return s
}

// QuoteIdent puts an identifier in double quotes.
func QuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
