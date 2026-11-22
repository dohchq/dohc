import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  recordsOfContainer,
} from "./bodySequenceGrammar.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";

const schema = getDohcProseMirrorSchema();
const FILE = fileURLToPath(new URL("./fixtures/body-sequence.json", import.meta.url));

type Fixture = { name: string; update: string; document: unknown };

function note(clientID: number, from?: Uint8Array) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  doc.getMap("meta").set("schemaVersion", 2);
  if (from) Y.applyUpdate(doc, from);
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
      sequence.insertEmbed(sequence.length, element(BLOCK_ELEMENT, attrs), {});
      if (text) sequence.insert(sequence.length, text, marks);
    },
    text(text: string, marks: Record<string, unknown> = {}) {
      sequence.insert(sequence.length, text, marks);
    },
    item(name: string, attrs: Record<string, unknown>) {
      sequence.insertEmbed(sequence.length, element(name, attrs), {});
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

  const base = note(4);
  base.line({ type: "paragraph", path: [] }, "One one");
  base.line({ type: "paragraph", path: [] }, "Two two two");
  base.line({ type: "paragraph", path: [] }, "Three");
  const start = Y.encodeStateAsUpdate(base.doc);
  const first = note(5, start);
  const second = note(6, start);
  const history = new Y.UndoManager([first.sequence, first.records], {
    ignoreRemoteMapChanges: true,
    deleteFilter: (item) => item.parent !== first.records,
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
    "both joined one line, one typed, one undid": second.doc,
  };
}

const shown = (doc: Y.Doc) => {
  const node = readBodySequence(schema, doc);
  node.check();
  return node.toJSON() as unknown;
};

it("reads each stored note as the document recorded beside it", () => {
  const made = Object.entries(built()).map(([name, doc]): Fixture => ({
    name,
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    document: shown(doc),
  }));
  if (process.env.BODY_SEQUENCE_WRITE_FIXTURES === "1")
    writeFileSync(FILE, `${JSON.stringify(made, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(FILE, "utf8")) as Fixture[];
  expect(stored.map((fixture) => fixture.name)).toEqual(made.map((fixture) => fixture.name));
  for (const fixture of stored) {
    const doc = new Y.Doc({ gc: false });
    doc.getText(BODY_SEQUENCE_FIELD);
    doc.getMap(BODY_CONTAINERS_FIELD);
    Y.applyUpdate(doc, Buffer.from(fixture.update, "base64"));
    expect(shown(doc), fixture.name).toEqual(fixture.document);
    doc.destroy();
  }
  expect(stored).toEqual(made);
});

it("reads what is stored, not what a key named __proto__ or an embedded string makes Yjs show", () => {
  const made = note(9);
  const named = (key: string, value: unknown) => Object.fromEntries([[key, value]]);
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

it("reads the join that two people made and one undid as three lines with the typed letter", () => {
  const stored = JSON.parse(readFileSync(FILE, "utf8")) as Fixture[];
  const document = stored.at(-1)!.document as { content: { content?: { text: string }[] }[] };
  expect(document.content.map((line) => line.content?.map((part) => part.text).join(""))).toEqual([
    "One one",
    "Two Xtwo two",
    "Three",
  ]);
});
