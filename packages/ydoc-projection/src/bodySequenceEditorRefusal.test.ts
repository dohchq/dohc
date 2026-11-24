// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { LINES, note, person, stopEveryone } from "./bodySequenceTestSupport.js";

vi.mock("./bodySequenceWriting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bodySequenceWriting.js")>()),
  howToWrite: () => null,
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
