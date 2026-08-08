import { describe, expect, it } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { blockTargetForLine, intraBlockRange } from "./intraBlock";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  markdownToYDoc,
} from "./import-export";

// The refinement is measured against the editor's OWN parse, the way
// lineBlocks.test.ts measures the block rules: `markdownToYDoc` is what builds
// the Y.Doc the engine editor binds to, so the nodes below are the nodes a
// reader would be looking at. Nothing here is a hand-built fixture.
function editorDoc(body: string) {
  return yXmlFragmentToProseMirrorRootNode(
    getDohcYDocBodyFragment(markdownToYDoc(body)),
    getDohcProseMirrorSchema(),
  );
}

/** The text a search hit on 1-based `line` reveals, or null when the reveal
 *  drops to the block start. This is the whole seam: the target FileInspector
 *  sends, resolved the way MarkdownEditor's scrollToBlock resolves it. */
function revealed(body: string, line: number): string | null {
  const doc = editorDoc(body);
  const target = blockTargetForLine(body, line);
  const index = Math.min(Math.max(target.index, 0), doc.childCount - 1);
  if (index !== target.index || !target.match) return null;
  let pos = 0;
  for (let before = 0; before < index; before += 1) pos += doc.child(before).nodeSize;
  const range = intraBlockRange(doc.child(index), pos, target.match);
  return range ? doc.textBetween(range.from, range.to, "\n") : null;
}

const items = (count: number, marker: (item: number) => string) =>
  Array.from({ length: count }, (_, item) => marker(item + 1));

describe("a match deep in a long block lands the matched line", () => {
  // 1 "Intro"  2 ""  3.. "- Item 1" .. "- Item 100"  103 ""  104 "After"
  const LONG_LIST = ["Intro", "", ...items(100, (n) => `- Item ${n}`), "", "After"]
    .join("\n");

  it("lands the ninetieth item of a hundred-item bullet list", () => {
    // MUTATION: return null from listItemRange (or from intraBlockRange
    // outright) -> null here, which is the reveal landing on "Item 1" again.
    expect(revealed(LONG_LIST, 92)).toBe("Item 90");
    expect(revealed(LONG_LIST, 102)).toBe("Item 100");
  });

  it("lands an item of an ordered list and of a checklist", () => {
    const ordered = items(60, (n) => `${n}. Step ${n}`).join("\n");
    expect(revealed(ordered, 47)).toBe("Step 47");
    const checklist = items(40, (n) => `- [ ] Task ${n}`).join("\n");
    expect(revealed(checklist, 31)).toBe("Task 31");
  });

  it("rejects a same-count list whose matched child holds different text", () => {
    const body = "1. x\n- a\n```\n1. x";
    const doc = editorDoc(body);
    const list = doc.child(0);
    expect(blockTargetForLine(body, 2)).toEqual({
      index: 0,
      match: { lines: ["1. x", "- a"], offset: 1 },
    });
    expect(list.type.name).toBe("orderedList");
    expect(list.childCount).toBe(2);
    expect(list.child(0).textContent).toBe("xa");
    expect(list.child(1).textContent).toBe("x");
    expect(revealed(body, 2)).toBeNull();
  });

  it("lands the item above a blank line inside the list", () => {
    // The same rule one level down: a line in a gap resolves to the thing
    // ABOVE it. A loose list keeps its blank lines, and a hit that lands on
    // one shows the reader the item it follows.
    const loose = ["- Item 1", "", "- Item 2", "", "- Item 3"].join("\n");
    expect(revealed(loose, 4)).toBe("Item 2");
  });

  it("lands the item a continuation line belongs to, not the line", () => {
    // 1 "- Item one"  2 "  wrapped"  3 "- Item two"  4 "  wrapped too"
    const body = "- Item one\n  wrapped\n- Item two\n  wrapped too";
    const landing = revealed(body, 4);
    expect(landing).toContain("Item two");
    expect(landing).not.toContain("Item one");
  });

  // 1 "```ts"  2.. 300 code lines  302 "```"  303 ""  304 "After"
  const LONG_FENCE = [
    "```ts",
    ...items(300, (n) => `const value${n} = ${n};`),
    "```",
    "",
    "After",
  ].join("\n");

  it("lands the matched line of a three-hundred-line fenced block", () => {
    // MUTATION: return null from codeLineRange -> null here, which is the
    // reveal landing on the opening fence with the match 250 lines below it.
    expect(revealed(LONG_FENCE, 251)).toBe("const value250 = 250;");
    expect(revealed(LONG_FENCE, 2)).toBe("const value1 = 1;");
    expect(revealed(LONG_FENCE, 301)).toBe("const value300 = 300;");
  });

  it("counts a fence's own blank and heading-shaped lines as its text", () => {
    // A fence's contents are inert to the block rules, and to these: line 4
    // is code that looks like a heading, and the blank line above it does not
    // shift the count.
    const body = "```\nfirst\n\n# not a heading\nlast\n```";
    expect(revealed(body, 4)).toBe("# not a heading");
    expect(revealed(body, 5)).toBe("last");
  });

  it("lands inside a fence indented by its opener", () => {
    const body = [
      "Intro",
      "",
      "  ```ts",
      "  const a = 1;",
      "  const b = 2;",
      "  const target = 3;",
      "  ```",
      "",
      "After",
    ].join("\n");
    expect(revealed(body, 6)).toBe("const target = 3;");
  });
});

describe("an unsure intra-block match falls back to the block start", () => {
  const unsure: ReadonlyArray<{ name: string; body: string; line: number }> = [
    {
      name: "the matched line is the block's own first line",
      body: ["- Item 1", "- Item 2", "- Item 3"].join("\n"),
      line: 1,
    },
    {
      name: "the matched line is the fence's opener",
      body: "```\nalpha\nbeta\n```",
      line: 1,
    },
    {
      name: "an INDENTED code block, whose text the parse strips",
      body: ["Intro", "", "    alpha", "    beta", "    gamma"].join("\n"),
      line: 4,
    },
    {
      name: "a fenced block's matched line is empty",
      body: "```\nalpha\n\ngamma\n```",
      line: 3,
    },
    {
      name: "a long quote, which no rule here maps onto its children",
      body: ["> one", "> two", "> three", "> four"].join("\n"),
      line: 3,
    },
    {
      name: "a table",
      body: ["| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n"),
      line: 4,
    },
    {
      name: "a paragraph, whose lines are one node",
      body: ["one", "two", "three"].join("\n"),
      line: 3,
    },
    {
      name: "a heading",
      body: "# Title\nBody",
      line: 2,
    },
    {
      name: "a nested item, which belongs to the item the block opens with",
      // Three columns reaches inside `- `'s two-column content, so this line
      // is item ONE's own — and item one starts where the block does.
      body: ["- Item 1", "   - nested", "- Item 2"].join("\n"),
      line: 2,
    },
  ];

  for (const document of unsure) {
    it(document.name, () => {
      // MUTATION: drop the body equality in codeLineRange -> the indented
      // code case lands a line the parse never held. Dropping the count gate
      // in listItemRange shows up in the drift test below instead: these
      // documents all agree with the parse, which is why they are here.
      expect(revealed(document.body, document.line)).toBeNull();
    });
  }

  it("rejects a match whose lines no longer describe the node", () => {
    // The Y.Doc is canonical and the artifact search numbered can lag it. A
    // block target built from text the node no longer holds proves nothing.
    const doc = editorDoc("```\nalpha\nbeta\ngamma\n```");
    const drifted = { lines: ["```", "one", "two", "three", "```"], offset: 2 };
    expect(intraBlockRange(doc.child(0), 0, drifted)).toBeNull();

    const list = editorDoc("- a\n- b\n- c");
    expect(
      intraBlockRange(list.child(0), 0, { lines: ["- a", "- b"], offset: 1 }),
    ).toBeNull();
  });

  it("does not apply list rules to a blockquote container", () => {
    const quote = editorDoc("> - a\n>\n> * b").child(0);
    expect(quote.type.name).toBe("blockquote");
    expect(quote.childCount).toBe(2);
    expect(
      intraBlockRange(quote, 0, { lines: ["- a", "", "* b"], offset: 2 }),
    ).toBeNull();
  });
});

describe("blockTargetForLine", () => {
  it("slices the block's own lines and points at the matched one", () => {
    const body = "Intro\n\n- a\n- b\n- c\n\nAfter";
    expect(blockTargetForLine(body, 4)).toEqual({
      index: 1,
      match: { lines: ["- a", "- b", "- c", ""], offset: 1 },
    });
  });

  it("carries no match for a body with no block to slice", () => {
    // The #564 recovery path: the read failed, the Y.Doc bound anyway.
    expect(blockTargetForLine("", 3)).toEqual({ index: 0 });
  });
});
