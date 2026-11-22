import { describe, expect, it } from "vitest";
import { livePauseMessage } from "./livePauseMessage";

describe("livePauseMessage", () => {
  const pause = { path: "notes/plan.md", names: ["Ana", "Ben"], leftOut: false };
  it.each([
    [
      { ...pause, cause: "refused" as const },
      "The server could not save the latest edits, so live editing is paused until you resume. Edits since the last save are in a copy next to the note. Edits from Ana and Ben were in that save.",
    ],
    [
      { ...pause, cause: "refused" as const, names: [] },
      "The server could not save the latest edits, so live editing is paused until you resume. Edits since the last save are in a copy next to the note.",
    ],
    [
      { ...pause, cause: "failing" as const },
      "The server could not save edits for 10 minutes, so live editing is paused until you resume. Edits since the last save are in a copy next to the note.",
    ],
    [
      { ...pause, cause: "ended" as const, leftOut: true },
      "Live editing stopped because notes/plan.md was moved, deleted, or replaced. Edits since the last save are in a copy. Some edits could not be kept.",
    ],
  ])("says what the owner approved for %o", (row, words) => {
    expect(livePauseMessage(row)).toBe(words);
  });
});
