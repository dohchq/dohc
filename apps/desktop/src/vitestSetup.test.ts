// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// Guards that `vitest.setup.ts` is REGISTERED, not what it does.
//
// The setup file gives jsdom the document.elementFromPoint that
// prosemirror-view's posAtCoords calls. Without it that call throws inside a
// mousedown listener rather than inside a test, so vitest fails the run on an
// unhandled error and reports 0 failed tests. A run that exits 1 while naming
// nothing costs a review round to attribute (#590, #635).
//
// So the protection needs a name of its own. Drop `./vitest.setup.ts` from
// `setupFiles` and these two tests fail, deterministically, in one worker,
// pointing at the config line to restore.
//
// Setup files run per test file, so the method being present here is the same
// registration that puts it in every other file.
describe("apps/desktop vitest setup", () => {
  it("is registered, so jsdom has the document.elementFromPoint ProseMirror calls", () => {
    expect(typeof document.elementFromPoint).toBe("function");
  });

  it("answers a hit test rather than throwing the TypeError that failed whole runs", () => {
    expect(() => document.elementFromPoint(0, 0)).not.toThrow();
  });
});
