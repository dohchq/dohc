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
  root.forEach((node) => texts.push(node.textContent));
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
