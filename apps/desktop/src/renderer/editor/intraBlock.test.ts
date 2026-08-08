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
  const range = intraBlockRange(
    doc.child(index),
    pos,
    target.match,
    (source) => editorDoc(source).textContent,
  );
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

  it("lands a bold list item, not the block start", () => {
    const body = items(40, (n) =>
      n === 20 ? "- **Beta** second" : `- Item ${n}`,
    ).join("\n");
    expect(revealed(body, 20)).toBe("Beta second");
  });

  it("lands a list item with a code span, not the block start", () => {
    const body = items(40, (n) =>
      n === 20 ? "- `code span` second" : `- Item ${n}`,
    ).join("\n");
    expect(revealed(body, 20)).toBe("code span second");
  });

  it("lands a linked list item, not the block start", () => {
    const body = items(40, (n) =>
      n === 20 ? "- [Beta](https://example.com) second" : `- Item ${n}`,
    ).join("\n");
    expect(revealed(body, 20)).toBe("Beta second");
  });

  it("lands an emphasized ordered-list item, not the block start", () => {
    const body = items(40, (n) =>
      n === 20 ? "20. *Beta* second" : `${n}. Item ${n}`,
    ).join("\n");
    expect(revealed(body, 20)).toBe("Beta second");
  });

  it("lands a bold task item, not the block start", () => {
    const body = items(40, (n) =>
      n === 20 ? "- [ ] **Beta** task" : `- [ ] Task ${n}`,
    ).join("\n");
    expect(revealed(body, 20)).toBe("Beta task");
  });

  it("lands a wikilink list item, not the block start", () => {
    const body = items(40, (n) =>
      n === 20 ? "- [[Beta]]" : `- Item ${n}`,
    ).join("\n");
    const landing = revealed(body, 20);
    expect(landing).not.toBeNull();
    expect(landing).toBe(editorDoc("[[Beta]]").textContent);
  });

  it("rejects a same-count list whose matched child holds different text", () => {
    const body = "1. x\n2. a";
    const target = blockTargetForLine(body, 2);
    const list = editorDoc("1. x\n2. b").child(0);
    expect(target).toEqual({
      index: 0,
      match: { lines: ["1. x", "2. a"], offset: 1 },
    });
    expect(list.type.name).toBe("orderedList");
    expect(list.childCount).toBe(2);
    expect(list.child(1).textContent).toBe("b");
    expect(
      intraBlockRange(list, 0, target.match!, (source) =>
        editorDoc(source).textContent,
      ),
    ).toBeNull();
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

  it("lands a fenced-code line nested under a later list item", () => {
    const codeLines = items(300, (n) => `const value${n} = ${n};`);
    const body = [
      "1. Item one",
      "2. Item two",
      "   ```ts",
      ...codeLines.map((line) => `   ${line}`),
      "   ```",
      "3. Item three",
    ].join("\n");

    const targetLine = editorDoc(body)
      .child(0)
      .child(1)
      .child(1)
      .textContent.split("\n")[249];
    // MUTATION: number the wrong fence line -> this fixture no longer pins line 250.
    expect(targetLine?.trimStart()).toBe("const value250 = 250;");
    // MUTATION: keep the item-wide range -> the reveal starts at "Item two".
    expect(revealed(body, 253)).toBe(targetLine);
  });

  it("lands a fenced-code line in the first item of a nested list", () => {
    const codeLines = items(200, (n) => `const nested${n} = ${n};`);
    const body = [
      "1. Outer one",
      "2. Outer two",
      "   - Nested one",
      "     ```ts",
      ...codeLines.map((line) => `     ${line}`),
      "     ```",
      "   - Nested two",
      "3. Outer three",
    ].join("\n");
    const outerList = editorDoc(body).child(0);
    const outerItem = outerList.child(1);
    const nestedList = outerItem.child(1);
    const nestedItem = nestedList.child(0);
    const codeBlock = nestedItem.child(1);

    // Prove the exact descent: later outer item -> nested list -> first nested
    // item -> deep fence. The first nested item is new ground at this depth.
    expect(outerList.type.name).toBe("orderedList");
    expect(outerList.childCount).toBe(3);
    expect(outerItem.childCount).toBe(2);
    expect(outerItem.child(0).type.name).toBe("paragraph");
    expect(nestedList.type.name).toBe("bulletList");
    expect(nestedList.childCount).toBe(2);
    expect(nestedItem.childCount).toBe(2);
    expect(nestedItem.child(0).type.name).toBe("paragraph");
    expect(codeBlock.type.name).toBe("codeBlock");
    const targetLine = codeBlock.textContent.split("\n")[149];
    expect(targetLine?.trimStart()).toBe("const nested150 = 150;");

    // MUTATION: apply the first-item guard at every recursion depth. The
    // reveal then falls back to the whole "Outer two" item.
    expect(revealed(body, 154)).toBe(targetLine);
  });

  it("lands a fenced-code line when a later list item has no text of its own", () => {
    const codeLines = items(300, (n) => `const value${n} = ${n};`);
    const body = [
      "- [ ] Item one",
      "- [ ] ",
      "  ```ts",
      ...codeLines.map((line) => `  ${line}`),
      "  ```",
      "- Item three",
    ].join("\n");
    const doc = editorDoc(body);
    const target = blockTargetForLine(body, 253);
    const item = doc.child(0).child(1);

    expect(target.index).toBe(0);
    expect(target.match?.offset).toBe(252);
    expect(target.match?.lines[0]).toBe("- [ ] Item one");
    expect(doc.child(0).childCount).toBe(2);
    expect(item.childCount).toBe(2);
    expect(item.child(0).type.name).toBe("paragraph");
    expect(item.child(0).textContent).toBe("");
    expect(item.child(1).type.name).toBe("codeBlock");
    const targetLine = item.child(1).textContent.split("\n")[249];
    expect(targetLine?.trimStart()).toBe("const value250 = 250;");
    // MUTATION: require nested block index 1 even when the item's own source
    // line is empty. The reveal then keeps the whole item range.
    expect(revealed(body, 253)).toBe(targetLine);
  });

  it("lands a nested fenced-code line when a tab crosses the list indent", () => {
    const body = `- Item one
- x
	\`\`\`ts
	const target = true;
	\`\`\`
- Item three`;
    const doc = editorDoc(body);
    const item = doc.child(0).child(1);

    expect(doc.child(0).type.name).toBe("bulletList");
    expect(item.childCount).toBe(2);
    expect(item.child(0).type.name).toBe("paragraph");
    expect(item.child(0).textContent).toBe("x");
    expect(item.child(1).type.name).toBe("codeBlock");
    expect(item.child(1).textContent).toBe("const target = true;");
    expect(revealed(body, 4)).toBe("const target = true;");
  });

  it("keeps the item range when a nested-container shape is not provable", () => {
    const body = [
      "1. Item one",
      "2. Item two",
      "",
      "   Before fence.",
      "",
      "   ```ts",
      "   const target = true;",
      "   ```",
      "",
      "   After fence.",
      "3. Item three",
    ].join("\n");
    const item = editorDoc(body).child(0).child(1);
    const itemText = item.textBetween(0, item.content.size, "\n");

    // MUTATION: accept an item with extra children -> this shape refines anyway.
    expect(item.childCount).toBe(4);
    // MUTATION: narrow an unproved shape -> this loses the item-wide fallback.
    expect(revealed(body, 7)).toBe(itemText);
  });

  it("keeps the item range when a valid nested fence has trailing item content", () => {
    const body = [
      "1. Item one",
      "2. Item two",
      "   ```ts",
      "   const nested = true;",
      "   ```",
      "",
      "   Trailing item content.",
      "3. Item three",
    ].join("\n");
    const item = editorDoc(body).child(0).child(1);
    const itemText = item.textBetween(0, item.content.size, "\n");

    expect(item.childCount).toBe(3);
    expect(item.child(1).type.name).toBe("codeBlock");
    expect(item.child(2).type.name).toBe("paragraph");
    // MUTATION: loosen `childCount !== 2` to `< 2` -> the fence line narrows
    // even though the trailing paragraph makes the item shape unprovable.
    expect(revealed(body, 4)).toBe(itemText);
    expect(revealed(body, 7)).toBe(itemText);
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

  it("keeps body indentation beyond the fence opener's indent", () => {
    const body = [
      "Intro",
      "",
      " ```",
      "  extra indent kept",
      " more",
      " ```",
      "",
      "After",
    ].join("\n");
    const expected = editorDoc(body).child(1).textContent.split("\n")[0];
    expect(revealed(body, 4)).toBe(expected);
    expect(expected).toBe(" extra indent kept");
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
