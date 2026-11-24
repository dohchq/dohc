// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { editorOn, LINES, note, page, person, stopEveryone } from "./bodySequenceTestSupport.js";

const planner = vi.hoisted(() => ({ throws: false }));
vi.mock("./bodySequenceWriting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bodySequenceWriting.js")>()),
  howToWrite() {
    if (planner.throws) throw new Error("the planner");
    return null;
  },
}));

afterEach(stopEveryone);

it.each(["bare", "hosted"] as const)(
  "writes nothing and shows the note again when no trial of a dispatch settles, on a %s page",
  (shape) => {
    const a = person(note(...LINES), 10, shape);
    const before = a.view.state.doc.toJSON();
    const shown = a.shown.count;
    a.typeAt(1, 2, "x");
    expect(a.sent).toEqual([]);
    expect(a.view.state.doc.toJSON()).toEqual(before);
    expect(a.shown.count).toBe(shown + 1);
    a.expectMirror();
    a.view.dispatch(a.view.state.tr.split(3));
    expect(a.sent).toEqual([]);
    expect(a.view.state.doc.toJSON()).toEqual(before);
    a.expectMirror();
  },
);

it.each(["bare", "hosted"] as const)(
  "says the dispatch cannot be written when no trial settles, and nothing when the trial throws, on a %s page",
  (shape) => {
    const told: string[] = [];
    const a = editorOn(page(note(...LINES), 10, shape), shape, [], [], {
      unwritten: (why) => told.push(why),
    });
    a.typeAt(1, 2, "x");
    expect(told).toEqual(["unwritable"]);
    planner.throws = true;
    try {
      expect(() => a.type("x")).toThrow("the planner");
    } finally {
      planner.throws = false;
    }
    expect(told).toHaveLength(1);
    expect(a.sent).toEqual([]);
  },
);
