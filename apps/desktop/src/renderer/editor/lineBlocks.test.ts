import { describe, expect, it } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { blockIndexForLine } from "./lineBlocks";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  markdownToYDoc,
} from "./import-export";

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

  it("only drops a definition where the tokenizer resolves one", () => {
    // No label, no destination, and four columns of indent are all content.
    expect(blockIndexForLine("Intro\n\n[]: https://a.com\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n[a]:\n\nAfter", 5)).toBe(2);
    expect(blockIndexForLine("Intro\n\n    [a]: https://a.com\n\nAfter", 5)).toBe(2);
    // Inside an OPEN paragraph it is that paragraph's own text, not metadata.
    expect(blockIndexForLine("Intro\n[a]: https://a.com\n\nAfter", 4)).toBe(1);
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
