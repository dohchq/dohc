// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { lift, wrapIn } from "@tiptap/pm/commands";
import { NodeRange, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { liftListItem, sinkListItem, wrapInList } from "@tiptap/pm/schema-list";
import { TextSelection, type Command } from "@tiptap/pm/state";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import type { BodySequenceUnwritten } from "./bodySequenceEditor.js";
import {
  boundary,
  editorOn,
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

const STARTING = () =>
  noteIn(
    [
      ["L", "bulletList"],
      ["I", "listItem"],
      ["J", "listItem"],
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
      [["Q"], "quoted"],
      [["Q", "C"], "in a callout"],
      [[], "middle"],
      [["T", "K"], "a to-do"],
      [["O", "P"], "numbered"],
      [[], "Bottom"],
    ],
  );

type Act = (a: Person, next: () => number) => boolean;

const run =
  (command: Command): Act =>
  (a) =>
    command(a.view.state, a.view.dispatch);
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

function deliverMerged(people: Person[], next: () => number): void {
  for (let round = 0; round < 6; round++) {
    const senders = people.filter((each) => each.sent.length > 0);
    if (senders.length === 0) return;
    const order = senders.toSorted(() => next() - 0.5);
    for (const from of order) {
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
  const people = Array.from({ length: size }, (_, at) =>
    editorOn(page(baseline, 10 + at), "bare", [], [], {
      unwritten: (why) => (tally.refused[why] = (tally.refused[why] ?? 0) + 1),
    }),
  );
  const settle = () => {
    if (arrive === "merged") deliverMerged(people, next);
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
        play(each, next);
        tally.acts += 1;
        if (each.sent.length > sent) tally.wrote += 1;
        const label = `seed ${String(seed)}, round ${String(round)}, person ${String(who)}, ${name}`;
        const replays = name === "undo" || name === "redo";
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
}

describe.each([3, 4])(
  "%i people who make container changes at once, with undo and redo",
  (size) => {
    it.each(["merged", "after a reconnect"] as const)(
      "read the same note and keep every record, and each write breaks no container rule, with changes delivered %s",
      (arrive) => {
        const tally: Tally = { runs: 0, acts: 0, wrote: 0, replayedOntoAShare: 0, refused: {} };
        for (let seed = 1; seed <= 200; seed++) playAtRandom(size, arrive, seed, tally);
        console.log(`${String(size)} people, ${arrive}: ${JSON.stringify(tally)}`);
        expect(tally.runs).toBe(200);
      },
    );
  },
);
