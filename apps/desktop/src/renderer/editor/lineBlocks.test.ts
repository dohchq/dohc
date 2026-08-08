import { describe, expect, it } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { blockForLine, blockIndexForLine } from "./lineBlocks";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  markdownToYDoc,
} from "./import-export";

// The span is what lets a caller slice the block's own source and refine a
// landing inside it (#688). Same walk as the index, so the rules above hold
// it; these hold the boundaries the index never had to name.
describe("blockForLine", () => {
  it("spans the block from its first line to its last", () => {
    // 1 "First"  2 ""  3 "Second one"  4 "wrapped"  5 ""  6 "Third"
    const body = "First\n\nSecond one\nwrapped\n\nThird";
    expect(blockForLine(body, 1)).toEqual({ index: 0, startLine: 1, endLine: 2 });
    expect(blockForLine(body, 4)).toEqual({ index: 1, startLine: 3, endLine: 5 });
    expect(blockForLine(body, 6)).toEqual({ index: 2, startLine: 6, endLine: 6 });
  });

  it("spans a fenced block, blank lines and closing fence included", () => {
    // 1 "```"  2 "a"  3 ""  4 "b"  5 "```"  6 ""  7 "After"
    // Line 6 is the gap, and the span runs to the line before the next block
    // opens — the same rule the index has, where a gap line resolves to the
    // block above it.
    const body = "```\na\n\nb\n```\n\nAfter";
    expect(blockForLine(body, 4)).toEqual({ index: 0, startLine: 1, endLine: 6 });
  });

  it("names no start line above the first block, or in an empty body", () => {
    // MUTATION: drop the startLine guard in blockTargetForLine -> the slice
    // starts at -1 and the offset points at a line the block does not own.
    expect(blockForLine("\n\nText", 1).startLine).toBe(0);
    expect(blockForLine("", 4).startLine).toBe(0);
  });
});

describe("blockIndexForLine", () => {
  it("maps every line of a block to that block", () => {
    // 1 "First"        2 ""       3 "Second one"  4 "wrapped"
    // 5 ""             6 "Third"
    const body = "First\n\nSecond one\nwrapped\n\nThird";
    expect(blockIndexForLine(body, 1)).toBe(0);
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 4)).toBe(1);
    expect(blockIndexForLine(body, 6)).toBe(2);
  });

  it("resolves a blank line to the block above it and clamps past the end", () => {
    const body = "First\n\nSecond";
    expect(blockIndexForLine(body, 2)).toBe(0);
    expect(blockIndexForLine(body, 99)).toBe(1);
  });

  it("answers 0 for an empty body and for lines before the first block", () => {
    expect(blockIndexForLine("", 4)).toBe(0);
    expect(blockIndexForLine("\n\nText", 1)).toBe(0);
    expect(blockIndexForLine("Text", 0)).toBe(0);
    expect(blockIndexForLine("Text", -3)).toBe(0);
  });

  it("opens a block at a heading, and closes it after that one line", () => {
    // 1 "Intro text"   2 "## Plan"   3 "Body" — three nodes, no blank lines.
    const body = "Intro text\n## Plan\nBody";
    expect(blockIndexForLine(body, 1)).toBe(0);
    expect(blockIndexForLine(body, 2)).toBe(1);
    expect(blockIndexForLine(body, 3)).toBe(2);
  });

  it("keeps consecutive headings apart", () => {
    const body = "# One\n\n# Two\n\n# Three";
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 5)).toBe(2);
  });

  it("treats a fenced block's blank lines and markers as inert", () => {
    //  1 "Before"  2 ""  3 "```js"  4 "const a = 1;"  5 ""
    //  6 "# not a heading"  7 "```"  8 ""  9 "After"
    const body =
      "Before\n\n```js\nconst a = 1;\n\n# not a heading\n```\n\nAfter";
    expect(blockIndexForLine(body, 1)).toBe(0);
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 6)).toBe(1);
    expect(blockIndexForLine(body, 9)).toBe(2);
  });

  it("does not split a fence that is indented inside a list item", () => {
    // 1 "- item"  2 "  ```"  3 "  code"  4 "  ```"  5 ""  6 "After"
    const body = "- item\n  ```\n  code\n  ```\n\nAfter";
    expect(blockIndexForLine(body, 3)).toBe(0);
    expect(blockIndexForLine(body, 6)).toBe(1);
  });

  it("keeps a loose list one block and ends it at other content", () => {
    // 1 "- one"  2 ""  3 "- two"  4 ""  5 "Paragraph"
    const body = "- one\n\n- two\n\nParagraph";
    expect(blockIndexForLine(body, 3)).toBe(0);
    expect(blockIndexForLine(body, 5)).toBe(1);
  });

  it("splits a blank-separated quote, which a list does not do", () => {
    // CommonMark ends a block quote at an unquoted blank line. The oracle
    // below holds this against the real parser; this pins the rule directly.
    const body = "> one\n\n> two\n\nParagraph";
    expect(blockIndexForLine(body, 1)).toBe(0);
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 5)).toBe(2);
  });

  it("keeps a quote continued without a blank line as one block", () => {
    const body = "> one\n> two\n\nParagraph";
    expect(blockIndexForLine(body, 2)).toBe(0);
    expect(blockIndexForLine(body, 4)).toBe(1);
  });

  it("does not merge a bullet list into an ordered list", () => {
    const body = "- one\n\n1. two";
    expect(blockIndexForLine(body, 3)).toBe(1);
  });

  it("keeps a setext heading with its own text", () => {
    // 1 "Title"  2 "====="  3 ""  4 "Body"
    const body = "Title\n=====\n\nBody";
    expect(blockIndexForLine(body, 2)).toBe(0);
    expect(blockIndexForLine(body, 4)).toBe(1);
  });

  it("ends a setext heading at its underline, blank line or not", () => {
    // 1 "Title"  2 "====="  3 "Matched body" — two nodes, like an ATX
    // heading. A lone `-` underlines too, and is not a bullet here.
    expect(blockIndexForLine("Title\n=====\nMatched body", 3)).toBe(1);
    expect(blockIndexForLine("Title\n-\nMatched body", 3)).toBe(1);
    expect(blockIndexForLine("Title\n===  \nMatched body", 3)).toBe(1);
  });

  it("does not read a rule or a table divider as a setext underline", () => {
    // No paragraph is open above either one, so both open their own block.
    expect(blockIndexForLine("Para\n\n---\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("| a |\n| --- |\n| b |\n\nAfter", 5)).toBe(1);
  });

  it("gives a thematic break its own one-line block", () => {
    // 1 "Intro"  2 ""  3 "---"  4 "Matched" — three nodes. All three markers
    // read the same way, and the spaced form is a break, not a one-item list.
    for (const marker of ["---", "***", "___", "- - -", "-----"]) {
      const body = `Intro\n\n${marker}\nMatched`;
      expect(blockIndexForLine(body, 3)).toBe(1);
      expect(blockIndexForLine(body, 4)).toBe(2);
    }
    // Two markers is a paragraph, which the next line continues.
    expect(blockIndexForLine("Intro\n\n--\nMatched", 4)).toBe(1);
  });

  it("keeps the setext underline ahead of the thematic break", () => {
    // Under an OPEN paragraph, `-` and `=` runs underline it. `*` and `_`
    // cannot, so they stay breaks even there.
    expect(blockIndexForLine("Intro\n---\nMatched", 3)).toBe(1);
    expect(blockIndexForLine("Intro\n-----\nMatched", 3)).toBe(1);
    expect(blockIndexForLine("Intro\n***\nMatched", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n***\nMatched", 3)).toBe(2);
    // Nothing else is open, so the break is a break under any other kind.
    expect(blockIndexForLine("# H\n---\nMatched", 2)).toBe(1);
    expect(blockIndexForLine("> q\n---\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- item\n---\nAfter", 2)).toBe(1);
  });

  it("starts a block where a list or a quote interrupts a paragraph", () => {
    expect(blockIndexForLine("Intro\n- matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n* matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n+ matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n> matched\n\nAfter", 2)).toBe(1);
    // An ordered list interrupts only when it counts from 1.
    expect(blockIndexForLine("Intro\n1. matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n1) matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n2. matched\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("Intro\n10. matched\n\nAfter", 2)).toBe(0);
  });

  it("starts a new list when the KIND changes, with no blank line", () => {
    expect(blockIndexForLine("- one\n1. matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- one\n2. matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- one\n1) matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("1) one\n- matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("1) a\n1. b", 2)).toBe(1);
    // A `.`-ordered list absorbs whatever list line follows it, the same
    // leniency that gives it a one-column continuation indent.
    expect(blockIndexForLine("1. one\n- matched\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("1. a\n1) b", 2)).toBe(0);
    // Indented, it is a nested list and stays in the item.
    expect(blockIndexForLine("- one\n  1. matched\n\nAfter", 2)).toBe(0);
  });

  it("reads a callout header only when it is complete", () => {
    // A complete header ends the lazy continuation at a quoted heading; an
    // unclosed one is an ordinary blockquote, which absorbs the same line.
    expect(blockIndexForLine("> [!note]\n> # T\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> [!note]-\n> # T\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> [!note] Title\n> # T\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> [!oops\n> # T\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("> [!]\n> # T\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("> [note]\n> # T\nMatched\n\nAfter", 3)).toBe(0);
  });

  it("counts indent in COLUMNS, so a tab reaches code depth", () => {
    // `   \t` and `\t` both reach column four, where four literal spaces do.
    for (const prefix of ["\t", " \t", "  \t", "   \t", "    "]) {
      const body = `| A |\n| --- |\n| r |\n${prefix}matched\n\nAfter`;
      expect(blockIndexForLine(body, 4)).toBe(1);
    }
    // Three columns is still prose.
    expect(blockIndexForLine("Para\n\n   matched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("Para\n\n   # H\n\nAfter", 3)).toBe(1);
    // At four columns a marker is literal text, not the block it looks like.
    expect(blockIndexForLine("\t# H\n\tmore\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("\t- item\n\tmore\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("\t> q\n\tmore\n\nAfter", 2)).toBe(0);
  });

  it("does not let a list or a quote interrupt its own kind", () => {
    // The interrupt is a PARAGRAPH rule. These lines continue what is open.
    expect(blockIndexForLine("- one\n- two\n\nPara", 2)).toBe(0);
    expect(blockIndexForLine("1. one\n2. two\n\nPara", 2)).toBe(0);
    expect(blockIndexForLine("> one\n> two\n\nPara", 2)).toBe(0);
    expect(blockIndexForLine("Intro\n- a\n- b\n\nAfter", 3)).toBe(1);
    // A lone dash still underlines the paragraph above it, list or not.
    expect(blockIndexForLine("Intro\n-\nMatched", 3)).toBe(1);
    expect(blockIndexForLine("Intro\n-  \nAfter", 3)).toBe(1);
  });

  it("opens a block at a fence that interrupts a paragraph", () => {
    // 1 "Intro"  2 "~~~"  3 "matched"  4 "~~~"  5 "After" — three nodes.
    const body = "Intro\n~~~\nmatched\n~~~\nAfter";
    expect(blockIndexForLine(body, 1)).toBe(0);
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 5)).toBe(2);
  });

  it("ends a fenced block at its closing fence", () => {
    // A quote is open, not a paragraph, and the fence still interrupts it.
    const body = "> quote\n```\ncode\n```\nAfter";
    expect(blockIndexForLine(body, 1)).toBe(0);
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 5)).toBe(2);
  });

  it("keeps an indented code block whole across its own blank lines", () => {
    // 1 "    one"  2 ""  3 "    matched"  4 ""  5 "After" — two nodes.
    const body = "    one\n\n    matched\n\nAfter";
    expect(blockIndexForLine(body, 3)).toBe(0);
    expect(blockIndexForLine(body, 5)).toBe(1);
    // Consecutive blank lines do not break it either.
    expect(blockIndexForLine("    one\n\n\n    matched", 4)).toBe(0);
  });

  it("ends an indented code block where the indentation stops", () => {
    // No blank line: the code block ends at the first unindented line, which
    // opens its own block.
    expect(blockIndexForLine("    one\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("    one\n    two\nAfter\n\nEnd", 3)).toBe(1);
    expect(blockIndexForLine("    one\n- item\n\nAfter", 2)).toBe(1);
  });

  it("does not read an indented line under a paragraph as code", () => {
    // Three columns is not code, and four columns under an OPEN paragraph is
    // that paragraph's own continuation.
    expect(blockIndexForLine("Para\n\n   one\n\n   matched", 5)).toBe(2);
    expect(blockIndexForLine("Para\n    more\n\nAfter", 4)).toBe(1);
  });

  it("keeps content indented into a list item inside that list", () => {
    // 1 "- item"  2 ""  3 "  matched paragraph"  4 ""  5 "After"
    const body = "- item\n\n  matched paragraph\n\nAfter";
    expect(blockIndexForLine(body, 3)).toBe(0);
    expect(blockIndexForLine(body, 5)).toBe(1);
  });

  it("gives a display-math block one block, blank lines included", () => {
    // 1 "$$"  2 "x = 1"  3 ""  4 "y = 2"  5 "$$"  6 ""  7 "After" — the
    // editor renders ONE atomic mathBlock, so the inner blank starts nothing.
    const body = "$$\nx = 1\n\ny = 2\n$$\n\nAfter";
    expect(blockIndexForLine(body, 4)).toBe(0);
    expect(blockIndexForLine(body, 7)).toBe(1);
    // A one-line block interrupts a paragraph and ends on its own line.
    expect(blockIndexForLine("Intro\n$$x$$\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Intro\n$$x$$\nAfter", 3)).toBe(2);
    expect(blockIndexForLine("$$a$$\n$$b$$\nAfter", 3)).toBe(2);
  });

  it("only reads math where the tokenizer does", () => {
    // Indented, trailing text after the closer, and unclosed all stay text.
    expect(blockIndexForLine("Intro\n\n  $$x$$\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n$$x$$ trailing\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n$$x\n\nAfter", 5)).toBe(2);
  });

  it("ends a quote's lazy continuation at a quoted blank", () => {
    // 1 "> a"  2 ">"  3 "Matched" — the `>`-only line stops the quote from
    // swallowing line 3, which the editor renders as its own paragraph.
    expect(blockIndexForLine("> a\n>\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> a\n> \nMatched\n\nAfter", 3)).toBe(1);
    // Without one, an unquoted line still continues the quote.
    expect(blockIndexForLine("> a\nMatched\n\nAfter", 2)).toBe(0);
    // And the quote itself survives its own blank: `> b` is the same block.
    expect(blockIndexForLine("> a\n>\n> b\n\nAfter", 3)).toBe(0);
    // An UNQUOTED blank still splits one quote into two.
    expect(blockIndexForLine("> one\n\n> two\n\nAfter", 3)).toBe(1);
  });

  it("ends a callout's lazy continuation at any quoted block start", () => {
    // The callout tokenizer closes its continuable paragraph at a quoted
    // heading, list, break, nested quote or HTML — so the unquoted line
    // under one is a new top-level paragraph.
    for (const inner of ["# Title", "- item", "1. item", "---", "> deep", "<div>"]) {
      const body = `> [!note]\n> ${inner}\nMatched\n\nAfter`;
      expect(blockIndexForLine(body, 3)).toBe(1);
      expect(blockIndexForLine(body, 5)).toBe(2);
    }
    // A quoted paragraph still continues lazily, and a later quoted line is
    // still the same callout.
    expect(blockIndexForLine("> [!note]\n> body\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("> [!note]\n> # T\n> body\n\nAfter", 3)).toBe(0);
  });

  it("holds a plain quote's lazy continuation open past the same lines", () => {
    // A plain blockquote absorbs what a callout breaks on, which is why the
    // two cannot share one rule.
    for (const inner of ["# Title", "- item", "---", "<div>"]) {
      expect(blockIndexForLine(`> a\n> ${inner}\nMatched\n\nAfter`, 3)).toBe(0);
    }
    // A quoted FENCE ends it for either kind.
    expect(
      blockIndexForLine("> a\n> ```\n> code\n> ```\nMatched\n\nAfter", 5),
    ).toBe(1);
    expect(
      blockIndexForLine("> [!note]\n> ```\n> code\n> ```\nMatched\n\nAfter", 5),
    ).toBe(1);
  });

  it("reads a quoted fence by the contract of the quote it is in", () => {
    // A backtick in the info string is the whole difference: the callout
    // tokenizer opens a fence on it and stops absorbing, while an ordinary
    // blockquote leaves it as text and goes on absorbing.
    const bad = "> ```js`bad\n> body\nMatched\n\nAfter";
    expect(blockIndexForLine(`> [!note]\n${bad}`, 4)).toBe(1);
    expect(blockIndexForLine(`> a\n${bad}`, 4)).toBe(0);
    // A clean info string opens a fence for either, and both stop at it.
    const good = "> ```js\n> code\n> ```\nMatched\n\nAfter";
    expect(blockIndexForLine(`> [!note]\n${good}`, 5)).toBe(1);
    expect(blockIndexForLine(`> a\n${good}`, 5)).toBe(1);
    // The restriction is a BACKTICK fence's; a tilde fence takes the same
    // info string, so the two contracts agree there.
    const tilde = "> ~~~js`ok\n> code\n> ~~~\nMatched\n\nAfter";
    expect(blockIndexForLine(`> [!note]\n${tilde}`, 5)).toBe(1);
    expect(blockIndexForLine(`> a\n${tilde}`, 5)).toBe(1);
  });

  it("forms a table only when the header and delimiter agree", () => {
    // One column over two is prose, so the indented line under it is that
    // paragraph's own continuation rather than a code block.
    expect(blockIndexForLine("Intro\n--- | ---\n    matched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("Intro\n--- | ---\n\nAfter", 4)).toBe(1);
    // A header needs no pipe of its own — one column over one is a table.
    expect(blockIndexForLine("Intro\n| --- |\n    matched\n\nAfter", 3)).toBe(1);
    // They must agree on the column count too.
    expect(blockIndexForLine("A | B\n--- | --- | ---\n1 | 2\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("A | B | C\n--- | ---\n1 | 2\n\nAfter", 3)).toBe(0);
    // When they do agree it is a table, and a table row is not prose.
    expect(blockIndexForLine("A | B | C\n--- | --- | ---\n1 | 2\n\nAfter", 5)).toBe(1);
    expect(blockIndexForLine("| A |\n| --- |\n| r |\n    matched\n\nAfter", 4)).toBe(1);
  });

  it("counts an escaped pipe as cell text, not a column", () => {
    // `A \| B | C` is TWO cells, so it matches a two-column delimiter and the
    // pair is a table — which is what lets the indented line below it be a
    // code block instead of the paragraph's continuation.
    expect(blockIndexForLine("A \\| B | C\n--- | ---\n    matched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("A \\| B \\| C | D\n--- | ---\n1 | 2\n\nAfter", 3)).toBe(0);
    // An escaped BACKSLASH does not escape the pipe after it.
    expect(blockIndexForLine("A \\\\ B | C\n--- | ---\n1 | 2\n\nAfter", 3)).toBe(0);
    // A pipe in a code span is NOT protected — the tokenizer divides on it,
    // so this header is three cells over two and forms no table.
    expect(blockIndexForLine("A `x | y` B | C\n--- | ---\n    matched\n\nAfter", 3)).toBe(0);
  });

  it("rejects a fence opener that is already four columns in", () => {
    // `\t```” reaches column four, so the parser reads indented code and the
    // backticks are its text. The ``` below it is the real fence.
    const body = "Para\n\n\t```\ncode\n```\n\nAfter";
    expect(blockIndexForLine(body, 3)).toBe(1);
    expect(blockIndexForLine(body, 4)).toBe(2);
    expect(blockIndexForLine(body, 5)).toBe(3);
    // Under an OPEN paragraph the same line is that paragraph's own text.
    expect(blockIndexForLine("Intro\n\t```\ncode\nAfter", 4)).toBe(0);
    // A tab anywhere in the prefix lands on four, spaces or not.
    expect(blockIndexForLine("Para\n\n \t```\ncode\n```\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("Para\n\n\t~~~\ncode\n~~~\n\nAfter", 3)).toBe(1);
  });

  it("closes a fence at three columns, and not at four", () => {
    // The closer answers to the same column rule the opener does. Up to three
    // columns ends the block; at four the line is the block's own text and
    // the fence runs on to the end of the document.
    for (const indent of ["", " ", "  ", "   "]) {
      expect(blockIndexForLine(`Para\n\n\`\`\`\ncode\n${indent}\`\`\`\n\nAfter`, 7)).toBe(2);
    }
    for (const indent of ["    ", "\t", " \t", "   \t"]) {
      expect(blockIndexForLine(`Para\n\n\`\`\`\ncode\n${indent}\`\`\`\n\nAfter`, 7)).toBe(1);
    }
    // A tab-indented closer is code, so the NEXT unindented one really ends it.
    expect(blockIndexForLine("Para\n\n```\ncode\n\t```\nmore\n```\n\nAfter", 9)).toBe(2);
    expect(blockIndexForLine("Para\n\n~~~\ncode\n\t~~~\n\nAfter", 7)).toBe(1);
  });

  it("measures continuation indent from the item's own marker", () => {
    // `- item` wants two columns; `-    item` wants five, so two is a new
    // block under the wider marker and the same two columns still work under
    // the narrow one.
    expect(blockIndexForLine("- item\n\n  para\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("-    item\n\n  para\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("-    item\n\n     para\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("-  item\n\n  para\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("-  item\n\n   para\n\nAfter", 3)).toBe(0);
    // A tab takes the marker to column four.
    expect(blockIndexForLine("-\titem\n\n  para\n\nAfter", 3)).toBe(1);
    // Without a blank line it is the same column that decides.
    expect(blockIndexForLine("-    item\n  para\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- item\n  para\n\nAfter", 2)).toBe(0);
    // The ACTIVE item sets the column, so a wider later item moves it.
    expect(blockIndexForLine("- a\n\n-    b\n\n  para\n\nAfter", 5)).toBe(1);
  });

  it("lets the OUTER item keep the continuation column past a nested one", () => {
    // The nested item sits inside the outer item's content, so it must not
    // raise the column the outer list continues at.
    expect(blockIndexForLine("- outer\n  - nested\n\n  matched\n\nAfter", 4)).toBe(0);
    expect(blockIndexForLine("- outer\n  - a\n    - b\n\n  matched\n\nAfter", 5)).toBe(0);
    expect(blockIndexForLine("- outer\n  -    nested\n\n  matched\n\nAfter", 4)).toBe(0);
    // The outer column still governs, so content short of it still breaks out.
    expect(
      blockIndexForLine("-    outer\n     - nested\n\n  matched\n\nAfter", 4),
    ).toBe(1);
    // A SIBLING at the top level does move it (round 7).
    expect(blockIndexForLine("- a\n\n-    b\n\n  para\n\nAfter", 5)).toBe(1);
  });

  it("ends an open list at a quote, but not at a table or display math", () => {
    expect(blockIndexForLine("- item\n> matched\n\nAfter", 2)).toBe(1);
    // A `.`-ordered list absorbs the quote, as it absorbs a following list.
    expect(blockIndexForLine("1. item\n> matched\n\nAfter", 2)).toBe(0);
    // A table and display math interrupt a PARAGRAPH only.
    expect(blockIndexForLine("- item\n$$x$$\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("- item\n| A |\n| --- |\n| r |\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("Intro\n$$x$$\nAfter", 2)).toBe(1);
    // Indented, all three are the item's own content.
    expect(blockIndexForLine("- item\n  > matched\n\nAfter", 2)).toBe(0);
  });

  it("takes any indent for a `.`-ordered item, and the column for `)`", () => {
    // Measured, not derived: the tokenizer keeps a one-column continuation
    // inside `1. item` but wants the content column under `1) item`.
    expect(blockIndexForLine("1. item\n\n para\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("1. item\n\npara\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("10. item\n\n   para\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("1) item\n\n  para\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("1) item\n\n   para\n\nAfter", 3)).toBe(0);
  });

  it("splits a CHECKLIST at a blank line, where a bullet list joins", () => {
    // A checklist is a taskList, a different node with the opposite rule.
    expect(blockIndexForLine("- [ ] a\n\n- [ ] b\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("- [ ] a\n\n- [ ] b\n\n- [ ] c\n\nAfter", 5)).toBe(2);
    // A bullet list still joins across one.
    expect(blockIndexForLine("- a\n\n- b\n\nAfter", 3)).toBe(0);
    // With no blank line the checklist is one node, mixed states and all.
    expect(blockIndexForLine("- [ ] a\n- [ ] b\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("- [ ] a\n- [x] b\n\nAfter", 2)).toBe(0);
    // Content indented to the item's column still continues it.
    expect(blockIndexForLine("- [ ] a\n\n  cont\n\nAfter", 3)).toBe(0);
  });

  it("treats a checkbox as part of a list's identity", () => {
    // Checkbox and no checkbox are different lists, blank line or not.
    expect(blockIndexForLine("- [ ] a\n- b\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- a\n- [ ] b\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- [ ] a\n\n- b\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("- a\n\n- [ ] b\n\nAfter", 3)).toBe(1);
  });

  it("reads a checkbox only where the tokenizer does", () => {
    // Both cases, and the bullet markers. An ORDERED item is never a task.
    for (const item of ["- [x]", "- [X]", "* [ ]", "+ [ ]"]) {
      expect(blockIndexForLine(`${item} a\n\n${item} b\n\nAfter`, 3)).toBe(1);
    }
    expect(blockIndexForLine("1. [ ] a\n\n2. [ ] b\n\nAfter", 3)).toBe(0);
    // The box needs a space or the line end after it, and only `x`/`X` in it.
    expect(blockIndexForLine("- [ ]a\n\n- [ ]b\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("- [y] a\n\n- [y] b\n\nAfter", 3)).toBe(0);
    // A checklist interrupts and is interrupted like the bullet list it
    // resembles.
    expect(blockIndexForLine("Intro\n- [ ] a\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("> intro\n- [ ] a\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("- [ ] a\n> q\n\nAfter", 2)).toBe(1);
    // Nested under a bullet it is that bullet's content.
    expect(blockIndexForLine("- a\n  - [ ] b\n\nAfter", 2)).toBe(0);
  });

  it("starts a new list when the marker changes", () => {
    expect(blockIndexForLine("- one\n\n* two\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("- one\n* two", 2)).toBe(1);
    expect(blockIndexForLine("- one\n+ two", 2)).toBe(1);
    expect(blockIndexForLine("- a\n\n* b\n\n- c\n\nAfter", 5)).toBe(2);
    // An ordered list's delimiter counts the same way across a blank line.
    expect(blockIndexForLine("1. a\n\n2) b\n\nAfter", 3)).toBe(1);
    // The same marker still resumes, and an indented one is a nested list.
    expect(blockIndexForLine("- one\n\n- two\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("1. a\n\n2. b\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("- a\n\n  * b\n\nAfter", 3)).toBe(0);
  });

  it("counts no block for a link reference definition", () => {
    // The definition renders nothing, so it must not shift what follows.
    const body = "Intro\n\n[docs]: https://e.com\n\nAfter";
    expect(blockIndexForLine(body, 5)).toBe(1);
    // A hit ON the definition lands on the block above it, as any gap does.
    expect(blockIndexForLine(body, 3)).toBe(0);
    // Titles, on the line or under it, are part of the same invisible block.
    expect(blockIndexForLine('Intro\n\n[a]: https://a.com "T"\n\nAfter', 5)).toBe(1);
    expect(blockIndexForLine('Intro\n\n[a]: https://a.com\n  "T"\n\nAfter', 6)).toBe(1);
  });

  it("takes a definition whose destination sits on the next line", () => {
    // `[docs]:` then the destination under it renders no node either, so the
    // pair must not shift what follows.
    expect(blockIndexForLine("Intro\n\n[docs]:\n  https://e.com\n\nAfter", 6)).toBe(1);
    expect(blockIndexForLine("Intro\n\n[docs]:\nhttps://e.com\n\nAfter", 6)).toBe(1);
    // And a title under THAT is still the same invisible run.
    expect(
      blockIndexForLine('Intro\n\n[docs]:\n  https://e.com\n  "T"\n\nAfter', 7),
    ).toBe(1);
    // A bare label with nothing under it is ordinary text.
    expect(blockIndexForLine("Intro\n\n[docs]:\n\nAfter", 5)).toBe(2);
  });

  it("ends a quote's lazy continuation at an unquoted block marker", () => {
    // The reverse of a list being ended BY a quote: an unquoted list marker
    // under a lazily-continuing quote starts its own block.
    expect(blockIndexForLine("> intro\n- matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("> intro\n* matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("> intro\n1. matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("> intro\n<div>\n\nAfter", 2)).toBe(1);
    // Measured apart from the quoted-body break set: a CALLOUT breaks on any
    // ordered number, a plain quote only on one that counts from 1.
    expect(blockIndexForLine("> intro\n2. matched\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("> [!note]\n2. matched\n\nAfter", 2)).toBe(1);
    // A callout header followed straight by a marker ends there too.
    expect(blockIndexForLine("> [!note]\n- matched\n\nAfter", 2)).toBe(1);
    // Both absorb display math, indented code and plain text.
    expect(blockIndexForLine("> intro\n$$x$$\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("> [!note]\n$$x$$\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("> intro\n    code\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("> intro\nmore text\n\nAfter", 2)).toBe(0);
  });

  it("strips the quote prefix the tokenizer strips, and no more", () => {
    // One SPACE after `>`, never a tab: `>\t# T` keeps its tab, which four
    // columns in is code rather than a heading, so the callout reads on.
    expect(blockIndexForLine("> [!note]\n>\t# T\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("> [!note]\n>\t- item\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("> [!note]\n> \t# T\nMatched\n\nAfter", 3)).toBe(0);
    // A space after `>` is stripped, so these DO break.
    expect(blockIndexForLine("> [!note]\n> # T\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> [!note]\n># T\nMatched\n\nAfter", 3)).toBe(1);
    // Spaces before `>` up to three keep it a quoted line; a tab does not,
    // so that line is unquoted content the callout absorbs.
    expect(blockIndexForLine("> [!note]\n   > # T\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> [!note]\n\t> # T\nMatched\n\nAfter", 3)).toBe(0);
  });

  it("breaks a callout on HTML only where the tokenizer does", () => {
    expect(blockIndexForLine("> [!note]\n> <div>\nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("> [!note]\n>    <div>\nMatched\n\nAfter", 3)).toBe(1);
    // A tab, or four columns of spaces, is content rather than a block start.
    expect(blockIndexForLine("> [!note]\n>\t<div>\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("> [!note]\n>     <div>\nMatched\n\nAfter", 3)).toBe(0);
  });

  it("counts a line blank only when it is spaces", () => {
    // A tab-only line and a non-breaking space are NOT blank here, so the
    // paragraph runs through them.
    expect(blockIndexForLine("First\n\t\nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("First\n \nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("First\n  \nMatched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("First\n\f\nMatched\n\nAfter", 3)).toBe(0);
    // Spaces alone still end it.
    expect(blockIndexForLine("First\n   \nMatched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("First\n\nMatched\n\nAfter", 3)).toBe(1);
    // And a quote is not split by one either.
    expect(blockIndexForLine("> a\n \n> b\n\nAfter", 3)).toBe(0);
  });

  it("does not underline a paragraph from four columns in", () => {
    // `\t===` reaches column four, so it is the paragraph's own text and the
    // paragraph runs on. Three columns still underlines.
    expect(blockIndexForLine("Title\n\t===\nBody", 3)).toBe(0);
    expect(blockIndexForLine("Title\n\t---\nBody", 3)).toBe(0);
    expect(blockIndexForLine("Title\n \t===\nBody", 3)).toBe(0);
    expect(blockIndexForLine("Title\n   ===\nBody", 3)).toBe(1);
    expect(blockIndexForLine("Title\n===\nBody", 3)).toBe(1);
  });

  it("reads a table and a definition in COLUMNS like everything else", () => {
    // The last two patterns that counted prefix CHARACTERS. Four columns in,
    // both rows of a table and a definition's label are indented code.
    expect(blockIndexForLine("Intro\n\n\t| A |\n\t| --- |\n\t| r |\n\nAfter", 7)).toBe(2);
    expect(blockIndexForLine("Intro\n\n\t| A |\n| --- |\n| r |\n\nAfter", 4)).toBe(2);
    expect(blockIndexForLine("Intro\n\n| A |\n\t| --- |\n| r |\n\nAfter", 7)).toBe(2);
    expect(blockIndexForLine("Intro\n\n\t[a]: https://e.com\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("Intro\n\n\t[a]:\n\thttps://e.com\n\nAfter", 3)).toBe(1);
    // Three columns is still a table and still a definition.
    expect(blockIndexForLine("Intro\n\n   | A |\n   | --- |\n   | r |\n\nAfter", 7)).toBe(2);
    expect(blockIndexForLine("Intro\n\n   [a]: https://e.com\n\nAfter", 5)).toBe(1);
    // The kinds guarded earlier stay guarded: a tab makes each of these code.
    for (const marker of ["# H", "- item", "1. item", "> q", "---"]) {
      expect(blockIndexForLine(`Intro\n\n\t${marker}\n\nAfter`, 5)).toBe(2);
    }
  });

  it("hides a definition only when its destination parses", () => {
    // An unparseable destination is a PARAGRAPH, and hiding it would shift
    // every block after it.
    expect(blockIndexForLine("Intro\n\n[docs]: <broken\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n[docs]: foo bar\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n[docs]: https://e.com 'unclosed\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n[docs]: https://e.com junk\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n[docs]:\n  <broken\n\nAfter", 6)).toBe(2);
    // The forms that DO parse still render nothing.
    expect(blockIndexForLine("Intro\n\n[docs]: https://e.com\n\nAfter", 5)).toBe(1);
    expect(blockIndexForLine("Intro\n\n[docs]: <https://e.com>\n\nAfter", 5)).toBe(1);
    // Angle brackets may hold spaces where a bare destination may not.
    expect(blockIndexForLine("Intro\n\n[docs]: <foo bar>\n\nAfter", 5)).toBe(1);
    expect(blockIndexForLine('Intro\n\n[docs]: https://e.com "T"\n\nAfter', 5)).toBe(1);
    expect(blockIndexForLine("Intro\n\n[docs]: https://e.com (T)\n\nAfter", 5)).toBe(1);
  });

  it("only drops a definition where the tokenizer resolves one", () => {
    // No label, no destination, and four columns of indent are all content.
    expect(blockIndexForLine("Intro\n\n[]: https://a.com\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n[a]:\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n    [a]: https://a.com\n\nAfter", 5)).toBe(2);
    // Inside an OPEN paragraph it is that paragraph's own text, not metadata.
    expect(blockIndexForLine("Intro\n[a]: https://a.com\n\nAfter", 4)).toBe(1);
  });

  it("keeps a heading indented into a list item inside that item", () => {
    // The list is ONE node, so a heading indented into it opens nothing.
    expect(blockIndexForLine("- item\n\n  # matched\n\nAfter", 3)).toBe(0);
    expect(blockIndexForLine("- item\n\n  # matched\n\nAfter", 5)).toBe(1);
    expect(blockIndexForLine("- item\n  # matched\n\nAfter", 2)).toBe(0);
    expect(blockIndexForLine("1. item\n\n   # matched\n\nAfter", 3)).toBe(0);
  });

  it("still opens a block at a heading that is not in a list item", () => {
    // Unindented, the heading ends the list — the direction that must keep
    // working. Nothing else keeps a heading either: only a list item does.
    expect(blockIndexForLine("- item\n\n# matched\n\nAfter", 3)).toBe(1);
    expect(blockIndexForLine("- item\n# matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("> q\n  # matched\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("Para\n  # matched\n\nAfter", 2)).toBe(1);
  });

  it("reads a table as its own block, not as a paragraph", () => {
    // A table ROW is not paragraph text: an indented line under one starts a
    // code block, where the same line under a paragraph continues it.
    const body = "| A |\n| --- |\n| row |\n    matched\n\nAfter";
    expect(blockIndexForLine(body, 4)).toBe(1);
    expect(blockIndexForLine(body, 6)).toBe(2);
    expect(blockIndexForLine("Para\n    more\n\nAfter", 2)).toBe(0);
    // A table interrupts a paragraph, and a plain line under one stays in it.
    expect(blockIndexForLine("Intro\n| A |\n| --- |\n| row |\n\nAfter", 2)).toBe(1);
    expect(blockIndexForLine("| A |\n| --- |\n| row |\nAfter", 4)).toBe(0);
    // The delimiter row is what makes it a table. Without one it is prose,
    // and the indented line below is that paragraph's own continuation.
    expect(blockIndexForLine("| A |\n| row |\n    matched\n\nAfter", 3)).toBe(0);
  });

  it("reads CRLF documents with the same line numbers", () => {
    const body = "First\r\n\r\nSecond\r\n\r\nThird";
    expect(blockIndexForLine(body, 5)).toBe(2);
  });
});

/** The top-level nodes the engine editor actually shows for this Markdown.
 *  `markdownToYDoc` BUILDS the Y.Doc the editor binds to, so this is the
 *  editor's own parse rather than a stand-in — which is the point: the
 *  mapping's only job is to agree with it. */
function editorBlocks(body: string): string[] {
  const root = yXmlFragmentToProseMirrorRootNode(
    getDohcYDocBodyFragment(markdownToYDoc(body)),
    getDohcProseMirrorSchema(),
  );
  const texts: string[] = [];
  // An ATOM (display math) carries no text children — what it shows the
  // reader is its `tex` attribute, so read that when there is no text.
  root.forEach((node) =>
    texts.push(node.textContent || String(node.attrs?.tex ?? "")),
  );
  return texts;
}

// Every rule the splitter claims, held against the real parser instead of
// against CommonMark read from memory. This is where the quote rule came
// from: `> one\n\n> two` parses as TWO blockquotes while `- one\n\n- two`
// parses as ONE loose list, and the splitter guessed they behaved alike.
describe("blockIndexForLine agrees with the editor's own parse", () => {
  const documents: ReadonlyArray<{
    name: string;
    body: string;
    lands: ReadonlyArray<[line: number, blockText: string]>;
  }> = [
    {
      name: "paragraphs",
      body: "First\n\nSecond one\nwrapped\n\nThird",
      lands: [
        [1, "First"],
        [4, "wrapped"],
        [6, "Third"],
      ],
    },
    {
      name: "a loose list is one node",
      body: "- one\n\n- two\n\nParagraph",
      lands: [
        [3, "two"],
        [5, "Paragraph"],
      ],
    },
    {
      name: "a blank-separated quote is two nodes",
      body: "> one\n\n> two\n\nParagraph",
      lands: [
        [1, "one"],
        [3, "two"],
        [5, "Paragraph"],
      ],
    },
    {
      name: "a heading interrupts a paragraph",
      body: "Intro text\n## Plan\nBody",
      lands: [
        [1, "Intro text"],
        [2, "Plan"],
        [3, "Body"],
      ],
    },
    {
      name: "a fence swallows its blank lines",
      body: "Before\n\n```js\nconst a = 1;\n\n# not a heading\n```\n\nAfter",
      lands: [
        [1, "Before"],
        [6, "const a = 1;"],
        [9, "After"],
      ],
    },
    {
      name: "a fence inside a list item does not split it",
      body: "- item\n  ```\n  code\n  ```\n\nAfter",
      lands: [
        [3, "item"],
        [6, "After"],
      ],
    },
    {
      name: "a setext heading keeps its own text",
      body: "Title\n=====\n\nBody",
      lands: [
        [2, "Title"],
        [4, "Body"],
      ],
    },
    {
      name: "a loose ordered list is one node",
      body: "1. one\n\n2. two\n\nPara",
      lands: [
        [3, "two"],
        [5, "Para"],
      ],
    },
    {
      name: "a setext underline ends the heading without a blank line",
      body: "Title\n=====\nMatched body",
      lands: [
        [2, "Title"],
        [3, "Matched body"],
      ],
    },
    {
      name: "a lone dash underlines a setext heading",
      body: "Title\n-\nMatched body",
      lands: [
        [2, "Title"],
        [3, "Matched body"],
      ],
    },
    {
      name: "a list opens straight under a setext heading",
      body: "Title\n=====\n- item\n\nAfter",
      lands: [
        [2, "Title"],
        [3, "item"],
        [5, "After"],
      ],
    },
    {
      name: "a thematic break is its own node, not an underline",
      body: "Para\n\n---\n\nAfter",
      lands: [
        [1, "Para"],
        [5, "After"],
      ],
    },
    {
      name: "a table divider is not an underline",
      body: "| a |\n| --- |\n| b |\n\nAfter",
      lands: [
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "content indented into a list item stays in that list",
      body: "- item\n\n  matched paragraph\n\nAfter",
      lands: [
        [3, "matched paragraph"],
        [5, "After"],
      ],
    },
    {
      name: "an indented continuation and a later item are one list",
      body: "- item\n\n  para\n\n- two\n\nAfter",
      lands: [
        [3, "para"],
        [5, "two"],
        [7, "After"],
      ],
    },
    {
      name: "an ordered item's continuation stays in that list",
      body: "1. item\n\n   matched paragraph\n\nAfter",
      lands: [
        [3, "matched paragraph"],
        [5, "After"],
      ],
    },
    {
      name: "an indented code block after a paragraph is its own node",
      body: "Para\n\n    code line\n\nAfter",
      lands: [
        [3, "code line"],
        [5, "After"],
      ],
    },
    {
      name: "a fence interrupts a paragraph and ends at its closing fence",
      body: "Intro\n~~~\nmatched\n~~~\nAfter",
      lands: [
        [1, "Intro"],
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "a fence interrupts a quote too",
      body: "> quote\n```\ncode\n```\n\nAfter",
      lands: [
        [1, "quote"],
        [3, "code"],
        [6, "After"],
      ],
    },
    {
      name: "a fence indented into a list item stays in that list",
      body: "- item\n\n  ```\n  code\n  ```\n\nAfter",
      lands: [
        [4, "code"],
        [7, "After"],
      ],
    },
    {
      name: "an unindented fence after a list ends the list",
      body: "- item\n\n```\ncode\n```\n\nAfter",
      lands: [
        [1, "item"],
        [4, "code"],
        [7, "After"],
      ],
    },
    {
      name: "an indented code block runs through its own blank lines",
      body: "    one\n\n    matched",
      lands: [
        [1, "one"],
        [3, "matched"],
      ],
    },
    {
      name: "an indented code block ends where the indentation stops",
      body: "Para\n\n    one\n\n    matched\n\nAfter",
      lands: [
        [1, "Para"],
        [5, "matched"],
        [7, "After"],
      ],
    },
    {
      name: "a list after an indented code block is its own node",
      body: "    one\n\n    matched\n\n- item\n\nAfter",
      lands: [
        [3, "matched"],
        [5, "item"],
        [7, "After"],
      ],
    },
    {
      name: "an indented code block ends at the first unindented line",
      body: "    one\n    two\nAfter\n\nEnd",
      lands: [
        [2, "two"],
        [3, "After"],
        [5, "End"],
      ],
    },
    {
      name: "a list straight under an indented code block is its own node",
      body: "    one\n- item\n\nAfter",
      lands: [
        [1, "one"],
        [2, "item"],
        [4, "After"],
      ],
    },
    {
      name: "a thematic break under an open paragraph",
      body: "Intro\n***\nMatched",
      lands: [
        [1, "Intro"],
        [3, "Matched"],
      ],
    },
    {
      name: "a setext underline still wins over a break",
      body: "Intro\n---\nMatched",
      lands: [
        [2, "Intro"],
        [3, "Matched"],
      ],
    },
    {
      name: "a break ends the block above it whatever that block is",
      body: "- item\n---\nAfter",
      lands: [
        [1, "item"],
        [3, "After"],
      ],
    },
    {
      name: "a spaced thematic break is not a one-item list",
      body: "- item\n\n- - -\n\nAfter",
      lands: [
        [1, "item"],
        [5, "After"],
      ],
    },
    {
      name: "a break indented into a list item stays in that list",
      body: "- item\n\n  ---\n\nAfter",
      lands: [
        [1, "item"],
        [5, "After"],
      ],
    },
    {
      name: "a bullet list interrupts a paragraph",
      body: "Intro\n- matched\n\nAfter",
      lands: [
        [1, "Intro"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a quote interrupts a paragraph",
      body: "Intro\n> matched\n\nAfter",
      lands: [
        [1, "Intro"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "an ordered list interrupts only when it counts from 1",
      body: "Intro\n1. matched\n\nAfter",
      lands: [
        [1, "Intro"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "an ordered list that does not count from 1 is paragraph text",
      body: "Intro\n2. matched\n\nAfter",
      lands: [
        [2, "2. matched"],
        [4, "After"],
      ],
    },
    {
      name: "an interrupting list keeps its own later items",
      body: "Intro\n- a\n- b\n\nAfter",
      lands: [
        [1, "Intro"],
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "a display-math block is one node across its blank lines",
      body: "$$\nx = 1\n\ny = 2\n$$\n\nAfter",
      lands: [
        [4, "y = 2"],
        [7, "After"],
      ],
    },
    {
      name: "a one-line math block interrupts a paragraph",
      body: "Intro\n$$x$$\nAfter",
      lands: [
        [1, "Intro"],
        [2, "x"],
        [3, "After"],
      ],
    },
    {
      name: "an indented $$ is not math",
      body: "Intro\n\n  $$x$$\n\nAfter",
      lands: [
        [3, "$$x$$"],
        [5, "After"],
      ],
    },
    {
      name: "an unclosed $$ is not math",
      body: "Intro\n\n$$x\n\nAfter",
      lands: [
        [3, "$$x"],
        [5, "After"],
      ],
    },
    {
      name: "a quoted blank ends the quote's lazy continuation",
      body: "> a\n>\nMatched\n\nAfter",
      lands: [
        [1, "a"],
        [3, "Matched"],
        [5, "After"],
      ],
    },
    {
      name: "a callout's quoted blank does the same",
      body: "> [!note]\n>\nMatched\n\nAfter",
      lands: [
        [3, "Matched"],
        [5, "After"],
      ],
    },
    {
      name: "a quote survives its own quoted blank",
      body: "> a\n>\n> b\n\nAfter",
      lands: [
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "a bullet marker change starts a new list",
      body: "- one\n\n* two\n\nAfter",
      lands: [
        [1, "one"],
        [3, "two"],
        [5, "After"],
      ],
    },
    {
      name: "a bullet marker change needs no blank line",
      body: "- one\n* two",
      lands: [
        [1, "one"],
        [2, "two"],
      ],
    },
    {
      name: "an ordered delimiter change starts a new list",
      body: "1. a\n\n2) b\n\nAfter",
      lands: [
        [1, "a"],
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "three lists, two marker changes",
      body: "- a\n\n* b\n\n- c\n\nAfter",
      lands: [
        [3, "b"],
        [5, "c"],
        [7, "After"],
      ],
    },
    {
      name: "a link reference definition renders no node",
      body: "Intro\n\n[docs]: https://e.com\n\nAfter",
      lands: [
        [1, "Intro"],
        [5, "After"],
      ],
    },
    {
      name: "a definition's title line goes with it",
      body: 'Intro\n\n[a]: https://a.com\n  "T"\n\nAfter',
      lands: [
        [1, "Intro"],
        [6, "After"],
      ],
    },
    {
      name: "a trailing cluster of definitions renders nothing",
      body: "Text\n\n[a]: https://a.com\n[b]: https://b.com",
      lands: [[1, "Text"]],
    },
    {
      name: "a definition inside a paragraph is that paragraph's text",
      body: "Intro\n[a]: https://a.com\n\nAfter",
      lands: [
        [2, "https://a.com"],
        [4, "After"],
      ],
    },
    {
      name: "a heading indented into a list item stays in that item",
      body: "- item\n\n  # matched\n\nAfter",
      lands: [
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "an unindented heading still ends the list",
      body: "- item\n\n# matched\n\nAfter",
      lands: [
        [1, "item"],
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "indented code starts under a table row",
      body: "| A |\n| --- |\n| row |\n    matched\n\nAfter",
      lands: [
        [3, "row"],
        [4, "matched"],
        [6, "After"],
      ],
    },
    {
      name: "a table interrupts a paragraph",
      body: "Intro\n| A |\n| --- |\n| row |\n\nAfter",
      lands: [
        [1, "Intro"],
        [4, "row"],
        [6, "After"],
      ],
    },
    {
      name: "a table without a delimiter row is prose",
      body: "| A |\n| row |\n    matched\n\nAfter",
      lands: [
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "a table needs no leading pipes",
      body: "A | B\n--- | ---\n1 | 2\n\nAfter",
      lands: [
        [3, "2"],
        [5, "After"],
      ],
    },
    {
      name: "a callout's lazy continuation ends at a quoted heading",
      body: "> [!note]\n> # Title\nMatched\n\nAfter",
      lands: [
        [3, "Matched"],
        [5, "After"],
      ],
    },
    {
      name: "a plain quote absorbs the same line",
      body: "> a\n> # Title\nMatched\n\nAfter",
      lands: [
        [3, "Matched"],
        [5, "After"],
      ],
    },
    {
      name: "a quoted fence ends the lazy continuation for either kind",
      body: "> a\n> ```\n> code\n> ```\nMatched\n\nAfter",
      lands: [
        [5, "Matched"],
        [7, "After"],
      ],
    },
    {
      name: "a wide marker wants its own continuation column",
      body: "-    item\n\n  para\n\nAfter",
      lands: [
        [1, "item"],
        [3, "para"],
        [5, "After"],
      ],
    },
    {
      name: "the same wide marker keeps content that reaches it",
      body: "-    item\n\n     para\n\nAfter",
      lands: [
        [3, "para"],
        [5, "After"],
      ],
    },
    {
      name: "a later wider item moves the continuation column",
      body: "- a\n\n-    b\n\n  para\n\nAfter",
      lands: [
        [3, "b"],
        [5, "para"],
        [7, "After"],
      ],
    },
    {
      name: "a tab takes the marker to column four",
      body: "-\titem\n\n  para\n\nAfter",
      lands: [
        [3, "para"],
        [5, "After"],
      ],
    },
    {
      name: "a `)`-ordered item wants its content column",
      body: "1) item\n\n  para\n\nAfter",
      lands: [
        [1, "item"],
        [3, "para"],
        [5, "After"],
      ],
    },
    {
      name: "a bullet list runs straight into an ordered one",
      body: "- one\n1. matched\n\nAfter",
      lands: [
        [1, "one"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a `)`-ordered list runs straight into a bullet one",
      body: "1) one\n- matched\n\nAfter",
      lands: [
        [1, "one"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a `.`-ordered list absorbs the list line under it",
      body: "1. one\n- matched\n\nAfter",
      lands: [
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "an ordered delimiter change needs no blank line",
      body: "1) a\n1. b",
      lands: [
        [1, "a"],
        [2, "b"],
      ],
    },
    {
      name: "an incomplete callout header is an ordinary quote",
      body: "> [!oops\n> # T\nMatched\n\nAfter",
      lands: [
        [3, "Matched"],
        [5, "After"],
      ],
    },
    {
      name: "a tab reaches code depth after a table row",
      body: "| A |\n| --- |\n| r |\n\tmatched\n\nAfter",
      lands: [
        [3, "r"],
        [4, "matched"],
        [6, "After"],
      ],
    },
    {
      name: "a marker four columns in is literal code",
      body: "\t# H\n\tmore\n\nAfter",
      lands: [
        [1, "# H"],
        [4, "After"],
      ],
    },
    {
      name: "a callout opens a fence a plain quote leaves as text",
      body: "> [!note]\n> ```js`bad\n> body\nMatched\n\nAfter",
      lands: [
        [4, "Matched"],
        [6, "After"],
      ],
    },
    {
      name: "the same lines in a plain quote stay one node",
      body: "> a\n> ```js`bad\n> body\nMatched\n\nAfter",
      lands: [
        [4, "Matched"],
        [6, "After"],
      ],
    },
    {
      name: "one column over two columns forms no table",
      body: "Intro\n--- | ---\n    matched\n\nAfter",
      lands: [
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "one column over one is a table, pipe in the header or not",
      body: "Intro\n| --- |\n    matched\n\nAfter",
      lands: [
        [1, "Intro"],
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "a header and delimiter that disagree on columns form no table",
      body: "A | B\n--- | --- | ---\n1 | 2\n\nAfter",
      lands: [
        [3, "1 | 2"],
        [5, "After"],
      ],
    },
    {
      name: "three columns over three is a table",
      body: "A | B | C\n--- | --- | ---\n1 | 2\n\nAfter",
      lands: [
        [1, "A"],
        [5, "After"],
      ],
    },
    {
      name: "an escaped pipe is cell text, so the columns still agree",
      body: "A \\| B | C\n--- | ---\n    matched\n\nAfter",
      lands: [
        [3, "matched"],
        [5, "After"],
      ],
    },
    {
      name: "a pipe in a code span still divides, so this forms no table",
      body: "A `x | y` B | C\n--- | ---\n    matched\n\nAfter",
      lands: [[5, "After"]],
    },
    {
      name: "a tab-indented fence is code, and the next fence is the real one",
      body: "Para\n\n\t```\ncode\n```\n\nAfter",
      lands: [
        [1, "Para"],
        [3, "```"],
        [4, "code"],
      ],
    },
    {
      name: "a tab-indented fence under a paragraph is that paragraph's text",
      body: "Intro\n\t```\ncode\nAfter",
      lands: [[4, "Intro"]],
    },
    {
      name: "a three-column closer still ends the fence",
      body: "Para\n\n```\ncode\n   ```\n\nAfter",
      lands: [
        [4, "code"],
        [7, "After"],
      ],
    },
    {
      name: "a tab-indented closer is the code block's own text",
      body: "Para\n\n```\ncode\n\t```\n\nAfter",
      lands: [
        [1, "Para"],
        [7, "```"],
      ],
    },
    {
      name: "the next unindented closer is the one that ends it",
      body: "Para\n\n```\ncode\n\t```\nmore\n```\n\nAfter",
      lands: [
        [6, "more"],
        [9, "After"],
      ],
    },
    {
      name: "a nested item does not move the outer continuation column",
      body: "- outer\n  - nested\n\n  matched\n\nAfter",
      lands: [
        [4, "matched"],
        [6, "After"],
      ],
    },
    {
      name: "two levels of nesting do not move it either",
      body: "- outer\n  - a\n    - b\n\n  matched\n\nAfter",
      lands: [
        [5, "matched"],
        [7, "After"],
      ],
    },
    {
      name: "a quote ends an open list",
      body: "- item\n> matched\n\nAfter",
      lands: [
        [1, "item"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a `.`-ordered list absorbs the quote under it",
      body: "1. item\n> matched\n\nAfter",
      lands: [
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "display math does not interrupt an open list",
      // The math lands INSIDE the list item, so line 2 belongs to the list —
      // whose top-level text is the item's, the atom carrying its own.
      body: "- item\n$$x$$\n\nAfter",
      lands: [
        [2, "item"],
        [4, "After"],
      ],
    },
    {
      name: "a definition's destination may sit on the next line",
      body: "Intro\n\n[docs]:\n  https://e.com\n\nAfter",
      lands: [
        [1, "Intro"],
        [6, "After"],
      ],
    },
    {
      name: "a bare label with nothing under it is ordinary text",
      body: "Intro\n\n[docs]:\n\nAfter",
      lands: [
        [3, "[docs]:"],
        [5, "After"],
      ],
    },
    {
      name: "an unquoted list marker ends a quote's lazy continuation",
      body: "> intro\n- matched\n\nAfter",
      lands: [
        [1, "intro"],
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a callout header followed straight by a marker ends there",
      body: "> [!note]\n- matched\n\nAfter",
      lands: [
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a plain quote absorbs an ordered list that does not count from 1",
      // Line 2 lands INSIDE the quote, whose text is "intro" and "matched"
      // run together — the count above is what says it was not split out.
      body: "> intro\n2. matched\n\nAfter",
      lands: [
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a callout breaks on that same line",
      body: "> [!note]\n2. matched\n\nAfter",
      lands: [
        [2, "matched"],
        [4, "After"],
      ],
    },
    {
      name: "a tab-indented underline underlines nothing",
      body: "Title\n\t===\nBody",
      lands: [[3, "Title"]],
    },
    {
      name: "a tab-indented table is code, not a table",
      body: "Intro\n\n\t| A |\n\t| --- |\n\t| r |\n\nAfter",
      lands: [
        [3, "| A |"],
        [7, "After"],
      ],
    },
    {
      name: "a tab-indented definition is code, not metadata",
      body: "Intro\n\n\t[a]: https://e.com\n\nAfter",
      lands: [
        [3, "[a]: https://e.com"],
        [5, "After"],
      ],
    },
    {
      name: "an unparseable destination leaves an ordinary paragraph",
      body: "Intro\n\n[docs]: <broken\n\nAfter",
      lands: [
        [3, "[docs]: <broken"],
        [5, "After"],
      ],
    },
    {
      name: "a bare destination may not carry spaces",
      body: "Intro\n\n[docs]: foo bar\n\nAfter",
      lands: [
        [3, "[docs]: foo bar"],
        [5, "After"],
      ],
    },
    {
      name: "an angle-bracketed destination may",
      body: "Intro\n\n[docs]: <foo bar>\n\nAfter",
      lands: [
        [1, "Intro"],
        [5, "After"],
      ],
    },
    {
      name: "a blank line splits a checklist",
      body: "- [ ] a\n\n- [ ] b\n\nAfter",
      lands: [
        [1, "a"],
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "and joins a bullet list",
      body: "- a\n\n- b\n\nAfter",
      lands: [
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "a checkbox appearing mid-list starts a new one",
      body: "- a\n- [ ] b\n\nAfter",
      lands: [
        [1, "a"],
        [2, "b"],
        [4, "After"],
      ],
    },
    {
      name: "and disappearing does too",
      body: "- [ ] a\n- b\n\nAfter",
      lands: [
        [1, "a"],
        [2, "b"],
        [4, "After"],
      ],
    },
    {
      name: "an ordered item is never a checklist",
      body: "1. [ ] a\n\n2. [ ] b\n\nAfter",
      lands: [
        [3, "b"],
        [5, "After"],
      ],
    },
    {
      name: "three columns is not an indented code block",
      body: "Para\n\n   one\n\n   matched\n\nAfter",
      lands: [
        [3, "one"],
        [5, "matched"],
        [7, "After"],
      ],
    },
  ];

  for (const document of documents) {
    it(document.name, () => {
      const blocks = editorBlocks(document.body);
      // MUTATION: let quotes resume across a blank line (or stop lists from
      // resuming) -> the counts disagree here and every later line slips.
      expect(blockIndexForLine(document.body, Number.MAX_SAFE_INTEGER) + 1).toBe(
        blocks.length,
      );
      for (const [line, blockText] of document.lands) {
        expect(blocks[blockIndexForLine(document.body, line)]).toContain(blockText);
      }
    });
  }
});
