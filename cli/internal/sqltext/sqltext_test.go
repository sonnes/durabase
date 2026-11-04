package sqltext

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSplit(t *testing.T) {
	tests := []struct {
		name   string
		script string
		want   []string
	}{
		{
			name:   "two statements and comments",
			script: "-- the orders\ncreate table a (x text); /* note */ create index a_x on a (x);\n",
			want: []string{
				"create table a (x text)",
				"create index a_x on a (x)",
			},
		},
		{
			name:   "semicolon in a string",
			script: "insert into a values ('a;b'); select 1",
			want: []string{
				"insert into a values ('a;b')",
				"select 1",
			},
		},
		{
			name: "trigger with case",
			script: `create trigger t after insert on a begin
  update a set x = case when new.x is null then 'n' end;
  delete from b;
end;
select 2;`,
			want: []string{
				"create trigger t after insert on a begin\n  update a set x = case when new.x is null then 'n' end;\n  delete from b;\nend",
				"select 2",
			},
		},
		{
			name:   "empty script",
			script: "  -- nothing\n",
			want:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, Split(tt.script))
		})
	}
}

func TestNormalize(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
	}{
		{
			name: "quotes and case",
			a:    `state IN ('pending', 'paid')`,
			b:    `"state" in('pending','paid')`,
		},
		{
			name: "spaces in parentheses",
			a:    `CHECK ( amount_paise > 0 )`,
			b:    `check(amount_paise>0)`,
		},
		{
			name: "brackets",
			a:    `[Orders].[Id]`,
			b:    `orders.id`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, Normalize(tt.a), Normalize(tt.b))
		})
	}
}

func TestNormalizeKeepsStringLiterals(t *testing.T) {
	assert.Equal(t, `x = 'A B'`, Normalize(`x = 'A B'`))
}

func TestLexNumbers(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "0x1F+", want: "0x1F"},
		{input: "1.5e+10,", want: "1.5e+10"},
		{input: "2e", want: "2"},
		{input: ".5)", want: ".5"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			tokens := Lex(tt.input)
			assert.Equal(t, Number, tokens[0].Kind)
			assert.Equal(t, tt.want, tokens[0].Text)
		})
	}
}
