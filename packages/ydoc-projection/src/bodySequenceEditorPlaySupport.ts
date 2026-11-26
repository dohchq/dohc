import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { lift, wrapIn } from "@tiptap/pm/commands";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { liftListItem, sinkListItem, wrapInList } from "@tiptap/pm/schema-list";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import { isBodySequenceChange } from "./bodySequenceEditor.js";
import { admitBodySequenceNotes, liveEditRefusal } from "./liveDocumentValidation.js";
import { LIVE_UPDATE_MAX_BYTES } from "./liveValidationPolicy.js";
import {
  boundary,
  editorOn,
  noteOf,
  page,
  reconnect,
  schema,
  stopEveryone,
  type Person,
} from "./bodySequenceTestSupport.js";
import {
  containerRulesBroken,
  FULL,
  random,
  recordRulesBroken,
} from "./bodySequenceEditorTestSupport.js";
import { BODY_SEQUENCE_SCHEMA_VERSION } from "./bodySequenceStore.js";

export type Frame = [id: string, type: string, attrs?: Record<string, unknown>];
export type Row = [path: string[] | null, text: string, attrs?: Record<string, unknown>];

/**
 * A note with a record for every attribute of each container in `frames`, and one line per row:
 * with no boundary of its own when its path is null.
 */
export const noteIn = (frames: readonly Frame[], rows: readonly Row[]) =>
  noteOf(({ sequence, containers }) => {
    for (const [id, type, attrs = {}] of frames)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
        containers.set(key, value);
    for (const [path, text, attrs = {}] of rows) {
      if (path) sequence.insertEmbed(sequence.length, boundary({ ...attrs, path }), {});
      sequence.insert(sequence.length, text, {});
    }
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

export const STARTING_FRAMES: Frame[] = [
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
];
export const STARTING_ROWS: Row[] = [
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
];

export type Act = (a: Person, next: () => number) => boolean;

export const run =
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

export const CONTAINER_ACTS: [string, Act][] = [
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

type Play = { baseline: Uint8Array; acts: readonly [string, Act][] };

function playAtRandom(
  { baseline, acts }: Play,
  size: number,
  arrive: "merged" | "after a reconnect",
  seed: number,
  tally: Tally,
): void {
  const next = random(seed);
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
        const [name, play] = acts[Math.floor(next() * acts.length)]!;
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

const SEEDS = FULL ? 200 : 50;

/**
 * Registers random runs of 3 and of 4 people who each play `acts` at random places of the note
 * that `frames` and `rows` make, with changes delivered merged and after a reconnect, ending with
 * every undo: 50 seeds each, or 200 with `BODY_SEQUENCE_EDITOR_FULL=1`.
 */
export function playTogether(
  what: string,
  frames: readonly Frame[],
  rows: readonly Row[],
  acts: readonly [string, Act][],
): void {
  describe.each([3, 4])(`%i people who make ${what} at once, with undo and redo`, (size) => {
    beforeAll(() => admitBodySequenceNotes(true));
    afterAll(() => admitBodySequenceNotes(false));
    it.each(["merged", "after a reconnect"] as const)(
      "read the same note and keep every record, and each write breaks no container rule, with changes delivered %s",
      (arrive) => {
        const play = { baseline: inFormat2(noteIn(frames, rows)), acts };
        const tally: Tally = { runs: 0, acts: 0, wrote: 0, replayedOntoAShare: 0, refused: {} };
        for (let seed = 1; seed <= SEEDS; seed++)
          try {
            playAtRandom(play, size, arrive, seed, tally);
          } finally {
            stopEveryone();
          }
        console.log(`${what}, ${String(size)} people, ${arrive}: ${JSON.stringify(tally)}`);
        expect(tally.runs).toBe(SEEDS);
      },
      FULL ? 300_000 : undefined,
    );
  });
}
