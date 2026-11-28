import { describe, expect, it } from "vitest";
import { leftNoteCount, leftNoteGroups } from "./noteFormat";

const ENGINE_SKIP_REASONS = {
  "open-here": "Open on this computer",
  "open-elsewhere": "Open elsewhere",
  held: "Held",
  "open-conflict": "Waiting on a review",
  "unsent-edit": "Unsent edits",
  "ydoc-unsettled": "Not saved to disk yet",
  "local-new-notes-format-one": "Converts in a later update, in workspaces that don't sync",
  "ydoc-lineage-unclaimed": "History incomplete",
  "ydoc-incomplete-lineage": "History incomplete",
  "ydoc-deferred-updates-pending": "History incomplete",
  "ydoc-artifact-pending": "History incomplete",
};

const empty = { converted: 0, unchanged: 0, skipped: [], doesNotFit: [], failed: [], sent: true };

describe("notes a conversion left", () => {
  it("lists every reason the pass returns under its own group", () => {
    for (const [reason, title] of Object.entries(ENGINE_SKIP_REASONS)) {
      expect(leftNoteGroups({ ...empty, skipped: [{ path: "a.md", reason }] })).toEqual([
        { title, notes: [{ path: "a.md" }] },
      ]);
    }
  });

  it("groups notes that don't fit and notes it could not read, with the reason", () => {
    const result = {
      ...empty,
      skipped: [
        { path: "a.md", reason: "open-here" },
        { path: "b.md", reason: "ydoc-artifact-pending" },
        { path: "c.md", reason: "ydoc-incomplete-lineage" },
        { path: "d.md", reason: "a-new-reason" },
      ],
      doesNotFit: [{ path: "big.md" }],
      failed: [{ path: "", reason: "object_id must be non-empty and bounded" }],
    };
    expect(leftNoteGroups(result)).toEqual([
      { title: "Open on this computer", notes: [{ path: "a.md" }] },
      { title: "History incomplete", notes: [{ path: "b.md" }, { path: "c.md" }] },
      {
        title: "Could not be read",
        notes: [
          { path: "d.md", reason: "a-new-reason" },
          { path: "", reason: "object_id must be non-empty and bounded" },
        ],
      },
      { title: "Doesn't fit the new format", notes: [{ path: "big.md" }] },
    ]);
    expect(leftNoteCount(result)).toBe(6);
  });
});
