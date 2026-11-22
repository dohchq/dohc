import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { getDohcProseMirrorSchema } from "./import-export.js";
import {
  BLOCK_ELEMENT,
  leavesOfSequence,
  readBodyLeaves,
  type SequencePiece,
} from "./bodySequenceGrammar.js";

const schema = getDohcProseMirrorSchema();
const FIELD = "sequence";
const CONTAINERS = "containers";
const REMOTE = Symbol("remote");
const LOCAL = Symbol("local");
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

type Change = { insert: unknown; attributes?: Record<string, unknown> };
const isBoundary = (value: unknown): value is Y.XmlElement =>
  value instanceof Y.XmlElement && value.nodeName === BLOCK_ELEMENT;

function pieces(text: Y.Text): SequencePiece[] {
  return (text.toDelta() as Change[]).flatMap(({ insert, attributes }): SequencePiece[] => {
    if (isBoundary(insert))
      return [{ boundary: insert.getAttributes() as Record<string, unknown> }];
    if (insert instanceof Y.XmlElement)
      return [{ atom: insert.nodeName, attrs: insert.getAttributes() as Record<string, unknown> }];
    return typeof insert === "string" ? [{ text: insert, marks: attributes ?? {} }] : [];
  });
}

function shown(doc: Y.Doc) {
  const node = readBodyLeaves(
    schema,
    leavesOfSequence(schema, pieces(doc.getText(FIELD)), doc.getMap(CONTAINERS)),
  );
  node.check();
  return node.toJSON() as unknown;
}

function boundary(path: string[]) {
  const element = new Y.XmlElement(BLOCK_ELEMENT);
  element.setAttribute("type", "paragraph");
  if (path.length > 0) element.setAttribute("path", path as unknown as string);
  return element;
}

type Line = { path: string[]; text: string };

function note(records: Record<string, unknown>, ...lines: Line[]) {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.getMap(CONTAINERS);
  const text = doc.getText(FIELD);
  for (const [key, value] of Object.entries(records)) doc.getMap(CONTAINERS).set(key, value);
  for (const line of lines) {
    text.insertEmbed(text.length, boundary(line.path), {});
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
  const records = doc.getMap<unknown>(CONTAINERS);
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const history = new Y.UndoManager([text, records], {
    trackedOrigins: new Set([LOCAL]),
    ignoreRemoteMapChanges: true,
  });
  const changes = () => text.toDelta() as Change[];
  return {
    doc,
    text,
    records,
    sent,
    history,
    change: (act: () => void) => doc.transact(act, LOCAL),
    line: (index: number) =>
      changes()
        .map(({ insert }) => insert)
        .filter(isBoundary)[index]!,
    indexOf(index: number) {
      let at = 0;
      let seen = 0;
      for (const { insert } of changes()) {
        if (isBoundary(insert) && seen++ === index) return at;
        at += typeof insert === "string" ? insert.length : 1;
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
  for (const each of people) {
    expect(shown(each.doc)).toEqual(first);
    const reopened = new Y.Doc();
    reopened.getText(FIELD);
    reopened.getMap(CONTAINERS);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(each.doc));
    expect(shown(reopened)).toEqual(first);
    reopened.destroy();
  }
  return first;
}

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const todo = (checked: boolean, ...content: unknown[]) => ({
  type: "taskItem",
  attrs: { checked },
  content,
});
const twoTodos = () =>
  note(
    { L: "taskList", I1: "taskItem", "I1.checked": false, I2: "taskItem", "I2.checked": false },
    { path: ["L", "I1"], text: "one" },
    { path: ["L", "I2"], text: "two" },
  );

function indentSecondUnderFirst(indenter: Person) {
  indenter.change(() => {
    indenter.records.set("L2", "taskList");
    indenter.line(1).setAttribute("path", ["L", "I1", "L2", "I2"] as unknown as string);
  });
}

it("keeps a tick when someone indents the same to-do at the same moment", () => {
  for (const tickerId of [10, 30]) {
    const ticker = person(twoTodos(), tickerId);
    const indenter = person(twoTodos(), 20);
    ticker.change(() => ticker.records.set("I2.checked", true));
    indentSecondUnderFirst(indenter);
    expect(settle(ticker, indenter), String(tickerId)).toMatchObject({
      content: [
        {
          type: "taskList",
          content: [
            todo(false, paragraph("one"), {
              type: "taskList",
              content: [todo(true, paragraph("two"))],
            }),
          ],
        },
      ],
    });
  }
});

it("keeps a tick through a second paragraph added at the same moment and the first one's later delete", () => {
  const baseline = note(
    { L: "taskList", I1: "taskItem", "I1.checked": false },
    { path: ["L", "I1"], text: "one" },
  );
  const ticker = person(baseline, 10);
  const writer = person(baseline, 20);
  ticker.change(() => ticker.records.set("I1.checked", true));
  writer.change(() => {
    writer.text.insertEmbed(writer.text.length, boundary(["L", "I1"]), {});
    writer.text.insert(writer.text.length, "more", {});
  });
  expect(settle(ticker, writer)).toMatchObject({
    content: [{ type: "taskList", content: [todo(true, paragraph("one"), paragraph("more"))] }],
  });
  ticker.change(() => ticker.text.delete(ticker.indexOf(0), 4));
  expect(settle(ticker, writer)).toMatchObject({
    content: [{ type: "taskList", content: [todo(true, paragraph("more"))] }],
  });
});

it("keeps a list's start number when its first item is joined away at the same moment", () => {
  const baseline = note(
    { L: "orderedList", "L.start": 1, a: "listItem", b: "listItem", c: "listItem" },
    { path: [], text: "intro" },
    { path: ["L", "a"], text: "a" },
    { path: ["L", "b"], text: "b" },
    { path: ["L", "c"], text: "c" },
  );
  const renumberer = person(baseline, 10);
  const joiner = person(baseline, 20);
  renumberer.change(() => renumberer.records.set("L.start", 5));
  joiner.change(() => joiner.text.delete(joiner.indexOf(1), 1));
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

it("takes one person's whole path when one indents and another outdents a to-do", () => {
  for (const [inner, outer] of [
    [10, 20],
    [20, 10],
  ] as const) {
    const indenter = person(twoTodos(), inner);
    const outdenter = person(twoTodos(), outer);
    indentSecondUnderFirst(indenter);
    outdenter.change(() => outdenter.line(1).setAttribute("path", [] as unknown as string));
    const top = (settle(indenter, outdenter) as { content: { type: string }[] }).content;
    const nested = {
      content: [
        {
          type: "taskList",
          content: [
            todo(false, paragraph("one"), {
              type: "taskList",
              content: [todo(false, paragraph("two"))],
            }),
          ],
        },
      ],
    };
    const lifted = {
      content: [{ type: "taskList", content: [todo(false, paragraph("one"))] }, paragraph("two")],
    };
    expect({ content: top }).toMatchObject(top.length === 1 ? nested : lifted);
    expect(top.length === 1 ? 1 : top.length).toBeLessThanOrEqual(2);
  }
});

it("turns a list into a to-do list for every item, with an item added at the same moment", () => {
  const baseline = note(
    { L: "bulletList", a: "listItem", b: "listItem" },
    { path: ["L", "a"], text: "a" },
    { path: ["L", "b"], text: "b" },
  );
  const changer = person(baseline, 10);
  const adder = person(baseline, 20);
  changer.change(() => {
    changer.records.set("L", "taskList");
    for (const id of ["a", "b"]) {
      changer.records.set(id, "taskItem");
      changer.records.set(`${id}.checked`, false);
    }
  });
  adder.change(() => {
    adder.records.set("c", "listItem");
    adder.text.insertEmbed(adder.text.length, boundary(["L", "c"]), {});
    adder.text.insert(adder.text.length, "c", {});
  });
  const text = JSON.stringify(settle(changer, adder));
  for (const letter of ["a", "b", "c"]) expect(text).toContain(`"text":"${letter}"`);
  expect(text).toContain('"type":"taskList"');
  expect(text).not.toContain('"type":"bulletList"');
});

it("undoes a tick, and brings a joined line back in its to-do", () => {
  const first = person(twoTodos(), 10);
  const second = person(twoTodos(), 20);
  first.change(() => first.records.set("I2.checked", true));
  first.history.stopCapturing();
  first.change(() => first.text.delete(first.indexOf(1), 1));
  expect(settle(first, second)).toMatchObject({
    content: [{ type: "taskList", content: [todo(false, paragraph("onetwo"))] }],
  });
  first.history.undo();
  expect(settle(first, second)).toMatchObject({
    content: [
      { type: "taskList", content: [todo(false, paragraph("one")), todo(true, paragraph("two"))] },
    ],
  });
  first.history.undo();
  expect(settle(first, second)).toMatchObject({
    content: [
      { type: "taskList", content: [todo(false, paragraph("one")), todo(false, paragraph("two"))] },
    ],
  });
});

it("unwraps a line added to a quote at the same moment the quote is undone", () => {
  const baseline = note({}, { path: [], text: "one" });
  const wrapper = person(baseline, 10);
  const writer = person(baseline, 20);
  wrapper.change(() => {
    wrapper.records.set("q", "blockquote");
    wrapper.line(0).setAttribute("path", ["q"] as unknown as string);
  });
  settle(wrapper, writer);
  writer.change(() => {
    writer.text.insertEmbed(writer.text.length, boundary(["q"]), {});
    writer.text.insert(writer.text.length, "two", {});
  });
  wrapper.history.undo();
  expect(settle(wrapper, writer)).toEqual({
    type: "doc",
    content: [paragraph("one"), paragraph("two")],
  });
});
