import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  recordsOfContainer,
} from "./bodySequenceGrammar.js";
import { readBodySequence, storedValue } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema, yDocToMarkdown } from "./import-export.js";

const schema = getDohcProseMirrorSchema();
const FILE = fileURLToPath(new URL("./fixtures/body-sequence.json", import.meta.url));
const UPDATES_FILE = fileURLToPath(
  new URL("./fixtures/body-sequence-updates.json", import.meta.url),
);
const EDITED_FILE = fileURLToPath(new URL("./fixtures/body-sequence-edited.json", import.meta.url));
const WRITE_FIXTURES = process.env.BODY_SEQUENCE_WRITE_FIXTURES === "1";

type Fixture = { name: string; update: string; document: unknown } & (
  | { markdown: string }
  | { markdownNotCompared: string }
);

const MARKDOWN_NOT_COMPARED: Record<string, string> = Object.fromEntries(
  ["tableCell", "tableHeader"].map((cell) => [
    `a ${cell} that holds several blocks`,
    "Where a table cell holds several blocks, TypeScript writes a quote, a callout or an ordered list among them without its marker and leaves a table out. The engine writes each block as it does anywhere else.",
  ]),
);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const named = (key: string, value: unknown) => Object.fromEntries([[key, value]]);

function note(clientID: number, from?: Uint8Array) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  if (from) Y.applyUpdate(doc, from);
  else doc.getMap("meta").set("schemaVersion", 2);
  const element = (name: string, attrs: Record<string, unknown>) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    return made;
  };
  return {
    doc,
    sequence,
    records,
    line(attrs: Record<string, unknown>, text = "", marks: Record<string, unknown> = {}) {
      const boundary = element(BLOCK_ELEMENT, attrs);
      sequence.insertEmbed(sequence.length, boundary, {});
      if (text) sequence.insert(sequence.length, text, marks);
      return boundary;
    },
    text(text: string, marks: Record<string, unknown> = {}) {
      sequence.insert(sequence.length, text, marks);
    },
    item(name: string, attrs: Record<string, unknown>, marks: Record<string, unknown> = {}) {
      const made = element(name, attrs);
      sequence.insertEmbed(sequence.length, made, marks);
      return made;
    },
    keyed(holder: Y.XmlElement | Y.Map<unknown>, key: string, content: Y.Item["content"]) {
      doc.transact((transaction) => {
        const newest = holder._map.get(key) ?? null;
        new Y.Item(
          Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)),
          newest,
          newest && newest.lastId,
          null,
          null,
          holder,
          key,
          content,
        ).integrate(transaction, 0);
      });
    },
    stored(content: Y.ContentEmbed | Y.ContentFormat) {
      doc.transact((transaction) => {
        let last = sequence._start;
        while (last?.right) last = last.right;
        new Y.Item(
          Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)),
          last,
          last && last.lastId,
          null,
          null,
          sequence,
          null,
          content,
        ).integrate(transaction, 0);
      });
    },
    embedded(value: unknown) {
      this.stored(new Y.ContentEmbed(value as object));
    },
    label(text: string) {
      this.line({ type: "paragraph", path: [] }, text);
    },
    container(id: string, type: string, attrs: Record<string, unknown> = {}) {
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
        records.set(key, value);
    },
  };
}

function built(): Record<string, Y.Doc> {
  const plain = note(1);
  plain.text("before any boundary");
  plain.line({ type: "paragraph", path: [] }, "One ");
  plain.text("bold", { bold: {} });
  plain.text(" and ");
  plain.text("a link", { link: { href: "https://example.com", title: "Example" } });
  plain.item("wikilink", { target: "Page", label: null });
  plain.line({ type: "heading", level: 2, path: [] }, "Title 😀");
  plain.line({ type: "codeBlock", language: "ts", path: [] }, "const x = 1;\nx;", { bold: {} });
  plain.line({ type: "horizontalRule", path: [] });
  plain.line({ type: "mathBlock", tex: "x^2", path: [] });
  plain.line({ type: "paragraph", path: [] }, "code wins", { code: {}, italic: {} });

  const nested = note(2);
  nested.container("L", "bulletList");
  nested.container("a", "listItem");
  nested.container("b", "listItem");
  nested.container("N", "taskList");
  nested.container("t", "taskItem", { checked: true });
  nested.container("c", "callout", { calloutType: "warning", title: "Careful", fold: "-" });
  nested.container("T", "table");
  nested.container("r1", "tableRow");
  nested.container("h1", "tableHeader");
  nested.container("h2", "tableHeader");
  nested.container("r2", "tableRow", { height: 40 });
  nested.container("d1", "tableCell", { colwidth: [120] });
  nested.line({ type: "paragraph", path: ["L", "a"] }, "first");
  nested.line({ type: "paragraph", path: ["L", "a"] }, "second paragraph of first");
  nested.line({ type: "paragraph", path: ["L", "b"] }, "second");
  nested.line({ type: "paragraph", path: ["L", "b", "N", "t"] }, "a ticked to-do");
  nested.line({ type: "paragraph", path: ["c"] }, "inside a callout");
  nested.line({ type: "paragraph", path: ["T", "r1", "h1"] }, "a");
  nested.line({ type: "paragraph", path: ["T", "r1", "h2"] }, "b");
  nested.line({ type: "paragraph", path: ["T", "r2", "d1"] }, "one cell only");

  const odd = note(3);
  odd.container("L", "taskList");
  odd.container("i", "listItem");
  odd.records.set("i.checked", "yes");
  odd.container("q", "blockquote");
  odd.container("T", "table");
  odd.container("r", "tableRow");
  odd.container("d", "tableCell", { colspan: 1e9, colwidth: [100n, 20] });
  odd.records.set("o", "orderedList");
  odd.records.set("o.start", 1.5);
  odd.container("oi", "listItem");
  odd.line({ type: "heading", level: "x", path: ["L", "i"] }, "a heading in an item");
  odd.line({ type: "heading", level: 3n, path: ["q", "q", "L"] }, "a path that repeats an id");
  odd.line({ type: "paragraph", path: ["q", "missing"] }, "a path with no record");
  odd.line({ type: "nonsense", path: "q" }, "an unknown type and a path that is no array");
  odd.line({}, "a boundary with no attributes");
  odd.line({ type: "paragraph", path: ["T", "r", "d"] }, "a cell");
  odd.line({ type: "paragraph", path: ["o", "oi"] }, "a list that starts at one and a half");
  odd.line({ type: "codeBlock", path: [] }, "code ");
  odd.item("wikilink", { target: "Spilled" });
  odd.text("after the item");
  odd.item("nonsense", {});
  odd.line({ type: "paragraph", path: [] }, "marks: ", {});
  odd.text("on", { bold: {} });
  odd.text("off", { bold: true, italic: null, "bold--abcdefgh": {} });

  const astral = note(7);
  astral.text("😀");
  astral.line({ type: "paragraph", path: [] }, "𝒳");
  astral.item("hardBreak", {});
  astral.text("𝒴");
  astral.item("wikilink", { target: "𝒵", label: "😀" });
  astral.text("👩‍👩‍👧");
  astral.item("mathInline", { tex: "𝔼" });
  astral.line({ type: "heading", level: 3, path: [] }, "🧪");
  astral.item("image", { src: "a.png", alt: "🖼" });
  astral.text("🧪");
  astral.line({ type: "codeBlock", language: "ts", path: [] }, "𝓍 = '😀'");
  astral.line({ type: "paragraph", path: [] }, "a ");
  astral.text("😀", { bold: {} });
  astral.text(" b");
  astral.line({ type: "paragraph", path: [] }, "😀");

  const marks = note(8);
  marks.line({ type: "paragraph", path: [] }, "each:");
  for (const name of ["bold", "italic", "strike", "underline", "highlight", "code"]) {
    marks.text(" ");
    marks.text(name, { [name]: {} });
  }
  marks.line({ type: "paragraph", path: [] });
  marks.text("a link", {
    link: {
      href: "https://example.com/a",
      target: "_self",
      rel: "author",
      class: "external",
      title: "A title",
    },
  });
  marks.text(", ");
  marks.text("a link with no address", { link: {} });
  marks.text(", ");
  marks.text("a link a reader repairs", {
    link: { href: 3, target: null, rel: null, class: 4, title: ["t"], more: "x" },
  });
  marks.text(", ");
  marks.text("a link whose values are no text", {
    link: { href: [], target: 1, rel: 2.5, class: true, title: {} },
  });
  marks.line({ type: "paragraph", path: [] });
  marks.text("bold and italic", { bold: {}, italic: {} });
  marks.text(", ");
  marks.text("a struck link", { strike: {}, link: { href: "https://example.com/b" } });
  marks.text(", ");
  marks.text("code alone", {
    code: {},
    bold: {},
    italic: {},
    strike: {},
    underline: {},
    highlight: {},
    link: { href: "https://example.com/c" },
  });
  marks.text(", ");
  marks.text("all but code", {
    bold: {},
    italic: {},
    strike: {},
    underline: {},
    highlight: {},
    link: { href: "https://example.com/d" },
  });
  marks.line({ type: "heading", level: 2, path: [] }, "A heading with ");
  marks.text("marks", { italic: {} });
  marks.line({ type: "codeBlock", language: null, path: [] }, "no marks in code", {
    bold: {},
    link: { href: "https://example.com/e" },
  });
  marks.line({ type: "paragraph", path: [] }, "on for an object: ");
  marks.text("with a key no mark has", { bold: { weight: 900 } });
  marks.text(", off for anything else: ");
  for (const [at, value] of [true, 1, "yes", [], [{}], 0, false].entries())
    marks.text(String(at), { bold: value });
  marks.text(", off for a name that is no mark: ");
  marks.text("hashed", { "bold--abcdefgh": {} });
  marks.text(" ");
  marks.text("other names", { strong: {}, em: {}, strikethrough: {}, Bold: {} });
  marks.text(" ");
  marks.text("a key named __proto__", named("__proto__", { bold: {} }));
  marks.text(" ");
  marks.text("link", named("link", named("__proto__", { href: "https://example.com/f" })));
  marks.line({ type: "paragraph", path: [] }, "a mark runs ");
  const markedFrom = marks.sequence.length;
  marks.text("over a break");
  marks.item("hardBreak", {});
  marks.text("to the end of this line");
  marks.line({ type: "paragraph", path: [] }, "and on into the next");
  marks.sequence.format(markedFrom, marks.sequence.length - markedFrom, { italic: {} });
  marks.text(", then stops");
  marks.item(BLOCK_ELEMENT, { type: "paragraph", path: [] }, { bold: {} });
  marks.text("plain after a boundary stored with a mark, and beside an item stored with one: ");
  marks.item("wikilink", { target: "Page" }, { bold: {}, link: { href: "https://example.com/g" } });

  const inline = note(10);
  inline.line({ type: "paragraph", path: [] }, "a break");
  inline.item("hardBreak", {});
  inline.text("an image ");
  inline.item("image", { src: "https://example.com/a.png", alt: "An image", title: "Its title" });
  inline.text(", an escape ");
  inline.item("escapedPunctuation", { value: "*" });
  inline.text(", a wikilink ");
  inline.item("wikilink", { target: "Page", label: "Label" });
  inline.text(", an atom ");
  inline.item("inlineAtom", { atomId: "date", params: "", source: "" });
  inline.text(", an atom with its source ");
  inline.item("inlineAtom", { atomId: "date", params: "short", source: "atom:date short" });
  inline.text(", math ");
  inline.item("mathInline", { tex: "x^2" });
  inline.text(" and raw ");
  inline.item("rawInline", { source: "<kbd>K</kbd>" });
  inline.text(".");
  inline.line({ type: "heading", level: 2, path: [] }, "In a heading: ");
  inline.item("wikilink", { target: "Page" });
  inline.text(" ");
  inline.item("mathInline", { tex: "y" });
  inline.text(" ");
  inline.item("image", { src: "b.png", alt: "b" });
  inline.text(" ");
  inline.item("escapedPunctuation", { value: "#" });
  inline.text(" ");
  inline.item("inlineAtom", { atomId: "x" });
  inline.text(" ");
  inline.item("rawInline", { source: "<b>" });
  inline.line({ type: "paragraph", path: [] });
  inline.item("wikilink", { target: "First in its line" });
  inline.item("wikilink", { target: "Next to another" });

  const leaves = note(11);
  leaves.line({ type: "paragraph", path: [] }, "a paragraph");
  for (const level of [1, 2, 3, 4, 5, 6])
    leaves.line({ type: "heading", level, path: [] }, `a heading at level ${String(level)}`);
  leaves.line({ type: "codeBlock", language: "rust", path: [] }, "fn main() {}\n\nlet x = 1;");
  leaves.line({ type: "codeBlock", language: null, path: [] });
  leaves.line({ type: "horizontalRule", path: [] });
  leaves.line({ type: "mathBlock", tex: "\\frac{a}{b}", path: [] });
  leaves.line({ type: "rawBlock", source: "<div>raw</div>", path: [] });
  leaves.line({ type: "paragraph", path: [] });
  leaves.line({ type: "heading", level: 2, path: [] });
  leaves.line({ type: "paragraph", path: [] }, "a last paragraph");

  const HOLDERS: Record<string, string[]> = {
    blockquote: ["blockquote"],
    callout: ["callout"],
    listItem: ["bulletList", "listItem"],
    taskItem: ["taskList", "taskItem"],
    tableCell: ["table", "tableRow", "tableCell"],
    tableHeader: ["table", "tableRow", "tableHeader"],
  };
  const HELD: Record<string, string[]> = {
    blockquote: ["blockquote"],
    callout: ["callout"],
    bulletList: ["bulletList", "listItem"],
    orderedList: ["orderedList", "listItem"],
    taskList: ["taskList", "taskItem"],
    table: ["table", "tableRow", "tableCell"],
  };
  const CELLS = ["tableCell", "tableHeader"];
  const holds = (holder: string, client: number, besideOtherBlocks: boolean) => {
    const made = note(client);
    const outer = HOLDERS[holder]!;
    for (const [held, inner] of Object.entries(HELD)) {
      made.label(`${held} in ${holder}:`);
      const path = [...outer, ...inner].map((type, depth) => {
        const id = `${holder}-${held}-${String(depth)}`;
        made.container(id, type);
        return id;
      });
      const inHolder = { type: "paragraph", path: path.slice(0, outer.length) };
      if (besideOtherBlocks) made.line(inHolder, `the ${holder}`);
      made.line({ type: "paragraph", path }, `the ${held} in it`);
      if (besideOtherBlocks) made.line(inHolder, `the ${holder} again`);
    }
    return made.doc;
  };
  const holding = Object.keys(HOLDERS).map(
    (holder, at) =>
      [`what a ${holder} holds`, holds(holder, 12 + at, !CELLS.includes(holder))] as const,
  );
  const severalBlocksInACell = CELLS.map(
    (cell, at) => [`a ${cell} that holds several blocks`, holds(cell, 25 + at, true)] as const,
  );

  const values = note(18);
  const stored = (value: unknown) =>
    Object.is(value, -0)
      ? "negative zero"
      : typeof value === "bigint"
        ? `BigInt ${String(value)}`
        : typeof value === "string"
          ? `the string ${JSON.stringify(value)}`
          : Array.isArray(value)
            ? `an array of ${String(value.length)}`
            : typeof value === "object" && value !== null
              ? "an object"
              : String(value);
  for (const level of [
    1,
    6,
    2n,
    0,
    7,
    2.5,
    -1,
    "2",
    true,
    null,
    undefined,
    [2],
    { level: 2 },
    2n ** 60n,
    -(2n ** 60n),
    -3n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    2 ** 53,
  ])
    values.line({ type: "heading", level, path: [] }, `level stored as ${stored(level)}`);
  values.line({ type: "heading", level: new Y.Map(), path: [] }, "level stored as a shared map");
  values.line({ type: new Y.Text("heading"), path: [] }, "type stored as a shared text");
  for (const [at, start] of [
    0,
    7,
    999_999_999,
    3n,
    1_000_000_000,
    -1,
    1.5,
    "3",
    null,
    2n ** 60n,
    -0,
    2 ** 53,
  ].entries()) {
    const list = `start-${String(at)}`;
    values.label(`a list whose start is stored as ${stored(start)}:`);
    values.container(list, "orderedList");
    values.records.set(`${list}.start`, start);
    for (const item of ["a", "b"]) {
      values.container(`${list}-${item}`, "listItem");
      values.line({ type: "paragraph", path: [list, `${list}-${item}`] }, `item ${item}`);
    }
  }
  for (const [at, loose] of [true, false, "yes", 1, null].entries())
    for (const kind of ["bulletList", "orderedList", "taskList"]) {
      const list = `loose-${kind}-${String(at)}`;
      values.label(`a ${kind} whose loose is stored as ${stored(loose)}:`);
      values.container(list, kind);
      values.records.set(`${list}.loose`, loose);
      values.records.set(`${list}.type`, at === 0 ? "a" : at);
      for (const item of ["a", "b"]) {
        values.container(`${list}-${item}`, "listItem");
        values.line({ type: "paragraph", path: [list, `${list}-${item}`] }, `item ${item}`);
      }
    }
  values.label("to-dos whose tick is stored as different values:");
  values.container("ticks", "taskList");
  for (const [at, checked] of [true, false, "true", 1, null, undefined, 1n].entries()) {
    const item = `tick-${String(at)}`;
    values.records.set(item, "taskItem");
    values.records.set(`${item}.checked`, checked);
    values.line({ type: "paragraph", path: ["ticks", item] }, `stored as ${stored(checked)}`);
  }
  for (const [at, [calloutType, title, fold]] of (
    [
      ["tip", "A title", "+"],
      ["warning", "", "-"],
      ["tip\nwith a line break", "A title", ""],
      ["tip", "A title\rwith a line break", "+"],
      ["tip\u2028with a line separator", "A title\u2029with a paragraph separator", "-"],
      [3, 7, "x"],
      [null, null, null],
      ["", "kept", ""],
      [undefined, undefined, 1],
    ] as const
  ).entries()) {
    const callout = `callout-${String(at)}`;
    values.label(
      `a callout stored with ${stored(calloutType)}, ${stored(title)} and ${stored(fold)}:`,
    );
    values.records.set(callout, "callout");
    values.records.set(`${callout}.calloutType`, calloutType);
    values.records.set(`${callout}.title`, title);
    values.records.set(`${callout}.fold`, fold);
    values.line({ type: "paragraph", path: [callout] }, "inside it");
  }
  values.label("a table whose cells and rows are stored with different values:");
  values.container("grid", "table");
  const cells: [string, unknown][][] = [
    [
      ["colspan", 2],
      ["rowspan", 1000],
      ["colwidth", [120, 0, 20.5]],
      ["align", "left"],
    ],
    [
      ["colspan", 2n],
      ["rowspan", 3n],
      ["colwidth", [100n, 20]],
      ["align", "right"],
    ],
    [
      ["colspan", 0],
      ["rowspan", 1001],
      ["colwidth", []],
      ["align", "center"],
    ],
    [
      ["colspan", 1.5],
      ["rowspan", "2"],
      ["colwidth", [-1]],
      ["align", "justify"],
    ],
    [
      ["colspan", null],
      ["rowspan", -2n],
      ["colwidth", [1, undefined]],
      ["align", 1],
    ],
    [
      ["colspan", 2n ** 60n],
      ["rowspan", true],
      ["colwidth", [1, "2"]],
      ["align", null],
    ],
    [
      ["colwidth", [Number.POSITIVE_INFINITY]],
      ["align", ""],
    ],
    [["colwidth", [Number.NaN]]],
    [["colwidth", Array.from({ length: 1000 }, () => 1)]],
    [["colwidth", Array.from({ length: 1001 }, () => 1)]],
    [["colwidth", "wide"]],
    [["colwidth", [2n ** 60n]]],
    [["colwidth", [[1]]]],
    [["colwidth", 120]],
    [
      ["colspan", -0],
      ["rowspan", 2 ** 53],
      ["colwidth", [-0, 2 ** 53, 1e21]],
    ],
  ];
  const heights = [40, 1_000_000, 40n, null, 0, 1_000_001, 1.5, "40", -1, -0, 2 ** 53];
  for (const [at, height] of heights.entries()) {
    const row = `row-${String(at)}`;
    values.records.set(row, "tableRow");
    values.records.set(`${row}.height`, height);
    for (const kind of ["tableHeader", "tableCell"]) {
      const records = cells[(at * 2 + (kind === "tableCell" ? 1 : 0)) % cells.length]!;
      const cell = `${row}-${kind}`;
      values.records.set(cell, kind);
      for (const [key, value] of records) values.records.set(`${cell}.${key}`, value);
      values.line(
        { type: "paragraph", path: ["grid", row, cell] },
        `${String(at)} ${kind === "tableCell" ? "cell" : "header"}`,
      );
    }
  }
  values.label("text a reader repairs:");
  values.line({ type: "codeBlock", language: 3, path: [] }, "a language stored as 3");
  values.line({ type: "codeBlock", language: "", path: [] }, "a language stored as nothing");
  for (const language of [
    "ts\nwith a line break",
    "ts\rwith a line break",
    "ts\u2028with a line separator",
    "ts\u2029with a paragraph separator",
  ])
    values.line(
      { type: "codeBlock", language, path: [] },
      `a language stored as ${stored(language)}`,
    );
  values.line({ type: "mathBlock", tex: 5, path: [] });
  values.line({ type: "mathBlock", tex: null, path: [] });
  values.line({ type: "rawBlock", source: null, path: [] });
  values.line({ type: "rawBlock", source: ["<p>"], path: [] });
  values.line({ type: "paragraph", path: [] }, "items: ");
  for (const [name, attrs] of [
    ["image", { src: 1, alt: null, title: 2 }],
    ["image", { src: "c.png", alt: "c", title: "" }],
    ["wikilink", { target: null, label: 3 }],
    ["wikilink", { target: "Page", label: "" }],
    ["escapedPunctuation", { value: 4 }],
    ["inlineAtom", { atomId: 5, params: null, source: {} }],
    ["mathInline", { tex: ["x"] }],
    ["rawInline", { source: 6 }],
  ] as const) {
    values.item(name, attrs);
    values.text(" ");
  }
  values.text("end");
  values.label("a name the type does not have is not read:");
  values.line({ type: "heading", language: "ts", tex: "x", source: "y", path: [] }, "a heading");
  values.line({ type: "paragraph", level: 3, language: "ts", path: [] }, "a paragraph");
  values.line({ type: "codeBlock", level: 3, path: [] }, "a code block");
  values.line(
    Object.fromEntries([
      ["__proto__", { type: "heading", level: 5 }],
      ["path", []],
    ]),
    "a boundary with a key named __proto__",
  );
  values.records.set("unnamed", "blockquote");
  values.records.set("unnamed.title", "a record no path names");

  const paths = note(19);
  for (const [id, type] of [
    ["q", "blockquote"],
    ["q2", "blockquote"],
    ["L", "bulletList"],
    ["i", "listItem"],
    ["i2", "listItem"],
    ["N", "taskList"],
    ["t", "taskItem"],
    ["O", "orderedList"],
    ["T", "table"],
    ["r", "tableRow"],
    ["d", "tableCell"],
    ["c", "callout"],
    ["Az09_-", "blockquote"],
    ["x".repeat(32), "blockquote"],
    ["x".repeat(33), "blockquote"],
    ["has space", "blockquote"],
    ["dot.ted", "blockquote"],
    ["", "blockquote"],
    ["é", "blockquote"],
    ["line\n", "blockquote"],
  ] as const)
    paths.container(id, type);
  paths.records.set("number", 3);
  paths.records.set("shared", new Y.Text("blockquote"));
  paths.records.set("c.title", new Y.Text("a title stored as a shared text"));
  paths.records.set("null", null);
  paths.records.set("leaf", "paragraph");
  paths.records.set("top", "doc");
  paths.records.set("letters", "text");
  paths.records.set("unknown", "nonsense");
  paths.records.set("row", "tableRow");
  paths.records.set("item", "listItem");
  paths.records.set("todo", "taskItem");
  paths.records.set("cell", "tableCell");
  paths.records.set("quote", "blockquote");
  const repaired: [string, unknown][] = [
    ["an id of every kind of allowed letter", ["Az09_-"]],
    ["an id of 32 letters", ["x".repeat(32)]],
    ["an id of 33 letters", ["q", "x".repeat(33), "q2"]],
    ["an id with a space", ["q", "has space", "q2"]],
    ["an id with a dot", ["q", "dot.ted", "q2"]],
    ["an empty id", ["q", "", "q2"]],
    ["an id outside ASCII", ["q", "é", "q2"]],
    ["an id that ends with a line break", ["q", "line\n", "q2"]],
    ["an id that is a number", ["q", 3, "q2"]],
    ["an id that is null", ["q", null, "q2"]],
    ["an id that is undefined", ["q", undefined, "q2"]],
    ["an id that is an array", ["q", ["q2"], "q2"]],
    ["an id used twice", ["q", "q2", "q", "c"]],
    ["an id with no record", ["q", "missing", "q2"]],
    ["a record that is a number", ["q", "number", "q2"]],
    ["a record that is null", ["q", "null", "q2"]],
    ["a record that is a shared text", ["q", "shared", "q2"]],
    ["a path that is a shared array", new Y.Array()],
    ["a record that names a block with no blocks inside", ["q", "leaf", "q2"]],
    ["a record that names the document", ["q", "top", "q2"]],
    ["a record that names text", ["q", "letters", "q2"]],
    ["a record that names nothing", ["q", "unknown", "q2"]],
    ["a row outside a table", ["q", "row", "d"]],
    ["an item outside a list", ["q", "item"]],
    ["a to-do outside a list", ["todo"]],
    ["a cell recorded where a table holds a row", ["T", "cell"]],
    ["a quote recorded as an item of a list", ["L", "quote"]],
    ["a to-do recorded as an item of a bullet list", ["L", "todo"]],
    ["an item recorded as an item of a to-do list", ["N", "item"]],
    ["a quote recorded as a row of a table", ["T", "quote", "d"]],
    ["a number recorded as an item of a list", ["L", "number"]],
    ["a quote recorded as a cell of a row", ["T", "r", "quote"]],
    ["a path that ends at a list", ["q", "L"]],
    ["a path that ends at a to-do list", ["N"]],
    ["a path that ends at a table", ["q", "T"]],
    ["a path that ends at a row", ["q", "T", "r"]],
    ["a path that is a string", "q"],
    ["a path that is a number", 3],
    ["a path that is null", null],
    ["a path that is an object", { 0: "q", length: 1 }],
    ["a path that is missing", undefined],
  ];
  for (const [text, path] of repaired) {
    paths.label(`${text}:`);
    paths.line(path === undefined ? { type: "paragraph" } : { type: "paragraph", path }, text);
  }
  paths.label("a path of 70 quotes keeps 64:");
  const deep = Array.from({ length: 70 }, (_, depth) => `deep-${String(depth)}`);
  for (const id of deep) paths.records.set(id, "blockquote");
  paths.line({ type: "paragraph", path: deep }, "64 deep");
  paths.label("lines that name one id share its container while they are neighbours:");
  paths.line({ type: "paragraph", path: ["q", "L", "i"] }, "first");
  paths.line({ type: "paragraph", path: ["q", "L", "i"] }, "the same item");
  paths.line({ type: "paragraph", path: ["q", "L", "i2"] }, "the same list");
  paths.line({ type: "paragraph", path: ["q"] }, "the same quote");
  paths.line({ type: "paragraph", path: [] }, "no longer a neighbour");
  paths.line({ type: "paragraph", path: ["q", "L", "i"] }, "the same ids, a second quote");
  paths.line({ type: "paragraph", path: ["L", "i"] }, "the same list id at another depth");
  paths.line({ type: "paragraph", path: ["c", "L", "i"] }, "and under another parent");
  paths.label("an item starts with a paragraph:");
  paths.line({ type: "heading", level: 2, path: ["L", "i"] }, "a heading first");
  paths.line({ type: "codeBlock", language: null, path: ["L", "i2"] }, "code first");
  paths.label("also when a list comes first in it:");
  paths.line({ type: "paragraph", path: ["O", "i", "N", "t"] }, "a to-do in an item");
  paths.line({ type: "horizontalRule", path: ["O", "i2"] });
  paths.line(
    { type: "paragraph", path: ["O", "i2", "q", "L", "i"] },
    "a list in a quote in an item",
  );

  const spills = note(20);
  spills.container("L", "bulletList");
  spills.container("i", "listItem");
  spills.container("c", "callout");
  spills.line({ type: "horizontalRule", path: [] }, "letters after a rule");
  spills.line({ type: "mathBlock", tex: "x", path: [] });
  spills.item("wikilink", { target: "An item after math" });
  spills.text(" and letters ");
  spills.text("with a mark", { bold: {} });
  spills.line({ type: "rawBlock", source: "<hr>", path: [] }, "letters after a raw block", {
    italic: {},
  });
  spills.item("hardBreak", {});
  spills.text("and a second line");
  spills.line({ type: "codeBlock", language: "ts", path: [] }, "code");
  spills.item("nonsense", {});
  spills.text(" goes on past\nan element a reader skips");
  spills.item("image", { src: "d.png", alt: "an image ends the code" });
  spills.text(" and takes the rest with it, ");
  spills.text("marks and all", { strike: {} });
  spills.item("mathInline", { tex: "z" });
  spills.line({ type: "horizontalRule", path: ["L", "i"] }, "letters after a rule in an item");
  spills.line({ type: "mathBlock", tex: "y", path: ["c"] }, "letters after math in a callout");
  spills.line({ type: "paragraph", path: ["c"] }, "the next line of the callout");
  spills.line({ type: "horizontalRule", path: [] });
  spills.item("nonsense", {});
  spills.line({ type: "paragraph", path: [] }, "nothing followed that rule");

  const skipped = note(21);
  skipped.embedded("an embedded string");
  skipped.embedded({ an: "embedded object" });
  skipped.embedded(7);
  skipped.sequence.insertEmbed(skipped.sequence.length, new Y.Map([["a", "map"]]), {});
  skipped.sequence.insertEmbed(skipped.sequence.length, new Y.XmlText("xml text"), {});
  skipped.sequence.insertEmbed(skipped.sequence.length, new Y.Array(), {});
  for (const name of ["nonsense", "paragraph", "text", "doc", "blockquote", "Block", "__proto__"])
    skipped.item(name, { type: "heading", path: [] });
  skipped.text("letters before any boundary");
  skipped.embedded("a second embedded string");
  skipped.item("wikilink", { target: "Page" });
  skipped.line({ type: "heading", level: 2, path: [] });
  skipped.embedded("a third");
  skipped.item("nonsense", {});
  skipped.text("a heading");
  skipped.embedded({});
  skipped.text(" in one piece", { bold: true });
  skipped.line({ type: "codeBlock", language: null, path: [] }, "code");
  skipped.embedded("a fourth");
  skipped.item("paragraph", {});
  skipped.text(" in one piece");

  const nothing = note(22);

  const onlySkipped = note(23);
  onlySkipped.embedded("an embedded string");
  onlySkipped.item("nonsense", {});
  onlySkipped.sequence.insertEmbed(onlySkipped.sequence.length, new Y.Map(), {});
  onlySkipped.container("q", "blockquote");

  const onlyFormatting = note(24);
  for (const [key, value] of [
    ["nonsense", true],
    ["bold--abcdefgh", {}],
    ["__proto__", { bold: {} }],
    ["bold", {}],
    ["link", { href: "https://example.com" }],
  ] as const)
    onlyFormatting.stored(new Y.ContentFormat(key, value));

  const notPlain = note(27);
  notPlain.container("k", "callout", { calloutType: "tip", title: "A title" });
  notPlain.keyed(notPlain.records, "q", new Y.ContentEmbed("blockquote"));
  notPlain.keyed(notPlain.records, "c", new Y.ContentString("callout"));
  notPlain.keyed(notPlain.records, "b", new Y.ContentBinary(new Uint8Array([1, 2])));
  notPlain.keyed(notPlain.records, "k.title", new Y.ContentString("A title"));
  notPlain.keyed(notPlain.records, "k.calloutType", new Y.ContentEmbed("warning"));
  const lettersAsType = notPlain.line({ path: ["q"] }, "a type stored as letters, ");
  notPlain.keyed(lettersAsType, "type", new Y.ContentString("heading"));
  notPlain.text("in a quote recorded as an embedded value");
  notPlain.line({ type: "paragraph", path: ["c"] }, "in a callout recorded as letters");
  notPlain.line({ type: "paragraph", path: ["b"] }, "in a quote recorded as a binary value");
  notPlain.line({ type: "paragraph", path: ["k"] }, "a kind and a title that hold no plain value");
  const lastOfSeveral = notPlain.line({ path: [] }, "the last of several values under one key");
  notPlain.keyed(lastOfSeveral, "type", new Y.ContentAny(["codeBlock", "heading"]));
  notPlain.keyed(lastOfSeveral, "level", new Y.ContentAny([5, 2]));
  notPlain.line({ type: "paragraph", path: [] }, "items: ");
  const link = notPlain.item("wikilink", {});
  notPlain.keyed(link, "target", new Y.ContentString("Page"));
  const image = notPlain.item("image", { alt: "kept" });
  notPlain.keyed(image, "src", new Y.ContentBinary(new Uint8Array([3])));
  const embeddedLevel = notPlain.line({ type: "heading", path: [] }, "a level stored as an embed");
  notPlain.keyed(embeddedLevel, "level", new Y.ContentEmbed(4));

  const base = note(4);
  base.line({ type: "paragraph", path: [] }, "One one");
  base.line({ type: "paragraph", path: [] }, "Two two two");
  base.line({ type: "paragraph", path: [] }, "Three");
  const start = Y.encodeStateAsUpdate(base.doc);
  const first = note(5, start);
  const second = note(6, start);
  const history = new Y.UndoManager([first.sequence, first.records], {
    ignoreRemoteMapChanges: true,
    deleteFilter: (item) => item.parentSub === null,
  });
  first.sequence.delete(8, 1);
  second.sequence.delete(8, 1);
  second.sequence.insert(12, "X");
  Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(second.doc), "from the other person");
  history.undo();
  Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(first.doc), "from the other person");

  return {
    "letters, marks, inline items and blocks that hold no blocks": plain.doc,
    "lists, a to-do, a callout and an uneven table": nested.doc,
    "values and paths a reader must repair": odd.doc,
    "letters outside the basic plane beside boundaries and inline items": astral.doc,
    "every mark, alone, together and where it means nothing": marks.doc,
    "every inline item": inline.doc,
    "every block that holds no blocks": leaves.doc,
    ...Object.fromEntries(holding),
    ...Object.fromEntries(severalBlocksInACell),
    "every attribute as numbers, as BigInt and as values a reader repairs": values.doc,
    "every path a reader repairs, and which lines share a container": paths.doc,
    "what a block cannot hold goes to a paragraph after it": spills.doc,
    "items a reader skips": skipped.doc,
    "a note with nothing in its sequence": nothing.doc,
    "a note with only items a reader skips": onlySkipped.doc,
    "a note with only formatting items": onlyFormatting.doc,
    "attributes and records stored as items that hold no plain value": notPlain.doc,
    "both joined one line, one typed, one undid": second.doc,
  };
}

const shown = (doc: Y.Doc) => {
  const node = readBodySequence(schema, doc);
  node.check();
  return node.toJSON() as unknown;
};

function writtenAsMarkdown(document: unknown): string {
  const sameDocumentUnderBody = new Y.Doc();
  sameDocumentUnderBody.getMap("meta").set("schemaVersion", 1);
  const body = getDohcYDocBodyFragment(sameDocumentUnderBody);
  prosemirrorJSONToYXmlFragment(schema, document, body);
  expect(yXmlFragmentToProseMirrorRootNode(body, schema).toJSON()).toEqual(document);
  const markdown = yDocToMarkdown(sameDocumentUnderBody);
  sameDocumentUnderBody.destroy();
  return markdown;
}

it("reads each stored note as the document, and writes it as the Markdown, recorded beside it", () => {
  const made = Object.entries(built()).map(([name, doc]): Fixture => {
    const document = shown(doc);
    const markdownNotCompared = MARKDOWN_NOT_COMPARED[name];
    return {
      name,
      update: base64(Y.encodeStateAsUpdate(doc)),
      document,
      ...(markdownNotCompared === undefined
        ? { markdown: writtenAsMarkdown(document) }
        : { markdownNotCompared }),
    };
  });
  if (WRITE_FIXTURES) writeFileSync(FILE, `${JSON.stringify(made, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(FILE, "utf8")) as Fixture[];
  expect(stored.map((fixture) => fixture.name)).toEqual(made.map((fixture) => fixture.name));
  for (const fixture of stored) {
    const doc = new Y.Doc({ gc: false });
    doc.getText(BODY_SEQUENCE_FIELD);
    doc.getMap(BODY_CONTAINERS_FIELD);
    Y.applyUpdate(doc, Buffer.from(fixture.update, "base64"));
    expect(shown(doc), fixture.name).toEqual(fixture.document);
    if ("markdown" in fixture)
      expect(writtenAsMarkdown(shown(doc)), fixture.name).toBe(fixture.markdown);
    doc.destroy();
  }
  expect(stored).toEqual(made);
});

const EDITED = "a note two people edited at length";

/**
 * A note two people edit in turns with their changes meeting: typing and deleting inside lines,
 * marks, splits, joins, kind changes and inline items.
 */
function editedAtLength(lines: number, edits: number) {
  let state = 20261123;
  const below = (limit: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * limit);
  };
  const WORDS = [
    "note",
    "plan",
    "trip",
    "day",
    "list",
    "the",
    "of",
    "and",
    "pack",
    "book",
    "train",
  ];
  const words = (count: number) =>
    Array.from({ length: count }, () => WORDS[below(WORDS.length)]!).join(" ");

  const first = note(30);
  for (let line = 0; line < lines; line++) {
    const text = words(8 + below(9));
    if (line % 10 === 0) first.line({ type: "heading", level: 2, path: [] }, text);
    else if (line % 25 >= 5 && line % 25 <= 7) {
      const list = `L${String(Math.floor(line / 25))}`;
      const item = `I${String(line)}`;
      if (line % 25 === 5) first.container(list, "bulletList");
      first.container(item, "listItem");
      first.line({ type: "paragraph", path: [list, item] }, text);
    } else first.line({ type: "paragraph", path: [] }, text);
  }
  const second = note(31, Y.encodeStateAsUpdate(first.doc));
  const FROM_THE_OTHER = "from the other person";
  const people = [first, second].map((person) => {
    const unsent: Uint8Array[] = [];
    person.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== FROM_THE_OTHER) unsent.push(update);
    });
    return { ...person, unsent };
  });
  const meet = () => {
    for (const [at, person] of people.entries())
      for (const update of person.unsent.splice(0))
        Y.applyUpdate(people[1 - at]!.doc, update, FROM_THE_OTHER);
  };
  const standingAt = (sequence: Y.Text, index: number) => {
    const formatting = new Map<string, unknown>();
    let boundary: Y.XmlElement | null = null;
    let left = index;
    for (let item = sequence._start; item !== null && left > 0; item = item.right) {
      if (item.deleted) continue;
      const content = item.content;
      if (content instanceof Y.ContentFormat) formatting.set(content.key, content.value);
      else {
        if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
          if (content.type.nodeName === BLOCK_ELEMENT) boundary = content.type;
        left -= item.length;
      }
    }
    return { boundary, formatting: Object.fromEntries(formatting) };
  };
  const element = (name: string, attrs: Record<string, unknown>) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    return made;
  };
  const MARKS = [
    () => ({ bold: {} }),
    () => ({ italic: {} }),
    () => ({ bold: null }),
    () => ({ italic: null }),
    () => ({ link: { href: `https://example.com/${String(below(50))}` } }),
    () => ({ link: null }),
  ];

  for (let edit = 0; edit < edits; edit++) {
    const { sequence } = people[edit % 2]!;
    const length = sequence.length;
    if (length < 64) break;
    const kind = below(100);
    const index = 1 + below(length - 40);
    if (kind < 55) sequence.insert(index, `${words(1 + below(3))} `);
    else if (kind < 70) sequence.delete(index, 1 + below(8));
    else if (kind < 82) sequence.format(index, 3 + below(28), MARKS[below(MARKS.length)]!());
    else if (kind < 92) {
      const { boundary, formatting } = standingAt(sequence, index);
      const path = boundary ? storedValue(boundary, "path") : [];
      sequence.insertEmbed(index, element(BLOCK_ELEMENT, { type: "paragraph", path }), formatting);
    } else if (kind < 96) {
      const { boundary } = standingAt(sequence, index);
      if (boundary && below(2) === 0) {
        boundary.setAttribute("type", "heading");
        boundary.setAttribute("level", (1 + below(3)) as unknown as string);
      } else boundary?.setAttribute("type", "paragraph");
    } else {
      const { formatting } = standingAt(sequence, index);
      const made =
        below(2) === 0
          ? element("hardBreak", {})
          : element("wikilink", { target: words(1), label: null });
      sequence.insertEmbed(index, made, formatting);
    }
    if (edit % 8 === 7) meet();
  }
  meet();
  return { first: first.doc, second: second.doc };
}

const LINK_ATTRIBUTES = ["href", "target", "rel", "class", "title"];
const OWN_ATTRIBUTES = ["level", "language", "tex", "source"];
const RECORD_ATTRIBUTES = [
  "checked",
  "loose",
  "start",
  "type",
  "calloutType",
  "title",
  "fold",
  "height",
  "colspan",
  "rowspan",
  "colwidth",
  "align",
];

/**
 * What a note's sequence holds, and the most nodes the engine spends to read it: one for each live
 * item, and for a boundary its path entries, the containers it opens with their records and first
 * paragraphs, and its own attributes; for an inline item its attributes; for a run of letters its
 * marks, read once and copied once.
 */
function storedItems(doc: Y.Doc) {
  const counts = { letters: 0, formatting: 0, boundaries: 0, inlineItems: 0, other: 0, deleted: 0 };
  const marks = new Map<string, number>();
  let nodesAtMost = 1;
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  const container = (id: unknown) => {
    let nodes = 2;
    for (const attribute of RECORD_ATTRIBUTES) {
      const record = storedValue(records, `${String(id)}.${attribute}`);
      if (record !== undefined) nodes += 1 + (Array.isArray(record) ? record.length : 0);
    }
    return nodes;
  };
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted) {
      counts.deleted++;
      continue;
    }
    nodesAtMost++;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      counts.letters++;
      for (const cost of marks.values()) nodesAtMost += 2 * cost;
    } else if (content instanceof Y.ContentFormat) {
      counts.formatting++;
      const value = content.value as unknown;
      const on = typeof value === "object" && value !== null && !Array.isArray(value);
      const attributes =
        on && content.key === "link"
          ? LINK_ATTRIBUTES.filter((key) => Object.hasOwn(value, key)).length
          : 0;
      if (on) marks.set(content.key, 1 + attributes);
      else marks.delete(content.key);
    } else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const stored = [...content.type._map.keys()].filter(
        (key) => storedValue(content.type as Y.XmlElement, key) !== undefined,
      );
      if (content.type.nodeName === BLOCK_ELEMENT) {
        counts.boundaries++;
        const stood = storedValue(content.type, "path");
        const path = Array.isArray(stood) ? (stood as unknown[]).slice(0, 64) : [];
        nodesAtMost +=
          1 + path.length + stored.filter((key) => OWN_ATTRIBUTES.includes(key)).length;
        for (const id of path) nodesAtMost += container(id);
      } else {
        counts.inlineItems++;
        nodesAtMost += 1 + stored.length;
      }
    } else counts.other++;
  }
  const live =
    counts.letters + counts.formatting + counts.boundaries + counts.inlineItems + counts.other;
  return { ...counts, live, nodesAtMost };
}

it("counts what a note two people edited at length stores, and reads it the same reopened", () => {
  const { first, second } = editedAtLength(120, 1500);
  expect(shown(second)).toEqual(shown(first));
  const made = {
    name: EDITED,
    update: base64(Y.encodeStateAsUpdate(first)),
    document: shown(first),
    stored: storedItems(first),
  };
  if (WRITE_FIXTURES) writeFileSync(EDITED_FILE, `${JSON.stringify(made)}\n`);
  const kept = JSON.parse(readFileSync(EDITED_FILE, "utf8")) as typeof made;
  const reopened = new Y.Doc({ gc: false });
  reopened.getText(BODY_SEQUENCE_FIELD);
  reopened.getMap(BODY_CONTAINERS_FIELD);
  Y.applyUpdate(reopened, Buffer.from(kept.update, "base64"));
  expect(shown(reopened)).toEqual(kept.document);
  expect(storedItems(reopened)).toEqual(kept.stored);
  expect(kept).toEqual(made);
  reopened.destroy();
});

const MEASURED = process.env.BODY_SEQUENCE_MEASURE_OUT;

it.runIf(MEASURED !== undefined)(
  "measures what longer notes two people edited store",
  { timeout: 30 * 60_000 },
  () => {
    for (const [lines, edits] of [
      [1_000, 10_000],
      [10_000, 30_000],
      [10_000, 100_000],
    ] as const) {
      const started = Date.now();
      const note = editedAtLength(lines, edits).first;
      const bytes = Y.encodeStateAsUpdate(note).length;
      const measured = { lines, edits, ...storedItems(note), bytes, ms: Date.now() - started };
      appendFileSync(
        MEASURED!,
        `${JSON.stringify(measured)}
`,
      );
    }
  },
);

function updatesBuilt(): Record<string, string> {
  const person = (clientID: number, from?: Uint8Array) => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = clientID;
    const sequence = doc.getText(BODY_SEQUENCE_FIELD);
    if (from) Y.applyUpdate(doc, from);
    return { doc, sequence };
  };
  const element = (name: string, attrs: Record<string, string | number>) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    return made;
  };
  const changeOf = (doc: Y.Doc, change: () => void) => {
    const updates: Uint8Array[] = [];
    const keep = (update: Uint8Array) => updates.push(update);
    doc.on("update", keep);
    change();
    doc.off("update", keep);
    expect(updates).toHaveLength(1);
    return updates[0]!;
  };

  const { doc, sequence } = person(1);
  doc.transact(() => {
    sequence.insertEmbed(0, element(BLOCK_ELEMENT, { type: "paragraph" }));
    sequence.insert(1, "One");
    sequence.insertEmbed(4, element(BLOCK_ELEMENT, { type: "heading", level: 2 }));
    sequence.insert(5, "Two");
    sequence.insertEmbed(8, element("image", { src: "a.png" }));
    sequence.insert(9, "x", { link: { href: "https://example.com", title: "Example" } });
    sequence.format(2, 5, { bold: true });
  });
  const seed = Y.encodeStateAsUpdate(doc);

  const joiner = person(2, seed);
  const history = new Y.UndoManager(joiner.sequence);
  const join = changeOf(joiner.doc, () => joiner.sequence.delete(4, 1));
  const undoJoin = changeOf(joiner.doc, () => history.undo());
  history.destroy();

  const changer = person(3, seed);
  const boundary = (changer.sequence.toDelta() as { insert: unknown }[])[3]!.insert;
  if (!(boundary instanceof Y.XmlElement)) throw new Error("the fourth piece is the heading");
  const changeType = changeOf(changer.doc, () => boundary.setAttribute("type", "codeBlock"));

  const remover = person(4, seed);
  const deleteBoundary = changeOf(remover.doc, () => remover.sequence.delete(4, 1));

  sequence.insertEmbed(10, new Y.Map([["label", "metadata"]]));
  return Object.fromEntries(
    Object.entries({
      seed,
      join,
      undo_join: undoJoin,
      change_type: changeType,
      delete_boundary: deleteBoundary,
      with_map: Y.encodeStateAsUpdate(doc),
    }).map(([name, update]) => [name, base64(update)]),
  );
}

it("gives the engine's Yjs library the same updates each time they are rebuilt", () => {
  const made = updatesBuilt();
  if (WRITE_FIXTURES) writeFileSync(UPDATES_FILE, `${JSON.stringify(made, null, 2)}\n`);
  expect(JSON.parse(readFileSync(UPDATES_FILE, "utf8"))).toEqual(made);
});

it("reads what is stored, not what a key named __proto__ or an embedded string makes Yjs show", () => {
  const made = note(9);
  made.doc.transact((transaction) => {
    new Y.Item(
      Y.createID(made.doc.clientID, Y.getState(made.doc.store, made.doc.clientID)),
      null,
      null,
      null,
      null,
      made.sequence,
      null,
      new Y.ContentEmbed("ghost"),
    ).integrate(transaction, 0);
  });
  const boundary = new Y.XmlElement(BLOCK_ELEMENT);
  boundary.setAttribute("__proto__", { type: "heading", level: 5 } as unknown as string);
  made.sequence.insertEmbed(made.sequence.length, boundary, {});
  made.sequence.insert(made.sequence.length, "real", named("__proto__", { bold: {} }));
  made.sequence.insert(
    made.sequence.length,
    " link",
    named("link", named("__proto__", { href: "https://example.com" })),
  );
  const reopened = new Y.Doc({ gc: false });
  reopened.getText(BODY_SEQUENCE_FIELD);
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(made.doc));
  for (const doc of [made.doc, reopened])
    expect(shown(doc)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "real" },
            {
              type: "text",
              text: " link",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: null,
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: null,
                    title: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  reopened.destroy();
});

it("keeps a link whose value holds a key named __proto__, however the note was encoded", () => {
  const made = note(11);
  made.line({ type: "paragraph", path: [] });
  made.text("x", {
    link: JSON.parse('{"__proto__":{"extra":1},"href":"https://example.com/kept"}') as unknown,
  });
  const reopened = (encode: (doc: Y.Doc) => Uint8Array, apply: typeof Y.applyUpdate) => {
    const doc = new Y.Doc({ gc: false });
    doc.getText(BODY_SEQUENCE_FIELD);
    apply(doc, encode(made.doc));
    return doc;
  };
  const first = reopened(Y.encodeStateAsUpdate, Y.applyUpdate);
  const second = reopened(Y.encodeStateAsUpdateV2, Y.applyUpdateV2);
  for (const doc of [made.doc, first, second])
    expect(shown(doc)).toMatchObject({
      content: [
        {
          content: [
            { text: "x", marks: [{ type: "link", attrs: { href: "https://example.com/kept" } }] },
          ],
        },
      ],
    });
  first.destroy();
  second.destroy();
});

it("takes an attribute or a record only from an item that holds plain values", () => {
  const made = note(10);
  const keyed = (holder: Y.XmlElement | Y.Map<unknown>, key: string, content: Y.Item["content"]) =>
    made.doc.transact((transaction) => {
      new Y.Item(
        Y.createID(made.doc.clientID, Y.getState(made.doc.store, made.doc.clientID)),
        null,
        null,
        null,
        null,
        holder,
        key,
        content,
      ).integrate(transaction, 0);
    });
  const boundary = new Y.XmlElement(BLOCK_ELEMENT);
  boundary.setAttribute("path", ["q", "c"] as unknown as string);
  made.sequence.insertEmbed(0, boundary, {});
  made.sequence.insert(1, "plain");
  keyed(boundary, "type", new Y.ContentString("heading"));
  keyed(boundary, "level", new Y.ContentJSON([3]));
  keyed(made.records, "q", new Y.ContentEmbed("blockquote"));
  keyed(made.records, "c", new Y.ContentJSON(["callout"]));
  const several = new Y.XmlElement(BLOCK_ELEMENT);
  made.sequence.insertEmbed(made.sequence.length, several, {});
  made.sequence.insert(made.sequence.length, "last value");
  keyed(several, "type", new Y.ContentAny(["codeBlock", "heading"]));
  keyed(several, "level", new Y.ContentAny([5, 2]));
  const reopened = new Y.Doc({ gc: false });
  reopened.getText(BODY_SEQUENCE_FIELD);
  reopened.getMap(BODY_CONTAINERS_FIELD);
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(made.doc));
  for (const doc of [made.doc, reopened])
    expect(shown(doc)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "last value" }] },
      ],
    });
  reopened.destroy();
});

it("reads the join that two people made and one undid as three lines with the typed letter", () => {
  const stored = JSON.parse(readFileSync(FILE, "utf8")) as Fixture[];
  const document = stored.at(-1)!.document as { content: { content?: { text: string }[] }[] };
  expect(document.content.map((line) => line.content?.map((part) => part.text).join(""))).toEqual([
    "One one",
    "Two Xtwo two",
    "Three",
  ]);
});
