package sqltext

import (
	"strings"
)

// Split returns the statements of a script, without the comments and without
// the final semicolons. A semicolon inside the BEGIN ... END of a trigger does
// not end the statement.
func Split(script string) []string {
	var sp splitter
	for _, t := range Lex(script) {
		sp.add(t)
	}
	sp.finish()
	return sp.statements
}

// splitter collects the tokens of the statement in progress.
type splitter struct {
	statements []string
	current    strings.Builder
	words      []string // the first words of the statement
	trigger    bool
	seenBegin  bool
	seenEnd    bool
	caseDepth  int
}

func (sp *splitter) add(t Token) {
	switch t.Kind {
	case Comment:
		sp.current.WriteByte(' ')
		return
	case Word:
		sp.word(strings.ToLower(t.Text))
	case Punct:
		isEnd := t.Text == ";" && (!sp.trigger || sp.seenEnd)
		if isEnd {
			sp.finish()
			return
		}
	}
	sp.current.WriteString(t.Text)
}

func (sp *splitter) word(w string) {
	if len(sp.words) < 3 {
		sp.words = append(sp.words, w)
		sp.trigger = isTriggerStart(sp.words)
	}
	if !sp.trigger {
		return
	}
	switch {
	case w == "begin":
		sp.seenBegin = true
	case w == "case":
		sp.caseDepth++
	case w == "end" && sp.caseDepth > 0:
		sp.caseDepth--
	case w == "end" && sp.seenBegin:
		sp.seenEnd = true
	}
}

func (sp *splitter) finish() {
	text := strings.TrimSpace(sp.current.String())
	if text != "" {
		sp.statements = append(sp.statements, text)
	}
	statements := sp.statements
	*sp = splitter{}
	sp.statements = statements
}

func isTriggerStart(words []string) bool {
	if len(words) >= 2 && words[0] == "create" && words[1] == "trigger" {
		return true
	}
	isTemp := len(words) >= 3 && (words[1] == "temp" || words[1] == "temporary")
	return isTemp && words[0] == "create" && words[2] == "trigger"
}
