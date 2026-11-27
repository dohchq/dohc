import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { BODY_SEQUENCE_FIELD, holdsBodySequence, readsBodySequence } from "./bodySequenceStore.js";
import { tokensOf } from "./bodySequenceTestSupport.js";
import { writeNewBody } from "./bodySequenceWriter.js";
import {
  DOCUMENT_OPEN_REFUSAL,
  FRONTMATTER_REFUSAL,
  documentCreateUpdate,
  documentEditUpdate,
  documentMarkdown,
  documentMarkdownOf,
  settledDocumentMarkdown,
  type DocumentEdit,
} from "./document-edit.js";
import {
  getDohcProseMirrorSchema,
  markdownToYDoc,
  parseRichdocMarkdown,
  startsWithFrontmatter,
  yDocToMarkdown,
} from "./import-export.js";
import { admitBodySequenceNotes, liveEditRefusal } from "./liveDocumentValidation.js";
import { LIVE_UPDATE_MAX_BYTES } from "./liveValidationPolicy.js";

const open = { keepBlocks: true };
const closed = { keepBlocks: false };

const state = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);
const markdownOf = (doc: Y.Doc) => documentMarkdown(state(doc));

function edited(doc: Y.Doc, edit: DocumentEdit, options = open): Y.Doc {
  const update = documentEditUpdate(state(doc), edit, options);
  if (update) Y.applyUpdate(doc, update);
  return doc;
}

function editorDoc(content: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    getDohcProseMirrorSchema(),
    { type: "doc", content },
    getDohcYDocBodyFragment(doc),
  );
  return doc;
}

const paragraph = (text?: string) =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };

describe("documentMarkdown", () => {
  test("reads an ordinary document as its file does", () => {
    const markdown = "---\ntitle: Trip\n---\n\n# Kyoto\n\n- Day one\n- Day two\n\nA **bold** plan.";
    const doc = markdownToYDoc(markdown);
    expect(markdownOf(doc)).toBe(`${markdown}\n`);
    expect(markdownOf(doc)).toBe(yDocToMarkdown(doc));
    expect(settledDocumentMarkdown("# Kyoto\n\n* Day one\n")).toBe("# Kyoto\n\n- Day one\n");
    expect(markdownOf(new Y.Doc())).toBe("");
  });

  test.each([
    ["an empty paragraph", editorDoc([paragraph("A"), paragraph()]), "A\n"],
    ["spaces", editorDoc([paragraph("Hello ")]), "Hello\n"],
    ["only an empty paragraph", editorDoc([paragraph()]), ""],
  ])("reads a document that ends in %s as its file does", (_, doc, file) => {
    expect(yDocToMarkdown(doc)).toBe(file);
    expect(markdownOf(doc)).toBe(file);
  });

  test("reads a note with only frontmatter as before", () => {
    const doc = markdownToYDoc("---\ntitle: Trip\n---\n");
    expect(markdownOf(doc)).toBe("---\ntitle: Trip\n---\n\n");
  });

  test("leaves the read as the file after an edit that ends in a blank line", () => {
    const doc = markdownToYDoc("Budget 400");
    edited(doc, { find: "400\n", replacement: "450\n\n" });
    expect(markdownOf(doc)).toBe("Budget 450\n");
    expect(markdownOf(doc)).toBe(yDocToMarkdown(doc));
    edited(doc, { find: "450\n", replacement: "500\n" });
    expect(markdownOf(doc)).toBe("Budget 500\n");
    const spaced = editorDoc([paragraph("Intro"), paragraph("Hello  ")]);
    edited(spaced, { find: "Hello\n", replacement: "Hello there.\n" });
    expect(markdownOf(spaced)).toBe("Intro\n\nHello there.\n");
    expect(yDocToMarkdown(spaced)).toBe("Intro\n\nHello there.\n");
  });
});

describe("documentEditUpdate", () => {
  test("replaces text and leaves the other blocks as they were", () => {
    const doc = markdownToYDoc("# Kyoto\n\nDay one: temples.\n\nDay two: markets.");
    const body = getDohcYDocBodyFragment(doc);
    const [heading, dayOne, dayTwo] = body.toArray();

    edited(doc, { find: "temples", replacement: "temples and tea" });

    expect(markdownOf(doc)).toBe("# Kyoto\n\nDay one: temples and tea.\n\nDay two: markets.\n");
    expect(body.toArray()).toEqual([heading, dayOne, dayTwo]);
  });

  test("keeps raw HTML, references and picture links as the file spells them", () => {
    const sealed = [
      "<details>\n<summary>Setup</summary>\n\nRun it.\n\n</details>",
      "[![build](https://img.example/b.svg)](https://ci.example/run) see [the docs][docs].",
      "[docs]: https://example.com/docs",
    ];
    const doc = markdownToYDoc(["Status: draft.", ...sealed].join("\n\n"));
    edited(doc, { find: "draft", replacement: "ready" });
    expect(markdownOf(doc)).toBe(`${["Status: ready.", ...sealed].join("\n\n")}\n`);
    edited(doc, { find: "the docs", replacement: "the guide" });
    expect(markdownOf(doc)).toBe(
      `${["Status: ready.", ...sealed].join("\n\n").replace("the docs", "the guide")}\n`,
    );
  });

  test("edits text beside a link through a definition in another block", () => {
    const doc = markdownToYDoc("See [docs][x] for details.\n\n[x]: https://example.com");
    edited(doc, { find: "for details", replacement: "for more" });
    expect(markdownOf(doc)).toBe("See [docs][x] for more.\n\n[x]: https://example.com\n");
    const emphasis = markdownToYDoc("Read *[foo*] here*.\n\n[foo*]: /guide");
    edited(emphasis, { find: "Read", replacement: "See" });
    expect(markdownOf(emphasis)).toBe("See *[foo*] here*.\n\n[foo*]: /guide\n");
    const appended = markdownToYDoc("Intro.\n\n[x]: /old");
    edited(appended, { replacement: "Read [a &copy; b][x]." });
    expect(markdownOf(appended)).toBe("Intro.\n\n[x]: /old\n\nRead [a &copy; b][x].\n");
    const named = "[constructor] and [__proto__] here.";
    expect(JSON.stringify(parseRichdocMarkdown(named, "source", named))).not.toContain("rawInline");
  });

  test("reads a link as text once the same edit removes its definition", () => {
    const doc = markdownToYDoc("[x]: /x\n\nText.");
    edited(doc, { find: "[x]: /x\n\nText.", replacement: "Text [x]." }, closed);
    expect(String(doc.toJSON().body)).toBe("<paragraph>Text [x].</paragraph>");
  });

  test("adds a section written as Markdown", () => {
    const doc = markdownToYDoc("# Itinerary\n\n## Thursday\n\nFly home.");
    edited(doc, {
      find: "Fly home.",
      replacement: "Fly home.\n\n## Friday 14\n\n- Sleep\n- Unpack",
    });
    expect(markdownOf(doc)).toBe(
      "# Itinerary\n\n## Thursday\n\nFly home.\n\n## Friday 14\n\n- Sleep\n- Unpack\n",
    );
  });

  test("adds text after the last block with text, ahead of trailing empty paragraphs", () => {
    const doc = editorDoc([paragraph("Notes"), paragraph()]);
    const cursorBlock = getDohcYDocBodyFragment(doc).get(1);
    edited(doc, { replacement: "## Next\n\nCall the hotel." });
    expect(markdownOf(doc)).toBe("Notes\n\n## Next\n\nCall the hotel.\n");
    const body = getDohcYDocBodyFragment(doc);
    expect(body.get(body.length - 1)).toBe(cursorBlock);
  });

  test("adds text to a document with no blocks and to one with only an empty paragraph", () => {
    expect(markdownOf(edited(new Y.Doc(), { replacement: "First line." }))).toBe("First line.\n");
    expect(markdownOf(edited(editorDoc([paragraph()]), { replacement: "First line." }))).toBe(
      "First line.\n",
    );
  });

  test("takes a find that ends with the final newline, and the file still ends with one", () => {
    const doc = markdownToYDoc("Budget: 400 dollars");
    expect(markdownOf(doc)).toBe("Budget: 400 dollars\n");
    edited(doc, { find: "400 dollars\n", replacement: "450 dollars\n" });
    expect(markdownOf(doc)).toBe("Budget: 450 dollars\n");
    edited(doc, { find: "450 dollars\n", replacement: "450 euros" });
    expect(markdownOf(doc)).toBe("Budget: 450 euros\n");
    expect(yDocToMarkdown(doc)).toBe("Budget: 450 euros\n");
  });

  test("refuses text it cannot find once", () => {
    const doc = state(markdownToYDoc("Tea.\n\nTea."));
    expect(() => documentEditUpdate(doc, { find: "Coffee", replacement: "x" }, open)).toThrow(
      "not in the document",
    );
    expect(() => documentEditUpdate(doc, { find: "Tea", replacement: "x" }, open)).toThrow(
      "occurs 2 times",
    );
  });

  test("refuses an edit of the frontmatter", () => {
    const doc = state(markdownToYDoc("---\ntitle: Trip\n---\n\nBody."));
    expect(() =>
      documentEditUpdate(doc, { find: "title: Trip", replacement: "title: Tour" }, open),
    ).toThrow("frontmatter");
  });

  test("answers null when nothing changes", () => {
    const doc = state(markdownToYDoc("Same."));
    expect(documentEditUpdate(doc, { find: "Same", replacement: "Same" }, open)).toBeNull();
    expect(documentEditUpdate(doc, { replacement: "  " }, open)).toBeNull();
  });

  test("leaves blocks outside the edit untouched when their stored attributes differ from the schema", () => {
    const doc = markdownToYDoc("1. one\n2. two\n\nEdit me.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
    const body = getDohcYDocBodyFragment(doc);
    const list = body.get(0) as Y.XmlElement;
    list.removeAttribute("start");
    const table = body.get(2) as Y.XmlElement;
    const cell = (table.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    for (const name of Object.keys(cell.getAttributes())) cell.removeAttribute(name);
    const touched: string[] = [];
    list.observeDeep(() => touched.push("list"));
    table.observeDeep(() => touched.push("table"));

    edited(doc, { find: "Edit me.", replacement: "Edited." });

    expect(markdownOf(doc)).toContain("Edited.");
    expect(touched).toEqual([]);
    expect(list.getAttribute("start")).toBeUndefined();
  });
});

describe("documentCreateUpdate", () => {
  test("writes the first text into a document with no blocks", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, documentCreateUpdate(state(doc), "# Kyoto\n\n- Day one\n- Day two", open)!);
    expect(markdownOf(doc)).toBe("# Kyoto\n\n- Day one\n- Day two\n");
    expect(yDocToMarkdown(doc)).toBe("# Kyoto\n\n- Day one\n- Day two\n");
  });

  test.each([
    "---\ntitle: Trip\n---\n\nBody.",
    "---\n{}\n---\n\nBody.",
    "---\n\n---\n",
    "---\n---\n",
  ])("refuses frontmatter, which would land as body blocks: %j", (markdown) => {
    expect(startsWithFrontmatter(markdown)).toBe(true);
    expect(() => documentCreateUpdate(state(new Y.Doc()), markdown, open)).toThrow(
      FRONTMATTER_REFUSAL,
    );
  });

  test.each(["Intro.\n\n---\n\nMore.", "---\nA line between two rules.\n---\n\nMore."])(
    "takes rules the reader does not read as frontmatter as body text: %j",
    (markdown) => {
      expect(startsWithFrontmatter(markdown)).toBe(false);
      expect(() => documentCreateUpdate(state(new Y.Doc()), markdown, open)).not.toThrow();
    },
  );
});

describe("an edit merged with a person typing", () => {
  function replicas(markdown: string): { person: Y.Doc; agent: Y.Doc } {
    const person = markdownToYDoc(markdown);
    const agent = new Y.Doc();
    Y.applyUpdate(agent, state(person));
    return { person, agent };
  }

  function typeAtEnd(doc: Y.Doc, blockIndex: number, text: string): Uint8Array {
    let update: Uint8Array | null = null;
    const record = (next: Uint8Array) => {
      update = next;
    };
    doc.on("update", record);
    const block = getDohcYDocBodyFragment(doc).get(blockIndex) as Y.XmlElement;
    const run = block.get(0) as Y.XmlText;
    run.insert(run.length, text);
    doc.off("update", record);
    return update!;
  }

  function merge(markdown: string, blockIndex: number, typed: string, edit: DocumentEdit): string {
    const { person, agent } = replicas(markdown);
    const typing = typeAtEnd(person, blockIndex, typed);
    const update = documentEditUpdate(state(agent), edit, open)!;
    Y.applyUpdate(person, update);
    Y.applyUpdate(agent, update);
    Y.applyUpdate(agent, typing);
    expect(markdownOf(agent)).toBe(markdownOf(person));
    return markdownOf(person);
  }

  test("keeps the person text in another block", () => {
    expect(
      merge("# Plan\n\nPerson writes here.\n\nAgent edits here.", 1, " More from the person.", {
        find: "Agent edits here.",
        replacement: "Agent edited this.",
      }),
    ).toBe("# Plan\n\nPerson writes here. More from the person.\n\nAgent edited this.\n");
  });

  test("keeps the person text in the block the agent edits", () => {
    expect(
      merge("Budget: 400 dollars for food", 0, " and drinks", { find: "400", replacement: "450" }),
    ).toBe("Budget: 450 dollars for food and drinks\n");
  });

  test("keeps the person text when the agent adds a section at the end", () => {
    expect(
      merge("Intro.\n\nLast paragraph.", 1, " Still typing.", {
        replacement: "## Added\n\nBy the agent.",
      }),
    ).toBe("Intro.\n\nLast paragraph. Still typing.\n\n## Added\n\nBy the agent.\n");
  });

  // A split keeps the typed block and gives the text after the split point to
  // a new block. The person typed at the end of the old block, after text the
  // split moved out, so their typing stays in the block they were typing in,
  // now at the end of the text before the split. Nothing is lost; where it
  // lands follows the block, not the moved words.
  test("keeps the person text in the block they typed in when the agent splits it", () => {
    const merged = merge("Budget: 400 dollars", 0, " PERSON", {
      find: "Budget: 400 dollars",
      replacement: "Budget:\n\n400 dollars",
    });
    expect(merged).toBe("Budget: PERSON\n\n400 dollars\n");
  });
});

describe("an edit while someone has the document open", () => {
  test.each([
    [
      "removes a block",
      "Keep.\n\nDrop this.\n\nKeep too.",
      { find: "\n\nDrop this.", replacement: "" },
      "Keep.\n\nKeep too.\n",
    ],
    [
      "changes a block's kind",
      "Budget: 400 dollars",
      { find: "Budget: 400 dollars", replacement: "# Budget: 400 dollars" },
      "# Budget: 400 dollars\n",
    ],
    [
      "joins two blocks",
      "Budget:\n\n400 dollars",
      { find: "Budget:\n\n400", replacement: "Budget: 400" },
      "Budget: 400 dollars\n",
    ],
    [
      "removes a list item",
      "- one\n- two\n- three",
      { find: "- two\n", replacement: "" },
      "- one\n- three\n",
    ],
  ])(
    "refuses one that %s, and applies it when nobody has it open",
    (_case, markdown, edit, whenClosed) => {
      expect(() => documentEditUpdate(state(markdownToYDoc(markdown)), edit, open)).toThrow(
        DOCUMENT_OPEN_REFUSAL,
      );
      expect(markdownOf(edited(markdownToYDoc(markdown), edit, closed))).toBe(whenClosed);
    },
  );

  test.each([
    ["Above.\n\n---\n\nBelow.", "\n\n---", "Above.\n\nBelow.\n"],
    ["***\n\nBelow.", "***\n\n", "Below.\n"],
  ])("removes a leaf block, which nobody can type into: %j", (source, find, expected) => {
    expect(markdownOf(edited(markdownToYDoc(source), { find, replacement: "" }))).toBe(expected);
  });

  test("tells the agent what to do instead", () => {
    expect(DOCUMENT_OPEN_REFUSAL).toContain(
      "change only the text inside blocks and add new blocks",
    );
    expect(DOCUMENT_OPEN_REFUSAL).toContain("ask the person");
    expect(DOCUMENT_OPEN_REFUSAL).toContain("retry after they close the document");
  });
});

// Two edits can merge into a list with nothing in it, which a reading leaves out.
test("changes a block's text beside a list a merge left empty, while the document is open", () => {
  const doc = markdownToYDoc("alpha\n\nbravo\n\ncharlie");
  try {
    getDohcYDocBodyFragment(doc).insert(2, [new Y.XmlElement("taskList")]);
    edited(doc, { find: "bravo", replacement: "BRAVO" });
    expect(markdownOf(doc)).toBe("alpha\n\nBRAVO\n\ncharlie\n");
  } finally {
    doc.destroy();
  }
});

describe("an edit to a note whose body is one sequence", () => {
  beforeAll(() => admitBodySequenceNotes(true));
  afterAll(() => admitBodySequenceNotes(false));

  const schema = getDohcProseMirrorSchema();

  function sequenceNote(markdown: string): Y.Doc {
    const doc = markdownToYDoc(markdown, { bodySequence: true });
    expect(readsBodySequence(doc)).toBe(true);
    return doc;
  }

  function writtenNote(body: ProseMirrorNode): Y.Doc {
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", 2);
    writeNewBody(schema, doc, body, (_, at) => at.toString(36));
    expect(readsBodySequence(doc)).toBe(true);
    return doc;
  }

  const copyOf = (doc: Y.Doc) => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, state(doc));
    return copy;
  };

  function landed(doc: Y.Doc, update: Uint8Array | null): Y.Doc {
    expect(update).not.toBeNull();
    expect(liveEditRefusal(copyOf(doc), update!)).toBeUndefined();
    Y.applyUpdate(doc, update!);
    expect(readsBodySequence(doc)).toBe(true);
    return doc;
  }

  const editedNote = (doc: Y.Doc, edit: DocumentEdit) =>
    landed(doc, documentEditUpdate(state(doc), edit, open));
  const tokens = (doc: Y.Doc) => tokensOf(doc.getText(BODY_SEQUENCE_FIELD));
  const ids = (doc: Y.Doc) => tokens(doc).map((token) => token.id);
  const boundaries = (doc: Y.Doc) =>
    tokens(doc)
      .filter((token) => token.kind === "boundary")
      .map((token) => token.id);

  test("reads as the same note in the first format does", () => {
    const markdown = "---\ntitle: Trip\n---\n\n# Kyoto\n\n- Day one\n- Day two\n\nA **bold** plan.";
    expect(markdownOf(sequenceNote(markdown))).toBe(markdownOf(markdownToYDoc(markdown)));
    expect(markdownOf(sequenceNote(""))).toBe("");
  });

  const TRIP = "# Kyoto\n\nDay one: temples.\n\nDay two: markets.";
  const TWO = "Day two: markets.";
  test.each([
    ["replaces text", TRIP, { find: "temples", replacement: "shrines" }],
    ["adds a block", TRIP, { find: "temples.", replacement: "temples.\n\nLunch." }],
    ["adds at the end", TRIP, { replacement: "## Day three\n\nRest." }],
    ["removes a block", TRIP, { find: "\n\nDay two: markets.", replacement: "" }],
    ["joins two blocks", TRIP, { find: "temples.\n\nDay two", replacement: "temples. Day two" }],
    ["splits a block", TRIP, { find: "one: temples", replacement: "one:\n\ntemples" }],
    ["changes a heading's level", TRIP, { find: "# Kyoto", replacement: "## Kyoto" }],
    ["wraps a block into a quote", TRIP, { find: "Day one", replacement: "> Day one" }],
    ["turns text into a rule", TRIP, { find: TWO, replacement: "---" }],
    ["turns text into math", TRIP, { find: TWO, replacement: "$$\nx^2\n$$" }],
    ["turns text into raw HTML", TRIP, { find: TWO, replacement: "<aside>x</aside>" }],
    [
      "turns a marked paragraph with an item into code",
      "A **bold** [[Wiki]] plan.",
      { find: "A **bold** [[Wiki]] plan.", replacement: "```\nA bold plan.\n```" },
    ],
    ["turns a rule into text", "Above.\n\n---\n\nBelow.", { find: "---", replacement: "Plain." }],
    ["turns a list item into a heading", "- foo", { find: "- foo", replacement: "# foo" }],
    ["turns a heading into a list item", "# foo", { find: "# foo", replacement: "- foo" }],
    [
      "changes a list's start number",
      "1. a\n2. b",
      { find: "1. a\n2. b", replacement: "3. a\n4. b" },
    ],
    [
      "writes into a paragraph the reading added to a list item",
      "- ```\n  code\n  ```",
      { find: "- \n", replacement: "- intro\n" },
    ],
    ["edits one table cell", "| a | b |\n| - | - |\n| c | d |", { find: "c", replacement: "xyz" }],
    [
      "edits beside a hard break in bold",
      "**a  \nb** and c",
      { find: "and c", replacement: "and d" },
    ],
    ["edits beside a bold link", "**[[Wiki]]** and c", { find: "and c", replacement: "and d" }],
    ["deletes the last list item", "- first\n- last", { find: "\n- last", replacement: "" }],
    [
      "deletes the last table row",
      "| a | b |\n| - | - |\n| c | d |",
      { find: "\n| c   | d   |", replacement: "" },
    ],
    [
      "turns multiline code into text with a hard break",
      "```\nA\nB\n```",
      { find: "```\nA\nB\n```", replacement: "A  \nB" },
    ],
  ])("%s, as the first format does", (_case, markdown, edit) => {
    const expected = markdownOf(edited(markdownToYDoc(markdown), edit, closed));
    expect(markdownOf(editedNote(sequenceNote(markdown), edit))).toBe(expected);
  });

  test("changes only the letters and kinds the edit names", () => {
    const doc = sequenceNote(TRIP);
    const before = tokens(doc);
    editedNote(doc, { find: "# Kyoto", replacement: "## Kyoto" });
    expect(ids(doc)).toEqual(before.map((token) => token.id));
    editedNote(doc, { find: "temples", replacement: "shrines" });
    const kept = new Set(ids(doc));
    const gone = before.filter((token) => !kept.has(token.id));
    expect(gone.map((token) => (token.kind === "letter" ? token.text : "")).join("")).toBe("templ");
    editedNote(doc, { find: "Day one: shrines.", replacement: "- Day one: shrines." });
    expect(boundaries(doc)).toEqual(
      before.filter((token) => token.kind === "boundary").map((token) => token.id),
    );
  });

  test.each([
    ["foo\n\n", 1],
    ["\n\nfoo", 0],
  ])(
    "deleting %j takes the block it names, merged with a peer's delete in either order",
    (find, kept) => {
      const doc = sequenceNote("foo\n\nfoo bar");
      const blocks = [tokens(doc).slice(0, 4), tokens(doc).slice(4, 8)];
      const peer = copyOf(doc);
      const theirs = documentEditUpdate(state(peer), { find: " bar", replacement: "" }, open)!;
      const ours = documentEditUpdate(state(doc), { find, replacement: "" }, open)!;
      const first = copyOf(doc);
      const second = copyOf(doc);
      landed(first, ours);
      Y.applyUpdate(first, theirs);
      Y.applyUpdate(second, theirs);
      Y.applyUpdate(second, ours);
      expect(markdownOf(first)).toBe("foo\n");
      expect(ids(second)).toEqual(ids(first));
      expect(ids(first)).toEqual(blocks[kept]!.map((token) => token.id));
    },
  );

  test("leaves the other cells of a table alone", () => {
    const doc = sequenceNote("| a | b |\n| - | - |\n| c | d |");
    const before = ids(doc);
    editedNote(doc, { find: "c", replacement: "x" });
    const after = new Set(ids(doc));
    expect(before.filter((id) => !after.has(id))).toHaveLength(1);
  });

  test("refuses an edit whose block reads back differently outside it", () => {
    const cell = (...texts: string[]) => ({
      type: "tableCell",
      content: texts.map((text) => paragraph(text)),
    });
    const table = {
      type: "table",
      content: [{ type: "tableRow", content: [cell("a", "b"), cell("c")] }],
    };
    const doc = writtenNote(schema.nodeFromJSON({ type: "doc", content: [table] }));
    expect(() => documentEditUpdate(state(doc), { find: "c", replacement: "x" }, open)).toThrow(
      "reads back differently",
    );
  });

  test("shows a code block's stored formatting when it becomes text", () => {
    const bold = schema.text("x", [schema.marks.bold!.create()]);
    const doc = writtenNote(
      schema.topNodeType.create(null, schema.nodes.codeBlock!.create(null, bold)),
    );
    expect(markdownOf(doc)).toBe("```\nx\n```\n");
    expect(markdownOf(editedNote(doc, { find: "```\nx\n```", replacement: "x" }))).toBe("**x**\n");
  });

  test("keeps what a peer types through a join and a kind change", () => {
    for (const edit of [
      { find: "temples.\n\nDay two", replacement: "temples. Day two" },
      { find: TWO, replacement: `## ${TWO}` },
    ]) {
      const doc = sequenceNote(TRIP);
      const peer = copyOf(doc);
      const typed = documentEditUpdate(
        state(peer),
        { find: "markets.", replacement: "markets. More" },
        open,
      )!;
      const ours = documentEditUpdate(state(doc), edit, open)!;
      landed(doc, ours);
      Y.applyUpdate(doc, typed);
      Y.applyUpdate(peer, typed);
      Y.applyUpdate(peer, ours);
      expect(markdownOf(peer)).toBe(markdownOf(doc));
      expect(markdownOf(doc)).toContain("markets. More");
    }
  });

  test("writes the first text of an empty note", () => {
    const doc = sequenceNote("");
    landed(doc, documentCreateUpdate(state(doc), "# Hi\n\nThere.", open));
    expect(markdownOf(doc)).toBe("# Hi\n\nThere.\n");
  });

  test.each([
    ["the find starts inside", { find: "\uDE00 now", replacement: "\uDE03 now" }],
    ["the replacement holds", { find: "now", replacement: "then \uD83D" }],
  ])("refuses an edit where %s half of a character", (_case, edit) => {
    const doc = sequenceNote("Smile 😀 now");
    expect(() => documentEditUpdate(state(doc), edit, open)).toThrow("half of a character");
  });

  test.each([
    ["starts", { find: "\uDE00 now", replacement: "later" }],
    ["ends", { find: "Smile \uD83D", replacement: "Hi" }],
  ])("refuses a find that %s inside a character, in either format", (_case, edit) => {
    for (const doc of [sequenceNote("Smile 😀 now"), markdownToYDoc("Smile 😀 now")])
      expect(() => documentEditUpdate(state(doc), edit, open)).toThrow("half of a character");
  });

  test("finds the match in a note that holds the letter it probes with", () => {
    const [M, N] = ["\uE000", "\uE001"];
    const doc = sequenceNote(`${M}${N}x${M}${N}`);
    const letters = () => tokens(doc).filter((token) => token.kind === "letter");
    const before = letters().map((token) => token.id);
    editedNote(doc, { find: `x${M}`, replacement: "" });
    const kept = new Set(letters().map((token) => token.id));
    expect(before.filter((id) => !kept.has(id))).toEqual([before[2], before[3]]);
    expect(markdownOf(doc)).toBe(`${M}${N}${N}\n`);
  });

  test("refuses an attribute a note can't hold instead of dropping it", () => {
    const doc = sequenceNote("```js\nx\n```");
    expect(() =>
      documentEditUpdate(state(doc), { find: "js", replacement: "foo\u2028bar" }, open),
    ).toThrow("a value a note can't hold");
    editedNote(doc, { find: "js", replacement: "foo bar" });
    expect(markdownOf(doc)).toBe("```foo bar\nx\n```\n");
  });

  test.each([
    ["an entity", "x a&. y", "a&amp;"],
    ["a less-than sign", "x a<. y", "a&lt;"],
  ])("keeps the letter after a match that ends in %s", (_case, markdown, find) => {
    const doc = sequenceNote(markdown);
    const dot = () =>
      tokens(doc).find((token) => token.kind === "letter" && token.text === ".")?.id;
    const before = dot();
    expect(() => documentEditUpdate(state(doc), { find, replacement: "a\\" }, open)).toThrow(
      "outside the text to replace",
    );
    const edit = { find, replacement: "b" };
    const expected = markdownOf(edited(markdownToYDoc(markdown), edit, closed));
    expect(markdownOf(editedNote(doc, edit))).toBe(expected);
    expect(dot()).toBe(before);
  });

  test("refuses an edit that would retype the formatted letter after its match", () => {
    const doc = sequenceNote("a **b**");
    expect(() => documentEditUpdate(state(doc), { find: "a **", replacement: "a" }, open)).toThrow(
      "outside the text to replace",
    );
  });

  test("edits inside inline code as the first format does, or refuses", () => {
    const markdown = "``a`b``";
    const edit = { find: "`b", replacement: "`c" };
    const doc = sequenceNote(markdown);
    const expected = markdownOf(edited(markdownToYDoc(markdown), edit, closed));
    let update: Uint8Array | null;
    try {
      update = documentEditUpdate(state(doc), edit, open);
    } catch (error) {
      expect((error as Error).message).toContain("outside the text to replace");
      return;
    }
    expect(markdownOf(landed(doc, update))).toBe(expected);
  });

  test("asks for the link text when an edit changes only a link's address or title", () => {
    for (const [markdown, find, replacement] of [
      ["See [docs](https://example.com) here.", "example.com", "dohc.app"],
      ['See [docs](https://example.com "Guide") here.', "Guide", "Manual"],
    ]) {
      const doc = sequenceNote(markdown!);
      expect(() =>
        documentEditUpdate(state(doc), { find: find!, replacement: replacement! }, open),
      ).toThrow("Include the link text");
    }
    const doc = sequenceNote("See [docs](https://example.com) here.");
    editedNote(doc, {
      find: "[docs](https://example.com)",
      replacement: "[docs](https://dohc.app)",
    });
    expect(markdownOf(doc)).toBe("See [docs](https://dohc.app) here.\n");
  });

  const TABLE = "| a | b |\n| - | - |\n| c | d |\n| e | f |";
  test.each([
    [
      "inserts a row",
      { find: "| c   | d   |", replacement: "| c   | d   |\n| x   | y   |" },
      "abcdef",
    ],
    ["replaces a row", { find: "| c   | d   |", replacement: "| x   | y   |" }, "abef"],
    ["replaces the header row", { find: "| a   | b   |", replacement: "| x   | y   |" }, "cdef"],
    ["deletes a row", { find: "\n| c   | d   |", replacement: "" }, "abef"],
  ])("%s of a table and keeps the other rows", (_case, edit, kept) => {
    const doc = sequenceNote(TABLE);
    const letter = (text: string) =>
      tokens(doc).find((token) => token.kind === "letter" && token.text === text)?.id;
    const before = [...kept].map(letter);
    expect(before.every((id) => id !== undefined)).toBe(true);
    const expected = markdownOf(edited(markdownToYDoc(TABLE), edit, closed));
    expect(markdownOf(editedNote(doc, edit))).toBe(expected);
    expect([...kept].map(letter)).toEqual(before);
  });

  test.each([
    [
      "adds a table column",
      TABLE,
      {
        find: "| a   | b   |\n| --- | --- |",
        replacement: "| a   | b   | z   |\n| --- | --- | --- |",
      },
    ],
    ["edits parts of two table cells", TABLE, { find: "c   | d", replacement: "x   | y" }],
    [
      "lifts a block out of a list item",
      "- ```\n  code\n  ```",
      { find: "- \n  ```\n  code\n  ```", replacement: "```\ncode\n```" },
    ],
  ])("%s as the first format does, or says what to do instead", (_case, markdown, edit) => {
    const doc = sequenceNote(markdown);
    const expected = markdownOf(edited(markdownToYDoc(markdown), edit, closed));
    let update: Uint8Array | null;
    try {
      update = documentEditUpdate(state(doc), edit, open);
    } catch (error) {
      expect((error as Error).message).not.toContain("Read the document again");
      return;
    }
    expect(markdownOf(landed(doc, update))).toBe(expected);
  });

  test("refuses formatting a note can't hold together, and keeps bold around inline items", () => {
    const link = "[`npm install`](https://docs.example/install)";
    expect(() =>
      documentEditUpdate(state(sequenceNote("Run it.")), { find: "it", replacement: link }, open),
    ).toThrow("a link on inline code");
    const edit = { find: "it", replacement: "**[[Wiki]]** and **a  \nb**" };
    const expected = markdownOf(edited(markdownToYDoc("Run it."), edit, closed));
    expect(markdownOf(editedNote(sequenceNote("Run it."), edit))).toBe(expected);
  });

  test("reads a note in the newer format without declaring the older body", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state(sequenceNote("Hi")));
    expect(documentMarkdownOf(doc)).toBe("Hi\n");
    expect(doc.share.has("body")).toBe(false);
  });

  test("refuses a block nested deeper than a note holds", () => {
    const doc = sequenceNote("Top.");
    expect(() =>
      documentEditUpdate(state(doc), { replacement: `${"> ".repeat(70)}x` }, open),
    ).toThrow("more than 64");
  });

  const PAST =
    /^dohc can't save this edit in a live note, so nothing changed\. .*\d.*\. Split it into smaller edits\.$/;

  test("names the limit an edit is past", () => {
    const doc = sequenceNote("Top.");
    expect(() =>
      documentEditUpdate(state(doc), { replacement: "w\n\n".repeat(30_000) }, open),
    ).toThrow(PAST);
  });

  test("checks the whole update of an edit that needs a boundary first", () => {
    const empty = state(sequenceNote(""));
    const letters = (count: number) => documentCreateUpdate(empty, "w".repeat(count), open);
    const fits = 2_000_000;
    const most = LIVE_UPDATE_MAX_BYTES - (letters(fits)!.byteLength - fits);
    const outcomes = [most - 64, most, most + 4, most + 8, most + 64].map((count) => {
      try {
        const update = letters(count);
        expect(update!.byteLength).toBeLessThanOrEqual(LIVE_UPDATE_MAX_BYTES);
        landed(sequenceNote(""), update);
        return "landed";
      } catch (error) {
        expect((error as Error).message).toMatch(PAST);
        return "refused";
      }
    });
    expect([outcomes[0], outcomes[4]]).toEqual(["landed", "refused"]);
  });

  test("refuses a note marked as one sequence whose text is still in the older format", () => {
    const doc = markdownToYDoc("Hi");
    doc.getMap("meta").set("schemaVersion", 2);
    expect(holdsBodySequence(doc) && !readsBodySequence(doc)).toBe(true);
    expect(() =>
      documentEditUpdate(state(doc), { find: "Hi", replacement: "Hello" }, open),
    ).toThrow("its text is still in the older one");
  });
});
