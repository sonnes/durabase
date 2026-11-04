package sqltext

import (
	"strings"
)

// Kind is the kind of a [Token].
type Kind int

// The kinds of a [Token].
const (
	Space   Kind = iota // spaces, tabs and line breaks
	Comment             // a -- or a /* */ comment
	Word                // a keyword or an identifier without quotes
	Ident               // an identifier in "", ``, or []
	String              // a string literal in ''
	Number              // a number literal
	Punct               // an operator or a punctuation mark
)

// Token is one token of the source text. Start and End are byte offsets.
type Token struct {
	Kind  Kind
	Text  string
	Start int
	End   int
}

// Lex returns all tokens of s, with the spaces and the comments.
func Lex(s string) []Token {
	var tokens []Token
	for i := 0; i < len(s); {
		kind, end := scan(s, i)
		tokens = append(tokens, Token{
			Kind:  kind,
			Text:  s[i:end],
			Start: i,
			End:   end,
		})
		i = end
	}
	return tokens
}

// Code returns the tokens of s without the spaces and the comments.
func Code(s string) []Token {
	var out []Token
	for _, t := range Lex(s) {
		isCode := t.Kind != Space && t.Kind != Comment
		if isCode {
			out = append(out, t)
		}
	}
	return out
}

// scan returns the kind and the end of the token that starts at i.
func scan(s string, i int) (Kind, int) {
	c := s[i]
	switch {
	case isSpace(c):
		return Space, skipWhile(s, i, isSpace)
	case strings.HasPrefix(s[i:], "--"):
		return Comment, lineEnd(s, i)
	case strings.HasPrefix(s[i:], "/*"):
		return Comment, blockEnd(s, i)
	case c == '\'':
		return String, quoted(s, i, '\'')
	case c == '"' || c == '`':
		return Ident, quoted(s, i, c)
	case c == '[':
		return Ident, bracketEnd(s, i)
	case isWordStart(c):
		return Word, skipWhile(s, i, isWordPart)
	case isNumberStart(s, i):
		return Number, number(s, i)
	default:
		return Punct, punctEnd(s, i)
	}
}

func skipWhile(s string, i int, ok func(byte) bool) int {
	for i < len(s) && ok(s[i]) {
		i++
	}
	return i
}

func lineEnd(s string, i int) int {
	end := strings.IndexByte(s[i:], '\n')
	if end < 0 {
		return len(s)
	}
	return i + end
}

func blockEnd(s string, i int) int {
	end := strings.Index(s[i+2:], "*/")
	if end < 0 {
		return len(s)
	}
	return i + 2 + end + 2
}

func bracketEnd(s string, i int) int {
	end := strings.IndexByte(s[i:], ']')
	if end < 0 {
		return len(s)
	}
	return i + end + 1
}

// quoted returns the end of a text in quotes q. Two quotes in a row are one
// quote of the text.
func quoted(s string, i int, q byte) int {
	i++
	for i < len(s) {
		if s[i] != q {
			i++
			continue
		}
		isDoubled := i+1 < len(s) && s[i+1] == q
		if !isDoubled {
			return i + 1
		}
		i += 2
	}
	return i
}

func isNumberStart(s string, i int) bool {
	isDotDigit := s[i] == '.' && i+1 < len(s) && isDigit(s[i+1])
	return isDigit(s[i]) || isDotDigit
}

func number(s string, i int) int {
	isHexStart := strings.HasPrefix(s[i:], "0x") || strings.HasPrefix(s[i:], "0X")
	if isHexStart {
		return skipWhile(s, i+2, isHex)
	}
	i = skipWhile(s, i, isDecimalPart)
	return exponent(s, i)
}

// exponent returns the end of an exponent such as e+10 at i, or i if there
// is none.
func exponent(s string, i int) int {
	if i >= len(s) || (s[i] != 'e' && s[i] != 'E') {
		return i
	}
	j := i + 1
	if j < len(s) && (s[j] == '+' || s[j] == '-') {
		j++
	}
	if j >= len(s) || !isDigit(s[j]) {
		return i
	}
	return skipWhile(s, j, isDigit)
}

func punctEnd(s string, i int) int {
	if i+2 <= len(s) && isTwoCharOp(s[i:i+2]) {
		return i + 2
	}
	return i + 1
}

func isTwoCharOp(op string) bool {
	switch op {
	case "<=", ">=", "!=", "<>", "==", "||", "<<", ">>", "->":
		return true
	}
	return false
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func isDecimalPart(c byte) bool {
	return isDigit(c) || c == '.' || c == '_'
}

func isHex(c byte) bool {
	isHexLetter := (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
	return isDigit(c) || isHexLetter
}

func isWordStart(c byte) bool {
	isLetter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	return isLetter || c == '_' || c >= 0x80
}

func isWordPart(c byte) bool {
	return isWordStart(c) || isDigit(c) || c == '$'
}
