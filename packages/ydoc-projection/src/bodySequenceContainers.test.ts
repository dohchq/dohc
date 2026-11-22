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
const REMOTE_FREE = Symbol("the default, written outside the history");
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
  element.setAttribute("path", path as unknown as string);
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
    deleteFilter: (item) => item.parent !== records,
  });
  const changes = () => text.toDelta() as Change[];
  return {
    doc,
    text,
    records,
    sent,
    history,
    change: (act: () => void) => doc.transact(act, LOCAL),
    write(key: string, value: unknown, whenMissing: unknown) {
      if (!records.has(key)) doc.transact(() => records.set(key, whenMissing), REMOTE_FREE);
      doc.transact(() => records.set(key, value), LOCAL);
    },
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

const twoBullets = () =>
  note(
    { L: "bulletList", a: "listItem", b: "listItem" },
    { path: ["L", "a"], text: "a" },
    { path: ["L", "b"], text: "b" },
  );
const item = (type: string, text: string) => ({ type, content: [paragraph(text)] });
const toTodos = (changer: Person) =>
  changer.change(() => {
    changer.records.set("L", "taskList");
    for (const id of ["a", "b"]) {
      changer.records.set(id, "taskItem");
      changer.records.set(`${id}.checked`, false);
    }
  });

it("keeps a list one list when it becomes to-dos and someone adds an item in the middle", () => {
  const changer = person(twoBullets(), 10);
  const adder = person(twoBullets(), 20);
  toTodos(changer);
  adder.change(() => {
    adder.records.set("c", "listItem");
    const at = adder.indexOf(1);
    adder.text.insertEmbed(at, boundary(["L", "c"]), {});
    adder.text.insert(at + 1, "c", {});
  });
  expect(settle(changer, adder)).toMatchObject({
    content: [
      {
        type: "taskList",
        content: [item("taskItem", "a"), item("taskItem", "c"), item("taskItem", "b")],
      },
    ],
  });
});

it("keeps a list one list when two people change its kind differently at the same moment", () => {
  for (const [numberer, ticker] of [
    [20, 10],
    [10, 20],
  ] as const) {
    const first = person(twoBullets(), numberer);
    const second = person(twoBullets(), ticker);
    first.change(() => first.records.set("L", "orderedList"));
    toTodos(second);
    const top = (settle(first, second) as { content: { type: string; content: unknown[] }[] })
      .content;
    expect(top).toHaveLength(1);
    const kind = top[0]!.type;
    expect(["orderedList", "taskList"]).toContain(kind);
    const each = kind === "taskList" ? "taskItem" : "listItem";
    expect(top[0]).toMatchObject({ content: [item(each, "a"), item(each, "b")] });
  }
});

it("keeps a list one list when its change to a numbered list is undone after it became to-dos", () => {
  const first = person(twoBullets(), 10);
  const second = person(twoBullets(), 20);
  first.change(() => first.records.set("L", "orderedList"));
  settle(first, second);
  toTodos(second);
  settle(first, second);
  first.history.undo();
  expect(settle(first, second)).toMatchObject({
    content: [{ type: "bulletList", content: [item("listItem", "a"), item("listItem", "b")] }],
  });
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

it("leaves a line someone added to a quote in the quote when the quote is undone", () => {
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
    content: [paragraph("one"), { type: "blockquote", content: [paragraph("two")] }],
  });
});

it("keeps a to-do someone added to a list when the change that made the list is undone", () => {
  const baseline = note(
    {
      L: "taskList",
      I1: "taskItem",
      "I1.checked": false,
      I2: "taskItem",
      "I2.checked": false,
      I3: "taskItem",
      "I3.checked": false,
    },
    { path: ["L", "I1"], text: "one" },
    { path: ["L", "I2"], text: "two" },
    { path: ["L", "I3"], text: "three" },
  );
  const splitter = person(baseline, 10);
  const adder = person(baseline, 20);
  splitter.change(() => {
    splitter.records.set("L2", "taskList");
    splitter.line(1).setAttribute("path", [] as unknown as string);
    splitter.line(2).setAttribute("path", ["L2", "I3"] as unknown as string);
  });
  settle(splitter, adder);
  adder.change(() => {
    adder.records.set("I4", "taskItem");
    adder.records.set("I4.checked", false);
    adder.text.insertEmbed(adder.text.length, boundary(["L2", "I4"]), {});
    adder.text.insert(adder.text.length, "four", {});
  });
  settle(splitter, adder);
  splitter.history.undo();
  expect(settle(splitter, adder)).toMatchObject({
    content: [
      {
        type: "taskList",
        content: [
          todo(false, paragraph("one")),
          todo(false, paragraph("two")),
          todo(false, paragraph("three")),
        ],
      },
      { type: "taskList", content: [todo(false, paragraph("four"))] },
    ],
  });
});

it("reads one callout as two when a line is lifted out of it while another is added to it", () => {
  const baseline = note(
    { q: "callout", "q.calloutType": "note", "q.title": "Note", "q.fold": "" },
    { path: ["q"], text: "a" },
    { path: ["q"], text: "b" },
  );
  const lifter = person(baseline, 10);
  const adder = person(baseline, 20);
  lifter.change(() => lifter.line(1).setAttribute("path", [] as unknown as string));
  adder.change(() => {
    adder.text.insertEmbed(adder.text.length, boundary(["q"]), {});
    adder.text.insert(adder.text.length, "c", {});
  });
  const callout = (text: string) => ({
    type: "callout",
    attrs: { title: "Note" },
    content: [paragraph(text)],
  });
  expect(settle(lifter, adder)).toMatchObject({
    content: [callout("a"), paragraph("b"), callout("c")],
  });
});

it("undoes a tick on an item that became a to-do through its list, and nothing before it", () => {
  const baseline = note({ L: "bulletList", a: "listItem" }, { path: ["L", "a"], text: "a" });
  const changer = person(baseline, 10);
  const adder = person(baseline, 20);
  changer.change(() => {
    changer.records.set("L", "taskList");
    changer.records.set("a", "taskItem");
    changer.records.set("a.checked", false);
  });
  adder.change(() => {
    adder.records.set("b", "listItem");
    adder.text.insertEmbed(adder.text.length, boundary(["L", "b"]), {});
    adder.text.insert(adder.text.length, "b", {});
  });
  settle(changer, adder);
  adder.history.stopCapturing();
  adder.change(() => adder.text.insert(adder.text.length, "!", {}));
  adder.history.stopCapturing();
  adder.write("b.checked", true, false);
  expect(settle(changer, adder)).toMatchObject({
    content: [
      { type: "taskList", content: [todo(false, paragraph("a")), todo(true, paragraph("b!"))] },
    ],
  });
  adder.history.undo();
  expect(settle(changer, adder)).toMatchObject({
    content: [
      { type: "taskList", content: [todo(false, paragraph("a")), todo(false, paragraph("b!"))] },
    ],
  });
});

it("undoes a start number set after a list became numbered, and nothing before it", () => {
  const baseline = note({ L: "bulletList", a: "listItem" }, { path: ["L", "a"], text: "item" });
  const first = person(baseline, 10);
  const second = person(baseline, 20);
  first.change(() => first.records.set("L", "orderedList"));
  first.history.stopCapturing();
  first.change(() => first.text.insert(first.text.length, "!", {}));
  first.history.stopCapturing();
  first.write("L.start", 5, 1);
  expect(settle(first, second)).toMatchObject({
    content: [{ type: "orderedList", attrs: { start: 5 }, content: [item("listItem", "item!")] }],
  });
  first.history.undo();
  expect(settle(first, second)).toMatchObject({
    content: [{ type: "orderedList", attrs: { start: 1 }, content: [item("listItem", "item!")] }],
  });
  first.history.undo();
  expect(settle(first, second)).toMatchObject({
    content: [{ type: "orderedList", content: [item("listItem", "item")] }],
  });
});

it("keeps a callout's settings for a line someone added when the callout's making is undone", () => {
  const baseline = note({}, { path: [], text: "one" });
  const maker = person(baseline, 10);
  const adder = person(baseline, 20);
  maker.change(() => {
    maker.records.set("c1", "callout");
    maker.records.set("c1.calloutType", "warning");
    maker.records.set("c1.title", "Danger");
    maker.records.set("c1.fold", "-");
    maker.line(0).setAttribute("path", ["c1"] as unknown as string);
  });
  settle(maker, adder);
  adder.change(() => {
    adder.text.insertEmbed(adder.text.length, boundary(["c1"]), {});
    adder.text.insert(adder.text.length, "two", {});
  });
  settle(maker, adder);
  maker.history.undo();
  expect(settle(maker, adder)).toMatchObject({
    content: [
      paragraph("one"),
      {
        type: "callout",
        attrs: { calloutType: "warning", title: "Danger", fold: "-" },
        content: [paragraph("two")],
      },
    ],
  });
});

it("puts a line back at the top level when its wrapping is undone after someone wrapped it again", () => {
  const baseline = note({}, { path: [], text: "keep" }, { path: [], text: "temp" });
  const first = person(baseline, 10);
  const second = person(baseline, 20);
  first.change(() => first.text.insert(first.indexOf(0) + 5, "!", {}));
  first.history.stopCapturing();
  first.change(() => {
    first.records.set("q", "blockquote");
    first.line(1).setAttribute("path", ["q"] as unknown as string);
  });
  settle(first, second);
  second.change(() => {
    second.records.set("q2", "blockquote");
    second.line(1).setAttribute("path", ["q2"] as unknown as string);
  });
  settle(first, second);
  first.history.undo();
  expect(settle(first, second)).toEqual({
    type: "doc",
    content: [paragraph("keep!"), paragraph("temp")],
  });
});

it("puts a start number back when its change is undone after someone changed it again", () => {
  const baseline = note({ L: "bulletList", a: "listItem" }, { path: ["L", "a"], text: "item" });
  const first = person(baseline, 10);
  const second = person(baseline, 20);
  first.change(() => first.records.set("L", "orderedList"));
  first.history.stopCapturing();
  first.change(() => first.text.insert(first.text.length, "!", {}));
  first.history.stopCapturing();
  first.write("L.start", 5, 1);
  settle(first, second);
  second.write("L.start", 9, 1);
  settle(first, second);
  first.history.undo();
  expect(settle(first, second)).toMatchObject({
    content: [{ type: "orderedList", attrs: { start: 1 }, content: [item("listItem", "item!")] }],
  });
});
