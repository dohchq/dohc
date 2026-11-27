// @vitest-environment jsdom
import { Plugin } from "@tiptap/pm/state";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  boundary,
  editorOn,
  LINES,
  note,
  noteOf,
  page,
  schema,
  stopEveryone,
  type HostShape,
  type Person,
} from "./bodySequenceTestSupport.js";

const live = vi.hoisted(() => ({ refuses: null as null | "after" | "second", calls: 0 }));
vi.mock("./bodySequenceWriting.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bodySequenceWriting.js")>();
  return {
    ...real,
    writeTransaction: (...args: Parameters<typeof real.writeTransaction>) => {
      live.calls += 1;
      if (live.refuses === "second" && live.calls === 2) return false;
      return real.writeTransaction(...args) && live.refuses !== "after";
    },
  };
});

afterEach(() => {
  live.refuses = null;
  stopEveryone();
});

function refusedLive(act: () => void, how: "after" | "second") {
  live.refuses = how;
  live.calls = 0;
  try {
    act();
  } finally {
    live.refuses = null;
  }
}

function expectEveryoneToAgree(a: Person, baseline: Uint8Array) {
  a.expectMirror();
  const peer = new Y.Doc();
  Y.applyUpdate(peer, baseline);
  for (const update of a.sent) Y.applyUpdate(peer, update);
  expect(readBodySequence(schema, peer).toJSON()).toEqual(a.view.state.doc.toJSON());
}

const DISPATCHES: [string, (a: Person) => void][] = [
  ["a typed letter", (a) => a.typeAt(1, 2, "x")],
  ["a join of two lines", (a) => a.join(1)],
  ["an Enter", (a) => a.split(1, 3)],
  ["a mark over letters", (a) => (a.select([0, 1], [2, 2]), a.mark("bold"))],
  ["a change of block type", (a) => (a.select([1, 1]), a.retype("heading", { level: 2 }))],
  [
    "a quote around two lines",
    (a) => {
      const range = a.view.state.doc.resolve(1).blockRange(a.view.state.doc.resolve(12))!;
      a.view.dispatch(a.view.state.tr.wrap(range, [{ type: schema.nodes.blockquote! }]));
    },
  ],
];

it.each(
  DISPATCHES.flatMap(([name, act]) =>
    (["bare", "hosted"] as HostShape[]).map((shape) => [name, shape, act] as const),
  ),
)(
  "tells of %s the note refuses after its trial passed, and shows what it wrote, on a %s page",
  (_name, shape, act) => {
    const told: string[] = [];
    const baseline = note(...LINES);
    const a = editorOn(page(baseline, 10, shape), shape, [], [], {
      unwritten: (why) => told.push(why),
    });
    const before = a.view.state.doc.toJSON();
    refusedLive(() => act(a), "after");
    expect(told).toEqual(["unwritable"]);
    expect(a.sent).toHaveLength(1);
    expectEveryoneToAgree(a, baseline);
    expect(a.undo()).toBe(true);
    expect(a.view.state.doc.toJSON()).toEqual(before);
    expectEveryoneToAgree(a, baseline);
  },
);

it.each(["bare", "hosted"] as HostShape[])(
  "keeps the part of a dispatch written before the note refused the rest, as one undo step, on a %s page",
  (shape) => {
    const told: string[] = [];
    const baseline = note(...LINES);
    const echo = new Plugin({
      appendTransaction: (transactions, _old, state) =>
        transactions.some((each) => each.getMeta("echo") === true)
          ? state.tr.insertText("y", state.selection.from)
          : null,
    });
    const a = editorOn(page(baseline, 10, shape), shape, [echo], [], {
      unwritten: (why) => told.push(why),
    });
    const before = a.view.state.doc.toJSON();
    a.select([1, 2]);
    refusedLive(
      () => a.view.dispatch(a.view.state.tr.insertText("x").setMeta("echo", true)),
      "second",
    );
    expect(told).toEqual(["unwritable"]);
    expect(a.lines()[1]).toBe("Twxo two two");
    expect(a.sent).toHaveLength(1);
    expectEveryoneToAgree(a, baseline);
    expect(a.undo()).toBe(true);
    expect(a.view.state.doc.toJSON()).toEqual(before);
  },
);

it("keeps the boundary it gave a line first with what it wrote", () => {
  const told: string[] = [];
  const baseline = noteOf(({ sequence }) => {
    sequence.insert(0, "Bare", {});
    sequence.insertEmbed(sequence.length, boundary(), {});
    sequence.insert(sequence.length, "Two", {});
  });
  const a = editorOn(page(baseline, 10), "bare", [], [], { unwritten: (why) => told.push(why) });
  const boundaries = a.boundaryIds().length;
  refusedLive(() => a.typeAt(0, 2, "x"), "after");
  expect(told).toEqual(["unwritable"]);
  expect(a.lines()).toEqual(["Baxre", "Two"]);
  expect(a.boundaryIds()).toHaveLength(boundaries + 1);
  expectEveryoneToAgree(a, baseline);
});
