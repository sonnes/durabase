package schema

import (
	"slices"
	"strings"

	"github.com/sonnes/durabase/cli/internal/sqltext"
)

// parseCreate returns the CHECK expressions and the table options of a
// CREATE TABLE statement.
func parseCreate(createSQL string) (checks []string, options string) {
	tokens := sqltext.Code(createSQL)
	for i := range tokens {
		isCheck := tokens[i].Kind == sqltext.Word &&
			strings.EqualFold(tokens[i].Text, "check") &&
			i+1 < len(tokens) &&
			tokens[i+1].Text == "("
		if !isCheck {
			continue
		}
		end := matching(tokens, i+1)
		expr := createSQL[tokens[i+2].Start:tokens[end].Start]
		checks = append(checks, sqltext.Normalize(expr))
	}
	slices.Sort(checks)

	closeAt := matching(tokens, firstOpen(tokens))
	hasOptions := closeAt >= 0 && closeAt+1 < len(tokens)
	if hasOptions {
		options = sqltext.Normalize(createSQL[tokens[closeAt+1].Start:])
	}
	return checks, options
}

func firstOpen(tokens []sqltext.Token) int {
	for i, t := range tokens {
		if t.Text == "(" {
			return i
		}
	}
	return len(tokens)
}

// matching returns the index of the ")" that closes the "(" at open, or -1.
func matching(tokens []sqltext.Token, open int) int {
	depth := 0
	for i := open; i < len(tokens); i++ {
		switch tokens[i].Text {
		case "(":
			depth++
		case ")":
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}
