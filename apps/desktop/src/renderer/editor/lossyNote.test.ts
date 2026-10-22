// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { checkLossyNote, knownLossyNoteVerdict } from "./lossyNote";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("gives up on a check past its deadline, and remembers no verdict", async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  vi.stubGlobal("Worker", class {
    onmessage = null;
    onerror = null;
    postMessage() {}
    terminate = terminate;
  });
  const check = checkLossyNote("e".repeat(64), "# Note\n");
  const refused = expect(check).rejects.toThrow("The note check took too long.");
  await vi.advanceTimersByTimeAsync(30_000);
  await refused;
  expect(terminate).toHaveBeenCalled();
  expect(knownLossyNoteVerdict("e".repeat(64))).toBeUndefined();
});

it("remembers an answered verdict by content hash", async () => {
  await expect(checkLossyNote("f".repeat(64), "<details>\n\nHidden.\n</details>\n")).resolves.toBe(true);
  expect(knownLossyNoteVerdict("f".repeat(64))).toBe(true);
});
