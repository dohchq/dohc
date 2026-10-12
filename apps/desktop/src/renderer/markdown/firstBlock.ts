import type { Lexer } from "marked";

// Whether a Markdown body opens with an H1, as the editor's lexer, marked
// 17.0.6, reads it. The first line decides an ATX heading, or a block that
// can only be something else. A paragraph is an H1 only as a setext heading,
// which ends at its underline, so only the lines through the first
// underline-shaped line are lexed, and only when one comes before the
// paragraph ends. firstBlock.test.ts runs every answer beside the lexer.
//
// The rules are marked's own, read one line at a time after its line-end
// normalization (`\r\n` and `\r` become `\n`).
const LINE_END = /\r\n|\r|\n/g;
// `newline`: a line of spaces and tabs.
const SPACE = /^[ \t]*$/;
// `heading`: one to six `#`, then any whitespace or the line's end, and a
// rest of line `.` can match, which a line or paragraph separator stops.
const ATX_HEADING = /^ {0,3}(#{1,6})(?=\s|$).*$/;
// `code`, `fences`, `hr`, `blockquote` and `list`, which marked tries before a
// setext heading: a first line that starts one is never a heading.
const NEVER_A_HEADING =
  /^(?: {4}| {0,3}\t| {0,3}(?:`{3,}[^`]*$|~{3,}|(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$|>|(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)))/;
// `lheading`'s underline: `=` or `-` and then spaces only, so `===\t` is
// paragraph text and a later underline can still end the heading. The first
// one the paragraph reaches ends it, and the lexer decides whether another
// rule takes the lines first.
const UNDERLINE = /^ {0,3}(?:=+|-+) *$/;
// `lheading` cannot continue its paragraph across a whitespace-only line, a
// `#`, a fence or a quote, so no underline after one makes this block an H1.
const ENDS_SETEXT = /^(?:\s*$| {0,3}(?:#|`{3}|~{3}|>))/;

/** True or false when the lines decide it, or the lines to lex when an underline might. */
export function opensWithH1(markdown: string): boolean | string {
  let start = -1;
  let at = 0;
  for (;;) {
    LINE_END.lastIndex = at;
    const ending = LINE_END.exec(markdown);
    const end = ending ? ending.index : markdown.length;
    const line = markdown.slice(at, end);
    if (start === -1) {
      if (!SPACE.test(line)) {
        const atx = ATX_HEADING.exec(line);
        if (atx) return atx[1]!.length === 1;
        if (NEVER_A_HEADING.test(line)) return false;
        start = at;
      }
    } else {
      if (UNDERLINE.test(line)) return markdown.slice(start, end);
      if (ENDS_SETEXT.test(line)) return false;
    }
    if (!ending) return false;
    at = ending.index + ending[0].length;
  }
}

export function lexesAsH1(lexer: typeof Lexer, markdown: string): boolean {
  const first = lexer.lex(markdown).find((token) => token.type !== "space");
  return first?.type === "heading" && first.depth === 1;
}
