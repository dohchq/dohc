// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { lift, wrapIn } from "@tiptap/pm/commands";
import { Fragment, NodeRange, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { liftListItem, sinkListItem, wrapInList } from "@tiptap/pm/schema-list";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import { isBodySequenceChange, type BodySequenceUnwritten } from "./bodySequenceEditor.js";
import { BODY_SEQUENCE_SCHEMA_VERSION } from "./bodySequenceYjs.js";
import { admitBodySequenceNotes, liveEditRefusal } from "./liveDocumentValidation.js";
import { LIVE_UPDATE_MAX_BYTES } from "./liveValidationPolicy.js";
import {
  boundary,
  declared,
  editorOn,
  element,
  elementsOf,
  exchange,
  note,
  noteOf,
  page,
  person,
  reconnect,
  schema,
  stopEveryone,
  type Person,
} from "./bodySequenceTestSupport.js";
import {
  containerRulesBroken,
  expectTheWindowToAgree,
  recordRulesBroken,
  random,
  type Agreement,
} from "./bodySequenceEditorTestSupport.js";

afterEach(stopEveryone);

type Frame = [id: string, type: string, attrs?: Record<string, unknown>];
type Row = [path: string[], text: string, attrs?: Record<string, unknown>];

const noteIn = (frames: Frame[], rows: Row[]) =>
  noteOf(({ sequence, containers }) => {
    for (const [id, type, attrs = {}] of frames)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
        containers.set(key, value);
    for (const [path, text, attrs = {}] of rows) {
      sequence.insertEmbed(sequence.length, boundary({ ...attrs, path }), {});
      sequence.insert(sequence.length, text, {});
    }
  });

const pathsOf = (a: Person) =>
  elementsOf(a.sequence, "boundary").map(
    (token) =>
      (Object.fromEntries(JSON.parse(token.attrs) as [string, unknown][]) as { path: string[] })
        .path,
  );

const toldOf = (baseline: Uint8Array, clientID = 10) => {
  const told: BodySequenceUnwritten[] = [];
  const a = editorOn(page(baseline, clientID), "bare", [], [], {
    unwritten: (why) => told.push(why),
  });
  return { a, told };
};

const quotes = (count: number) =>
  Array.from({ length: count }, () => ({ type: schema.nodes.blockquote! }));

const posOfChild = (doc: ProseMirrorNode, index: number) => {
  let pos = 0;
  for (let at = 0; at < index; at++) pos += doc.child(at).nodeSize;
  return pos;
};

describe("containers the editor writes", () => {
  it("changes the title of one of two callouts that share an id, and leaves the other as it was", () => {
    const baseline = noteIn(
      [["C", "callout", { title: "Same" }]],
      [
        [["C"], "one"],
        [[], "between"],
        [["C"], "two"],
      ],
    );
    const a = person(baseline, 10);
    const b = person(baseline, 20);
    const titles = () => [0, 2].map((at) => a.view.state.doc.child(at).attrs.title as string);
    expect(titles()).toEqual(["Same", "Same"]);
    const lower = posOfChild(a.view.state.doc, 2);
    a.view.dispatch(a.view.state.tr.setNodeAttribute(lower, "title", "Mine"));
    expect(a.sent).toHaveLength(1);
    expect(titles()).toEqual(["Same", "Mine"]);
    a.expectMirror();
    expect(containerRulesBroken(page(baseline, 30).doc, a.doc)).toEqual([]);
    exchange(a, b);
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
    expect(a.undo()).toBe(true);
    expect(titles()).toEqual(["Same", "Same"]);
    a.expectMirror();
  });

  it("changes the title of a callout inside another that starts at the same line, and keeps each callout's id", () => {
    const baseline = noteIn(
      [
        ["O", "callout", { title: "Outer" }],
        ["I", "callout", { title: "Inner" }],
      ],
      [
        [["O", "I"], "one"],
        [["O"], "two"],
      ],
    );
    const a = person(baseline, 10);
    const inner = 1;
    expect(a.view.state.doc.nodeAt(inner)!.attrs.title).toBe("Inner");
    a.view.dispatch(a.view.state.tr.setNodeAttribute(inner, "title", "Mine"));
    expect(a.sent).toHaveLength(1);
    expect(pathsOf(a)).toEqual([["O", "I"], ["O"]]);
    expect(a.view.state.doc.child(0).attrs.title).toBe("Outer");
    expect(a.view.state.doc.nodeAt(inner)!.attrs.title).toBe("Mine");
    a.expectMirror();
  });

  it("writes a quote around lines that hold a list item's added paragraph far from both ends, and gives that paragraph its boundary first", () => {
    const baseline = noteIn(
      [
        ["L", "bulletList"],
        ["I", "listItem"],
      ],
      [
        [[], "a"],
        [[], "b"],
        [["L", "I"], "T", { type: "heading", level: 2 }],
        [[], "d"],
        [[], "e"],
      ],
    );
    const a = person(baseline, 10);
    const b = person(baseline, 20);
    expect(a.view.state.doc.child(2).toString()).toBe(
      'bulletList(listItem(paragraph, heading("T")))',
    );
    const { doc } = a.view.state;
    a.view.dispatch(
      a.view.state.tr.wrap(new NodeRange(doc.resolve(0), doc.resolve(doc.content.size), 0), [
        { type: schema.nodes.blockquote! },
      ]),
    );
    expect(a.view.state.doc.toString()).toBe(
      'doc(blockquote(paragraph("a"), paragraph("b"), bulletList(listItem(paragraph, heading("T"))), paragraph("d"), paragraph("e")))',
    );
    expect(a.sent).toHaveLength(2);
    const [quote] = pathsOf(a)[0]!;
    expect(pathsOf(a)).toEqual([
      [quote],
      [quote],
      [quote, "L", "I"],
      [quote, "L", "I"],
      [quote],
      [quote],
    ]);
    a.expectMirror();
    exchange(a, b);
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
    while (a.undo());
    expect(a.view.state.doc.eq(person(baseline, 30).view.state.doc)).toBe(true);
    a.expectMirror();
  });

  it("refuses a dispatch whose later step nests a line 65 deep, and writes none of its steps", () => {
    const { a, told } = toldOf(note("> quoted", "after"));
    const tr = a.view.state.tr.delete(1, 3);
    tr.wrap(tr.doc.resolve(1).blockRange()!, quotes(65));
    a.view.dispatch(tr);
    expect(told).toEqual(["unwritable"]);
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(["> quoted", "after"]);
    a.expectMirror();
  });

  it("writes a line nested 64 deep", () => {
    const { a, told } = toldOf(note("deep", "after"));
    a.view.dispatch(a.view.state.tr.wrap(a.view.state.doc.resolve(1).blockRange()!, quotes(64)));
    expect(told).toEqual([]);
    expect(pathsOf(a)[0]).toHaveLength(64);
    a.expectMirror();
  });

  it("refuses a change the room would refuse, and writes none of it", () => {
    const ids = Array.from({ length: 60 }, (_, at) => `q${String(at)}`);
    const baseline = noteIn(
      ids.map((id) => [id, "blockquote"] as Frame),
      [[ids, "deep"]],
    );
    const { a, told } = toldOf(baseline);
    const lines = Array.from({ length: 1_700 }, () =>
      schema.nodes.paragraph!.create(null, schema.text("x")),
    );
    const end = a.view.state.doc.content.size - 60;
    a.view.dispatch(a.view.state.tr.insert(end, lines));
    expect(told).toEqual(["unwritable"]);
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(["deep"]);
    a.expectMirror();
  });

  it("writes an ordered list's first number, which someone else reads and undo takes back", () => {
    const baseline = noteIn(
      [
        ["L", "orderedList"],
        ["I", "listItem"],
        ["J", "listItem"],
      ],
      [
        [["L", "I"], "one"],
        [["L", "J"], "two"],
      ],
    );
    const a = person(baseline, 10);
    const b = person(baseline, 20);
    a.view.dispatch(a.view.state.tr.setNodeAttribute(0, "start", 9));
    expect(a.sent).toHaveLength(1);
    expect(a.containers.get("L.start")).toBe(9);
    a.expectMirror();
    exchange(a, b);
    expect(b.view.state.doc.child(0).attrs.start).toBe(9);
    expect(a.undo()).toBe(true);
    expect(a.containers.get("L.start")).toBe(1);
    a.expectMirror();
  });

  it("tries a quote put around a line in the middle of a long note on the blocks around it", () => {
    const baseline = note(...Array.from({ length: 12 }, (_, at) => `line ${String(at)}`));
    const a = person(baseline, 10);
    const at = posOfChild(a.view.state.doc, 6) + 1;
    const tr = a.view.state.tr.wrap(a.view.state.doc.resolve(at).blockRange()!, quotes(1));
    a.view.dispatch(tr);
    expect(a.view.state.doc.child(6).type.name).toBe("blockquote");
    const counted: Agreement = { compared: 0, trials: 0, inTheWindow: 0, onTheWholeNote: 0 };
    expectTheWindowToAgree(counted, { baseline, shift: 0 }, [tr], "a quote in the middle");
    expect(counted).toEqual({ compared: 1, trials: 1, inTheWindow: 1, onTheWholeNote: 0 });
    a.expectMirror();
  });

  it("gives no boundary to the added paragraph of an item whose first stored line sits deeper in it, when a change elsewhere moves neither", () => {
    const baseline = noteIn(
      [
        ["L", "bulletList"],
        ["I", "listItem"],
        ["Q", "blockquote"],
      ],
      [
        [[], "top"],
        [["L", "I", "Q"], "x"],
      ],
    );
    const a = person(baseline, 10);
    expect(a.view.state.doc.child(1).toString()).toBe(
      'bulletList(listItem(paragraph, blockquote(paragraph("x"))))',
    );
    const boundaries = a.boundaryIds().length;
    a.view.dispatch(a.view.state.tr.wrap(a.view.state.doc.resolve(1).blockRange()!, quotes(1)));
    expect(a.sent).toHaveLength(1);
    expect(a.boundaryIds()).toHaveLength(boundaries);
    a.expectMirror();
  });

  it("keeps a callout's id when it is lifted out of the quote it was alone in", () => {
    const baseline = noteIn(
      [
        ["Q", "blockquote"],
        ["C", "callout", { title: "T" }],
      ],
      [[["Q", "C"], "x"]],
    );
    const a = person(baseline, 10);
    const { doc } = a.view.state;
    const callout = doc.child(0).child(0);
    a.view.dispatch(
      a.view.state.tr.lift(new NodeRange(doc.resolve(1), doc.resolve(1 + callout.nodeSize), 1), 0),
    );
    expect(a.view.state.doc.toString()).toBe('doc(callout(paragraph("x")))');
    expect(pathsOf(a)).toEqual([["C"]]);
    expect(a.containers.get("C.title")).toBe("T");
    a.expectMirror();
  });

  it("keeps the inner callout's id when it is lifted out of the outer one and given a new title", () => {
    const baseline = noteIn(
      [
        ["C1", "callout", { title: "One" }],
        ["C2", "callout", { title: "Two" }],
      ],
      [[["C1", "C2"], "x"]],
    );
    const a = person(baseline, 10);
    const { doc } = a.view.state;
    const inner = doc.child(0).child(0);
    const tr = a.view.state.tr.lift(
      new NodeRange(doc.resolve(1), doc.resolve(1 + inner.nodeSize), 1),
      0,
    );
    a.view.dispatch(tr.setNodeMarkup(0, undefined, { ...tr.doc.child(0).attrs, title: "Lifted" }));
    expect(pathsOf(a)).toEqual([["C2"]]);
    expect(a.containers.get("C2.title")).toBe("Lifted");
    expect(a.containers.get("C1.title")).toBe("One");
    a.expectMirror();
  });

  it("gives a new id to a quote put back around a line lifted out of it, when the same write types in the line still in the quote", () => {
    const a = person(
      noteIn(
        [["Q", "blockquote"]],
        [
          [["Q"], "a"],
          [["Q"], "b"],
        ],
      ),
      10,
    );
    let state = a.view.state;
    state = state.apply(state.tr.lift(state.doc.resolve(2).blockRange()!, 0));
    state = state.apply(state.tr.insertText("!", state.doc.child(0).nodeSize + 3));
    state = state.apply(state.tr.wrap(state.doc.resolve(1).blockRange()!, quotes(1)));
    a.view.updateState(state);
    expect(a.lines()).toEqual(["a", "b!"]);
    const [first, second] = pathsOf(a);
    expect(second).toEqual(["Q"]);
    expect(first).toHaveLength(1);
    expect(first![0]).toMatch(/^[0-9a-f]{32}$/);
    a.expectMirror();
  });

  it("gives the containers two people make at once ids of their own, made at random", () => {
    const baseline = note("one", "two");
    const a = person(baseline, 10);
    const b = person(baseline, 20);
    for (const each of [a, b])
      each.view.dispatch(
        each.view.state.tr.wrap(each.view.state.doc.resolve(1).blockRange()!, quotes(1)),
      );
    const [ofA] = pathsOf(a)[0]!;
    const [ofB] = pathsOf(b)[0]!;
    expect(ofA).toMatch(/^[0-9a-f]{32}$/);
    expect(ofB).toMatch(/^[0-9a-f]{32}$/);
    expect(ofA).not.toBe(ofB);
    exchange(a, b);
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
    a.expectMirror();
  });

  it("writes a quote around two quotes that share an id, and both keep it", () => {
    const baseline = noteIn(
      [["Q", "blockquote"]],
      [
        [["Q"], "a"],
        [[], "b"],
        [["Q"], "c"],
      ],
    );
    const { a, told } = toldOf(baseline);
    const b = person(baseline, 20);
    const was = page(Y.encodeStateAsUpdate(a.doc), 30);
    const { doc } = a.view.state;
    a.view.dispatch(
      a.view.state.tr.wrap(
        doc.resolve(1).blockRange(doc.resolve(doc.content.size - 1))!,
        quotes(1),
      ),
    );
    expect(told).toEqual([]);
    expect(a.view.state.doc.toString()).toBe(
      'doc(blockquote(blockquote(paragraph("a")), paragraph("b"), blockquote(paragraph("c"))))',
    );
    const [[outer]] = pathsOf(a) as [string[]];
    expect(outer).toMatch(/^[0-9a-f]{32}$/);
    expect(pathsOf(a)).toEqual([[outer, "Q"], [outer], [outer, "Q"]]);
    expect(containerRulesBroken(was.doc, a.doc)).toEqual([]);
    exchange(a, b);
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
    a.expectMirror();
    a.undo();
    expect(pathsOf(a)).toEqual([["Q"], [], ["Q"]]);
  });

  it("refuses a callout title with half a surrogate pair, and writes nothing", () => {
    const { a, told } = toldOf(noteIn([["C", "callout"]], [[["C"], "x"]]));
    a.view.dispatch(a.view.state.tr.setNodeAttribute(0, "title", "\ud800"));
    expect(told).toEqual(["unwritable"]);
    expect(a.sent).toEqual([]);
    expect(a.containers.get("C.title")).toBe("");
    a.expectMirror();
  });
});

describe("a dispatch the editor writes whole or not at all", () => {
  const refusedWhole = (a: Person, told: BodySequenceUnwritten[], lines: string[]) => {
    expect(told).toEqual(["unwritable"]);
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(lines);
    a.expectMirror();
  };

  it.each(["", "!"])(
    "deletes the line between two quotes that share an id, with a list item's added paragraph further in the lower one, and types %j after, all in one write",
    (typed) => {
      const baseline = noteIn(
        [
          ["Q", "blockquote"],
          ["L", "bulletList"],
          ["I", "listItem"],
        ],
        [
          [["Q"], "a"],
          [[], "b"],
          [["Q"], "c"],
          [["Q"], "d"],
          [["Q"], "e"],
          [["Q", "L", "I"], "T", { type: "heading", level: 2 }],
        ],
      );
      const { a, told } = toldOf(baseline);
      const b = person(baseline, 20);
      const was = page(Y.encodeStateAsUpdate(a.doc), 30);
      const { doc } = a.view.state;
      const from = doc.child(0).nodeSize;
      const tr = a.view.state.tr.delete(from, from + doc.child(1).nodeSize);
      if (typed) tr.insertText(typed, 2);
      a.view.dispatch(tr);
      expect(told).toEqual([]);
      expect(a.sent).toHaveLength(2);
      expect(a.view.state.doc.childCount).toBe(2);
      expect(a.lines()).toEqual([`${typed}a`, "c", "d", "e", "", "T"]);
      const lower = pathsOf(a)[1]![0]!;
      expect(lower).toMatch(/^[0-9a-f]{32}$/);
      expect(pathsOf(a)).toEqual([
        ["Q"],
        [lower],
        [lower],
        [lower],
        [lower, "L", "I"],
        [lower, "L", "I"],
      ]);
      expect(containerRulesBroken(was.doc, a.doc)).toEqual([]);
      a.expectMirror();
      exchange(a, b);
      expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
      expect(a.undo()).toBe(true);
      expect(a.lines()).toEqual(["a", "b", "c", "d", "e", "", "T"]);
      a.expectMirror();
    },
  );

  it("refuses a delete that joins two stacks of 60 quotes that share their ids around 1,700 lines", () => {
    const ids = Array.from({ length: 60 }, (_, at) => `q${String(at)}`);
    const { a, told } = toldOf(
      noteIn(
        ids.map((id) => [id, "blockquote"] as Frame),
        [[ids, "a"], [[], "b"], ...Array.from({ length: 1_700 }, (): Row => [ids, "x"])],
      ),
    );
    const lines = a.lines();
    const { doc } = a.view.state;
    const from = doc.child(0).nodeSize;
    a.view.dispatch(a.view.state.tr.delete(from, from + doc.child(1).nodeSize));
    refusedWhole(a, told, lines);
  });

  it("refuses a formula longer than the room takes in one change", () => {
    const { a, told } = toldOf(noteIn([], [[[], "", { type: "mathBlock", tex: "x" }]]));
    a.view.dispatch(a.view.state.tr.setNodeAttribute(0, "tex", "x".repeat(2_200_000)));
    refusedWhole(a, told, [""]);
  });

  it("writes a paste whose change is two bytes under the room's limit", () => {
    const probe = toldOf(note("a"));
    probe.a.view.dispatch(probe.a.view.state.tr.insertText("x".repeat(1_000), 2));
    const around = probe.a.sent[0]!.byteLength - 1_000 + 1;
    const { a, told } = toldOf(note("a"));
    const letters = LIVE_UPDATE_MAX_BYTES - 2 - around;
    a.view.dispatch(a.view.state.tr.insertText("x".repeat(letters), 2));
    expect(told).toEqual([]);
    expect(a.sent.map((update) => update.byteLength)).toEqual([LIVE_UPDATE_MAX_BYTES - 2]);
    expect(a.lines()).toEqual([`a${"x".repeat(letters)}`]);
  });

  it("refuses a paste longer than the room takes in one change", () => {
    const { a, told } = toldOf(note("a"));
    a.view.dispatch(a.view.state.tr.insertText("x".repeat(2_200_000), 2));
    refusedWhole(a, told, ["a"]);
  });

  it(
    "refuses taking the rules from 1,000 lines 64 deep when the boundaries their text needs first come to more than the room takes",
    { timeout: 60_000 },
    () => {
      const ids = Array.from({ length: 64 }, (_, at) => `${String(at)}`.padEnd(32, "q"));
      const { a, told } = toldOf(
        noteIn(
          ids.map((id) => [id, "blockquote"] as Frame),
          Array.from({ length: 1_000 }, (): Row => [ids, "x", { type: "horizontalRule" }]),
        ),
      );
      const lines = a.lines();
      let inner = a.view.state.doc.child(0);
      for (let depth = 1; depth < ids.length; depth++) inner = inner.child(0);
      const rules: number[] = [];
      inner.forEach((node, offset) => {
        if (node.type.name === "horizontalRule") rules.push(ids.length + offset);
      });
      const tr = a.view.state.tr;
      for (const at of rules.reverse()) tr.delete(at, at + 1);
      a.view.dispatch(tr);
      refusedWhole(a, told, lines);
    },
  );

  it("refuses deleting a line whose letters were written apart, which takes the room more delete ranges than it takes", () => {
    const LETTERS = 50_010;
    const { a, told } = toldOf(
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary(), {});
        sequence.insert(1, "xy".repeat(LETTERS), {});
        sequence.insertEmbed(sequence.length, boundary(), {});
        sequence.insert(sequence.length, "after", {});
        sequence.applyDelta([
          { retain: 2 },
          ...Array.from({ length: LETTERS }, () => [{ delete: 1 }, { retain: 1 }]).flat(),
        ]);
      }),
    );
    const lines = a.lines();
    const { doc } = a.view.state;
    a.view.dispatch(a.view.state.tr.delete(0, doc.child(0).nodeSize));
    refusedWhole(a, told, lines);
  });

  const LINES = 25;
  const PAIRS = 1_001;
  const holes = () => [
    { retain: 1 },
    ...Array.from({ length: PAIRS }, () => [
      { retain: 1 },
      { delete: 1 },
      { retain: 1 },
      { delete: 1 },
    ]).flat(),
  ];
  const refusedDeletingAllButTheLast = (baseline: Uint8Array) => {
    const { a, told } = toldOf(baseline);
    const lines = a.lines();
    const { doc } = a.view.state;
    a.view.dispatch(a.view.state.tr.delete(0, doc.content.size - doc.lastChild!.nodeSize));
    refusedWhole(a, told, lines);
  };

  it("refuses deleting lines whose letters were written apart between as many breaks, so the note holds no more items there than a copy of them", () => {
    refusedDeletingAllButTheLast(
      noteOf(({ sequence }) => {
        const line = () => [
          { insert: boundary() },
          ...Array.from({ length: PAIRS }, () => [
            { insert: element("hardBreak", {}) },
            { insert: "yxy" },
          ]).flat(),
        ];
        sequence.applyDelta([
          ...Array.from({ length: LINES }, line).flat(),
          { insert: boundary() },
          { insert: "after" },
        ]);
        sequence.applyDelta(Array.from({ length: LINES }, holes).flat());
      }),
    );
  });

  it("refuses deleting lines whose letters were written apart with each a made bold, so the note holds no more items there than a copy of them", () => {
    refusedDeletingAllButTheLast(
      noteOf(({ sequence }) => {
        const line = () => [{ insert: boundary() }, { insert: "a?b?".repeat(PAIRS) }];
        sequence.applyDelta([
          ...Array.from({ length: LINES }, line).flat(),
          { insert: boundary() },
          { insert: "after" },
        ]);
        sequence.applyDelta(Array.from({ length: LINES }, holes).flat());
        const bold = () => [
          { retain: 1 },
          ...Array.from({ length: PAIRS }, () => [
            { retain: 1, attributes: { bold: {} } },
            { retain: 1 },
          ]).flat(),
        ];
        sequence.applyDelta(Array.from({ length: LINES }, bold).flat());
      }),
    );
  });

  const link = (size: number) =>
    schema.marks.link!.create({ href: `https://example.com/${"a".repeat(size)}` });

  it("refuses 999 rules put at the end of a line 64 quotes deep, each of whose boundaries holds the path", () => {
    const ids = Array.from({ length: 64 }, (_, at) => `${String(at)}`.padEnd(32, "q"));
    const { a, told } = toldOf(
      noteIn(
        ids.map((id) => [id, "blockquote"] as Frame),
        [[ids, "x"]],
      ),
    );
    const rules = Array.from({ length: 999 }, () => schema.nodes.horizontalRule!.create());
    a.view.dispatch(a.view.state.tr.insert(ids.length + 3, rules));
    refusedWhole(a, told, ["x"]);
  });

  it("refuses 499 breaks and letters put in a link, which the sequence takes the link off and puts back for each", () => {
    const { a, told } = toldOf(note("ab"));
    a.view.dispatch(a.view.state.tr.addMark(1, 3, link(10_000)));
    expect(told).toEqual([]);
    a.sent.splice(0);
    const put = Array.from({ length: 499 }, () => [
      schema.nodes.hardBreak!.create(),
      schema.text("a"),
    ]).flat();
    a.view.dispatch(a.view.state.tr.insert(2, put));
    refusedWhole(a, told, ["ab"]);
  });

  it("refuses a letter with a link of its own put inside a long link, which the sequence puts back after it", () => {
    const { a, told } = toldOf(note("ab"));
    a.view.dispatch(a.view.state.tr.addMark(1, 3, link(2_050_000)));
    expect(told).toEqual([]);
    expect(a.sent[0]!.byteLength).toBeLessThan(LIVE_UPDATE_MAX_BYTES);
    a.sent.splice(0);
    a.view.dispatch(a.view.state.tr.replaceWith(2, 2, schema.text("X", [link(85_000)])));
    refusedWhole(a, told, ["ab"]);
  });

  it("refuses breaks and letters put in an added paragraph that shares its line with three more, when the sequence takes a long link off and puts it back for each", () => {
    const ids = ["L1", "I1", "L2", "I2", "L3", "I3"];
    const { a, told } = toldOf(
      noteIn(
        ids.map((id, at) => [id, at % 2 === 0 ? "bulletList" : "listItem"] as Frame),
        [
          [[], "ab"],
          [ids, "H", { type: "heading", level: 1 }],
        ],
      ),
    );
    a.view.dispatch(a.view.state.tr.addMark(1, a.view.state.doc.content.size, link(100_000)));
    expect(told).toEqual([]);
    a.sent.splice(0);
    const lines = a.lines();
    const put = Array.from({ length: 30 }, () => [
      schema.nodes.hardBreak!.create(),
      schema.text("a"),
    ]).flat();
    a.view.dispatch(a.view.state.tr.insert(11, put));
    refusedWhole(a, told, lines);
  });

  it("refuses splitting five code blocks at their start, each of whose new boundaries takes the block's long language", () => {
    const { a, told } = toldOf(
      noteIn(
        [],
        Array.from({ length: 5 }, (): Row => [
          [],
          "x",
          { type: "codeBlock", language: "a".repeat(500_000) },
        ]),
      ),
    );
    const lines = a.lines();
    const tr = a.view.state.tr;
    const split = new Slice(
      Fragment.from([schema.nodes.codeBlock!.create(), schema.nodes.paragraph!.create()]),
      1,
      1,
    );
    for (let at = 4; at >= 0; at--) {
      const pos = posOfChild(tr.doc, at) + 1;
      tr.step(new ReplaceStep(pos, pos, split));
    }
    a.view.dispatch(tr);
    refusedWhole(a, told, lines);
  });

  it(
    "refuses deleting a line of images whose attributes another person wrote apart, which takes the room more delete ranges than it takes",
    { timeout: 60_000 },
    () => {
      const one = declared(1);
      one.sequence.applyDelta([
        { insert: boundary() },
        ...Array.from({ length: 17_000 }, () => ({ insert: element("image", {}) })),
        { insert: boundary() },
        { insert: "after" },
        { insert: boundary() },
        { insert: "tail" },
      ]);
      const two = declared(2);
      Y.applyUpdate(two.doc, Y.encodeStateAsUpdate(one.doc));
      one.doc.destroy();
      const images = two.sequence
        .toDelta()
        .map(({ insert }: { insert: unknown }) => insert)
        .filter(
          (insert: unknown): insert is Y.XmlElement =>
            insert instanceof Y.XmlElement && insert.nodeName === "image",
        );
      two.doc.transact(() => {
        for (const image of images)
          for (const [key, value] of [
            ["src", "/a.png"],
            ["alt", "A"],
            ["title", "T"],
          ] as const) {
            image.setAttribute(key, value);
            two.sequence.insert(two.sequence.length, "z");
          }
      });
      const baseline = Y.encodeStateAsUpdate(two.doc);
      two.doc.destroy();
      const { a, told } = toldOf(baseline);
      const lines = a.lines();
      a.view.dispatch(a.view.state.tr.delete(0, a.view.state.doc.child(0).nodeSize));
      refusedWhole(a, told, lines);
    },
  );

  it(
    "refuses changing callouts nested 62 deep in a callout, whose records another person wrote apart, which takes the room more delete ranges than it takes",
    { timeout: 120_000 },
    () => {
      const rows = Array.from({ length: 183 }, (_, row) =>
        Array.from({ length: 62 }, (_, depth) => `c${String(row)}_${String(depth)}`),
      );
      const ids = rows.flat();
      const one = declared(1);
      const made: [string, Record<string, unknown>][] = [
        ["C", {}],
        ...ids.map((id): [string, Record<string, unknown>] => [id, { title: "Old" }]),
      ];
      for (const [id, attrs] of made)
        for (const [key, value] of recordsOfContainer(schema, { id, type: "callout", attrs }))
          one.containers.set(key, value);
      one.sequence.applyDelta([
        ...rows.flatMap((path) => [
          { insert: boundary({ path: ["C", ...path] }) },
          { insert: "x" },
        ]),
        { insert: boundary() },
        { insert: "after" },
        { insert: boundary() },
        { insert: "tail" },
      ]);
      const two = declared(2);
      Y.applyUpdate(two.doc, Y.encodeStateAsUpdate(one.doc));
      one.doc.destroy();
      const changed = { calloutType: "tip", title: "Theirs", fold: "+" };
      two.doc.transact(() => {
        for (const id of ids)
          for (const [key, value] of recordsOfContainer(schema, {
            id,
            type: "callout",
            attrs: changed,
          }))
            if (key !== id) {
              two.containers.set(key, value);
              two.sequence.insert(two.sequence.length, "z");
            }
      });
      const baseline = Y.encodeStateAsUpdate(two.doc);
      two.doc.destroy();
      const { a, told } = toldOf(baseline);
      const lines = a.lines();
      const tr = a.view.state.tr;
      a.view.state.doc.descendants((node, pos) => {
        if (pos > 0 && node.type.name === "callout")
          tr.setNodeMarkup(pos, undefined, { calloutType: "warning", title: "Mine", fold: "-" });
      });
      a.view.dispatch(tr);
      refusedWhole(a, told, lines);
    },
  );
});

const inFormat2 = (note: Uint8Array) => {
  const doc = new Y.Doc();
  doc.clientID = 1;
  Y.applyUpdate(doc, note);
  doc.getMap("meta").set("schemaVersion", BODY_SEQUENCE_SCHEMA_VERSION);
  const marked = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return marked;
};

const STARTING = () =>
  inFormat2(
    noteIn(
      [
        ["L", "bulletList"],
        ["I", "listItem"],
        ["J", "listItem"],
        ["H", "listItem"],
        ["Q", "blockquote"],
        ["C", "callout", { title: "Note" }],
        ["T", "taskList"],
        ["K", "taskItem"],
        ["O", "orderedList"],
        ["P", "listItem"],
      ],
      [
        [[], "Top"],
        [["L", "I"], "first"],
        [["L", "J"], "second"],
        [["L", "H"], "headed", { type: "heading", level: 2 }],
        [["Q"], "quoted"],
        [["Q", "C"], "in a callout"],
        [[], "ruled", { type: "horizontalRule" }],
        [[], "middle"],
        [["T", "K"], "a to-do"],
        [["O", "P"], "numbered"],
        [[], "Bottom"],
      ],
    ),
  );

type Act = (a: Person, next: () => number) => boolean;

const run =
  (command: Command): Act =>
  (a) =>
    command(a.view.state, a.view.dispatch);
const relist: Act = (a, next) => {
  const { state } = a.view;
  const lifted: Transaction[] = [];
  for (const item of [schema.nodes.listItem!, schema.nodes.taskItem!])
    liftListItem(item)(state, (tr) => lifted.push(tr));
  const target = [schema.nodes.bulletList!, schema.nodes.orderedList!, schema.nodes.taskList!][
    Math.floor(next() * 3)
  ]!;
  const wrapped: Transaction[] = [];
  if (lifted[0])
    wrapInList(target)(
      EditorState.create({ doc: lifted[0].doc, selection: lifted[0].selection }),
      (tr) => wrapped.push(tr),
    );
  if (!wrapped[0]) return false;
  const combined = state.tr;
  for (const step of [...lifted[0]!.steps, ...wrapped[0].steps]) combined.step(step);
  a.view.dispatch(combined);
  return true;
};

const KIND_OF: Record<string, [string, Record<string, unknown> | null]> = {
  blockquote: ["callout", { title: "Made" }],
  callout: ["blockquote", null],
  bulletList: ["orderedList", null],
  orderedList: ["bulletList", null],
};

const ACTS: [string, Act][] = [
  ["a letter", (a) => (a.type("x"), true)],
  ["Enter", (a) => a.press("Enter")],
  ["Backspace", (a) => a.press("Backspace")],
  ["a quote", run(wrapIn(schema.nodes.blockquote!))],
  ["a callout", run(wrapIn(schema.nodes.callout!))],
  ["a bullet list", run(wrapInList(schema.nodes.bulletList!))],
  ["an ordered list", run(wrapInList(schema.nodes.orderedList!))],
  ["a to-do list", run(wrapInList(schema.nodes.taskList!))],
  ["a lift", run(lift)],
  [
    "an item lifted",
    (a) =>
      run(liftListItem(schema.nodes.listItem!))(a, () => 0) ||
      run(liftListItem(schema.nodes.taskItem!))(a, () => 0),
  ],
  [
    "an item sunk",
    (a) =>
      run(sinkListItem(schema.nodes.listItem!))(a, () => 0) ||
      run(sinkListItem(schema.nodes.taskItem!))(a, () => 0),
  ],
  [
    "a setting",
    (a, next) => {
      const { $from } = a.view.state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const { type, attrs } = $from.node(depth);
        const pos = $from.before(depth);
        const set = (name: string, value: unknown) => (
          a.view.dispatch(a.view.state.tr.setNodeAttribute(pos, name, value)),
          true
        );
        if (type.name === "callout") return set("title", `t${String(Math.floor(next() * 9))}`);
        if (type.name === "orderedList") return set("start", 1 + Math.floor(next() * 9));
        if (type.name === "taskItem") return set("checked", !(attrs.checked as boolean));
      }
      return false;
    },
  ],
  [
    "another kind",
    (a) => {
      const { $from } = a.view.state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const kind = KIND_OF[$from.node(depth).type.name];
        if (!kind) continue;
        const tr = a.view.state.tr.setNodeMarkup(
          $from.before(depth),
          schema.nodes[kind[0]],
          kind[1],
        );
        a.view.dispatch(tr);
        return true;
      }
      return false;
    },
  ],
  ["a list made another as the share page does", relist],
  ["undo", (a) => a.undo()],
  ["redo", (a) => a.redo()],
];

function selectAtRandom(a: Person, next: () => number): void {
  const places: number[] = [];
  a.view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) for (let at = 0; at <= node.content.size; at++) places.push(pos + 1 + at);
    return !node.isTextblock;
  });
  const one = places[Math.floor(next() * places.length)]!;
  const other = next() < 0.3 ? places[Math.floor(next() * places.length)]! : one;
  const { doc } = a.view.state;
  a.view.dispatch(
    a.view.state.tr.setSelection(
      TextSelection.create(doc, Math.min(one, other), Math.max(one, other)),
    ),
  );
}

type Tally = {
  runs: number;
  acts: number;
  wrote: number;
  replayedOntoAShare: number;
  refused: Record<string, number>;
};

function deliverMerged(
  people: Person[],
  next: () => number,
  toRoom: (updates: Uint8Array[]) => void,
): void {
  for (let round = 0; round < 6; round++) {
    const senders = people.filter((each) => each.sent.length > 0);
    if (senders.length === 0) return;
    const order = senders.toSorted(() => next() - 0.5);
    for (const from of order) {
      toRoom(from.sent);
      const merged = Y.mergeUpdates(from.sent.splice(0));
      for (const to of people) if (to !== from) to.receive(merged);
    }
  }
  throw new Error("the editors kept rewriting the note");
}

function playAtRandom(
  size: number,
  arrive: "merged" | "after a reconnect",
  seed: number,
  tally: Tally,
): void {
  const next = random(seed);
  const baseline = STARTING();
  const room = new Y.Doc({ gc: false });
  Y.applyUpdate(room, baseline);
  const checked = new WeakSet<Uint8Array>();
  const toRoom = (updates: Uint8Array[]) => {
    for (const update of updates.filter((each) => !checked.has(each))) {
      checked.add(update);
      expect(update.byteLength, `seed ${String(seed)}`).toBeLessThanOrEqual(LIVE_UPDATE_MAX_BYTES);
      expect(liveEditRefusal(room, update), `seed ${String(seed)}`).toBeUndefined();
    }
  };
  let refusals = 0;
  let dispatched: ProseMirrorNode | null = null;
  const watch = new Plugin({
    state: {
      init: () => null,
      apply(tr) {
        if (tr.docChanged && !isBodySequenceChange(tr)) dispatched = tr.doc;
        return null;
      },
    },
  });
  const people = Array.from({ length: size }, (_, at) =>
    editorOn(page(baseline, 10 + at), "bare", [watch], [], {
      unwritten: (why) => {
        refusals += 1;
        tally.refused[why] = (tally.refused[why] ?? 0) + 1;
      },
    }),
  );
  const settle = () => {
    for (const each of people) toRoom(each.sent);
    if (arrive === "merged") deliverMerged(people, next, toRoom);
    else reconnect(...people);
    for (const each of people) {
      each.expectMirror();
      expect(each.view.state.doc.eq(people[0]!.view.state.doc), `seed ${String(seed)}`).toBe(true);
    }
  };
  tally.runs += 1;
  for (let round = 0; round < 8; round++) {
    const held = page(Y.encodeStateAsUpdate(people[0]!.doc), 99);
    for (const [who, each] of people.entries())
      for (let act = Math.floor(next() * 3); act >= 0; act--) {
        selectAtRandom(each, next);
        const [name, play] = ACTS[Math.floor(next() * ACTS.length)]!;
        const sent = each.sent.length;
        const was = page(Y.encodeStateAsUpdate(each.doc), 98);
        const refused = refusals;
        dispatched = null;
        play(each, next);
        tally.acts += 1;
        if (each.sent.length > sent) tally.wrote += 1;
        const label = `seed ${String(seed)}, round ${String(round)}, person ${String(who)}, ${name}`;
        const replays = name === "undo" || name === "redo";
        toRoom(each.sent);
        if (refusals > refused) expect(each.sent.length, label).toBe(sent);
        else if (dispatched && !replays)
          expect(each.view.state.doc.eq(dispatched), label).toBe(true);
        const broken = containerRulesBroken(was.doc, each.doc);
        if (replays && broken.length > 0) tally.replayedOntoAShare += 1;
        expect(replays ? recordRulesBroken(was.doc, each.doc) : broken, label).toEqual([]);
      }
    settle();
    expect(
      recordRulesBroken(held.doc, people[0]!.doc),
      `seed ${String(seed)}, round ${String(round)}`,
    ).toEqual([]);
  }
  for (const each of people) while (each.undo());
  settle();
  expect(recordRulesBroken(page(baseline, 97).doc, people[0]!.doc), `seed ${String(seed)}`).toEqual(
    [],
  );
}

describe.each([3, 4])(
  "%i people who make container changes at once, with undo and redo",
  (size) => {
    beforeAll(() => admitBodySequenceNotes(true));
    afterAll(() => admitBodySequenceNotes(false));
    it.each(["merged", "after a reconnect"] as const)(
      "read the same note and keep every record, and each write breaks no container rule, with changes delivered %s",
      (arrive) => {
        const tally: Tally = { runs: 0, acts: 0, wrote: 0, replayedOntoAShare: 0, refused: {} };
        for (let seed = 1; seed <= 200; seed++)
          try {
            playAtRandom(size, arrive, seed, tally);
          } finally {
            stopEveryone();
          }
        console.log(`${String(size)} people, ${arrive}: ${JSON.stringify(tally)}`);
        expect(tally.runs).toBe(200);
      },
    );
  },
);
