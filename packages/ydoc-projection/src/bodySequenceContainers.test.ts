import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { getDohcProseMirrorSchema } from "./import-export.js";
import {
  boundaryOfLeaf,
  leavesOfSequence,
  readBodyLeaves,
  type SequenceFrame,
  type SequenceLeaf,
  type SequencePiece,
} from "./bodySequenceGrammar.js";

const schema = getDohcProseMirrorSchema();
const FIELD = "sequence";
const REMOTE = Symbol("remote");
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

type Change = { insert: unknown; attributes?: Record<string, unknown> };
const isElement = (value: unknown): value is Y.XmlElement => value instanceof Y.XmlElement;
const set = (element: Y.XmlElement, key: string, value: unknown) =>
  element.setAttribute(key, value as string);

function pieces(text: Y.Text): SequencePiece[] {
  return (text.toDelta() as Change[]).map(({ insert, attributes }) =>
    isElement(insert)
      ? { boundary: insert.getAttributes() as Record<string, unknown> }
      : { text: String(insert), marks: attributes ?? {} },
  );
}

function shown(doc: Y.Doc) {
  const node = readBodyLeaves(schema, leavesOfSequence(pieces(doc.getText(FIELD))));
  node.check();
  return node.toJSON() as unknown;
}

function boundary(leaf: Omit<SequenceLeaf, "inline">) {
  const element = new Y.XmlElement("block");
  for (const [key, value] of Object.entries(boundaryOfLeaf(leaf))) set(element, key, value);
  return element;
}

type Line = { path: SequenceFrame[]; text: string };

function note(...lines: Line[]) {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const text = doc.getText(FIELD);
  for (const line of lines) {
    text.insertEmbed(text.length, boundary({ type: "paragraph", attrs: {}, path: line.path }), {});
    text.insert(text.length, line.text, {});
  }
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

function person(baseline: Uint8Array, clientID: number) {
  const doc = new Y.Doc();
  docs.push(doc);
  doc.clientID = clientID;
  const text = doc.getText(FIELD);
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const changes = () => text.toDelta() as Change[];
  return {
    doc,
    text,
    sent,
    line: (index: number) =>
      changes()
        .map(({ insert }) => insert)
        .filter(isElement)[index]!,
    indexOf(index: number) {
      let at = 0;
      let seen = 0;
      for (const { insert } of changes()) {
        if (isElement(insert) && seen++ === index) return at;
        at += isElement(insert) ? 1 : String(insert).length;
      }
      throw new Error("no such line");
    },
  };
}
type Person = ReturnType<typeof person>;

function settle(...people: Person[]) {
  const all = people.map((each) => each.sent.splice(0));
  people.forEach((to, index) =>
    all.forEach((updates, from) => {
      if (from !== index) for (const update of updates) Y.applyUpdate(to.doc, update, REMOTE);
    }),
  );
  const first = shown(people[0]!.doc);
  for (const each of people.slice(1)) expect(shown(each.doc)).toEqual(first);
  return first;
}

const todos: SequenceFrame = { type: "taskList", id: "L", attrs: {} };
const item = (id: string, checked = false): SequenceFrame => ({
  type: "taskItem",
  id,
  attrs: { checked },
});
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function indentSecondUnderFirst(indenter: Person) {
  indenter.doc.transact(() => {
    const line = indenter.line(1);
    set(line, "depth", 4);
    set(line, "c1", { t: "taskItem", id: "I1" });
    set(line, "a.I1", { checked: false });
    set(line, "c2", { t: "taskList", id: "L2" });
    set(line, "a.L2", {});
    set(line, "c3", { t: "taskItem", id: "I2" });
  });
}

it("keeps a tick when someone indents the same to-do at the same moment", () => {
  const baseline = note(
    { path: [todos, item("I1")], text: "one" },
    { path: [todos, item("I2")], text: "two" },
  );
  for (const tickerId of [10, 30]) {
    const ticker = person(baseline, tickerId);
    const indenter = person(baseline, 20);
    set(ticker.line(1), "a.I2", { checked: true });
    indentSecondUnderFirst(indenter);
    expect(settle(ticker, indenter), String(tickerId)).toMatchObject({
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [
                paragraph("one"),
                {
                  type: "taskList",
                  content: [
                    { type: "taskItem", attrs: { checked: true }, content: [paragraph("two")] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  }
});

it("keeps a list's start number when its first item is joined away at the same moment", () => {
  const list: SequenceFrame = { type: "orderedList", id: "L", attrs: { start: 1 } };
  const entry = (id: string): SequenceFrame => ({ type: "listItem", id, attrs: {} });
  const baseline = note(
    { path: [], text: "intro" },
    { path: [list, entry("a")], text: "a" },
    { path: [list, entry("b")], text: "b" },
    { path: [list, entry("c")], text: "c" },
  );
  const renumberer = person(baseline, 10);
  const joiner = person(baseline, 20);
  renumberer.doc.transact(() => {
    for (const line of [1, 2, 3]) set(renumberer.line(line), "a.L", { start: 5 });
  });
  joiner.text.delete(joiner.indexOf(1), 1);
  expect(settle(renumberer, joiner)).toMatchObject({
    content: [
      paragraph("introa"),
      {
        type: "orderedList",
        attrs: { start: 5 },
        content: [
          { type: "listItem", content: [paragraph("b")] },
          { type: "listItem", content: [paragraph("c")] },
        ],
      },
    ],
  });
});

it("keeps a tick when someone adds a second paragraph to the same to-do", () => {
  const baseline = note({ path: [todos, item("I1")], text: "one" });
  const ticker = person(baseline, 10);
  const writer = person(baseline, 20);
  set(ticker.line(0), "a.I1", { checked: true });
  writer.doc.transact(() => {
    writer.text.insertEmbed(
      writer.text.length,
      boundary({ type: "paragraph", attrs: {}, path: [todos, item("I1")] }),
      {},
    );
    writer.text.insert(writer.text.length, "more", {});
  });
  expect(settle(ticker, writer)).toMatchObject({
    content: [
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [paragraph("one"), paragraph("more")],
          },
        ],
      },
    ],
  });
});

it("reads a valid note with every letter when one indents and another outdents a to-do", () => {
  const baseline = note(
    { path: [todos, item("I1")], text: "one" },
    { path: [todos, item("I2")], text: "two" },
  );
  for (const [inner, outer] of [
    [10, 20],
    [20, 10],
  ] as const) {
    const indenter = person(baseline, inner);
    const outdenter = person(baseline, outer);
    indentSecondUnderFirst(indenter);
    set(outdenter.line(1), "depth", 0);
    const text = JSON.stringify(settle(indenter, outdenter));
    expect(text).toContain('"one"');
    expect(text).toContain('"two"');
  }
});
