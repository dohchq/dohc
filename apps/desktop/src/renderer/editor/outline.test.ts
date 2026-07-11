import { describe, expect, it } from "vitest";
import {
  extractOutline,
  resolveActiveHeadingIndex,
  type PMHeadingNodeLike,
  type PMOutlineDocLike,
} from "./outline";

// Offline test of the extraction logic — a hand-built doc whose
// `descendants` mirrors ProseMirror's (node, pos), same pattern as
// inlineAtomPlugin.test.ts.

type Entry = { type: string; text?: string; level?: number; pos: number };

function fakeDoc(entries: Entry[]): PMOutlineDocLike {
  return {
    descendants(cb) {
      for (const e of entries) {
        const node: PMHeadingNodeLike = {
          type: { name: e.type },
          attrs: e.type === "heading" ? { level: e.level } : undefined,
          textContent: e.text ?? "",
        };
        cb(node, e.pos);
      }
    },
  };
}

describe("extractOutline", () => {
  it("extracts headings with level, text, and pos in document order", () => {
    const doc = fakeDoc([
      { type: "heading", level: 1, text: "Title", pos: 0 },
      { type: "paragraph", text: "intro copy", pos: 8 },
      { type: "heading", level: 2, text: "Section A", pos: 30 },
      { type: "heading", level: 3, text: "Subsection", pos: 60 },
    ]);

    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "Title", pos: 0 },
      { level: 2, text: "Section A", pos: 30 },
      { level: 3, text: "Subsection", pos: 60 },
    ]);
  });

  it("supports all six heading levels", () => {
    const doc = fakeDoc(
      [1, 2, 3, 4, 5, 6].map((level, i) => ({
        type: "heading",
        level,
        text: `H${level}`,
        pos: i * 10,
      })),
    );
    expect(extractOutline(doc).map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("skips headings with no text (empty or whitespace-only)", () => {
    const doc = fakeDoc([
      { type: "heading", level: 1, text: "", pos: 0 },
      { type: "heading", level: 2, text: "   ", pos: 5 },
      { type: "heading", level: 1, text: "Real heading", pos: 12 },
    ]);
    expect(extractOutline(doc)).toEqual([{ level: 1, text: "Real heading", pos: 12 }]);
  });

  it("trims heading text", () => {
    const doc = fakeDoc([{ type: "heading", level: 1, text: "  Padded  ", pos: 0 }]);
    expect(extractOutline(doc)).toEqual([{ level: 1, text: "Padded", pos: 0 }]);
  });

  it("ignores non-heading nodes entirely", () => {
    const doc = fakeDoc([
      { type: "paragraph", text: "not a heading", pos: 0 },
      { type: "codeBlock", text: "# not markdown here", pos: 20 },
    ]);
    expect(extractOutline(doc)).toEqual([]);
  });

  it("falls back to level 1 for a missing/non-numeric level attr", () => {
    const doc: PMOutlineDocLike = {
      descendants(cb) {
        cb({ type: { name: "heading" }, attrs: {}, textContent: "No level" }, 0);
      },
    };
    expect(extractOutline(doc)).toEqual([{ level: 1, text: "No level", pos: 0 }]);
  });

  it("returns an empty array for a doc with no headings", () => {
    expect(extractOutline(fakeDoc([{ type: "paragraph", text: "just prose", pos: 0 }]))).toEqual(
      [],
    );
  });
});

describe("resolveActiveHeadingIndex", () => {
  const tops = [0, 200, 500, 900];

  it("returns -1 for an empty heading list", () => {
    expect(resolveActiveHeadingIndex([], 500)).toBe(-1);
  });

  it("returns 0 before scrolling past the first heading", () => {
    expect(resolveActiveHeadingIndex(tops, 0)).toBe(0);
  });

  it("picks the last heading whose top has scrolled past scrollTop", () => {
    expect(resolveActiveHeadingIndex(tops, 250)).toBe(1);
    expect(resolveActiveHeadingIndex(tops, 899)).toBe(2);
    expect(resolveActiveHeadingIndex(tops, 900)).toBe(3);
    expect(resolveActiveHeadingIndex(tops, 5000)).toBe(3);
  });

  it("applies a readingOffset to nudge the threshold down from the viewport top", () => {
    // Without an offset, scrollTop=150 hasn't reached heading 1 (top 200) yet.
    expect(resolveActiveHeadingIndex(tops, 150)).toBe(0);
    // With a 60px reading offset, the effective threshold is 210 — past it.
    expect(resolveActiveHeadingIndex(tops, 150, 60)).toBe(1);
  });

  it("is exact at the boundary (top === scrollTop + offset counts as reached)", () => {
    expect(resolveActiveHeadingIndex([100], 100)).toBe(0);
    expect(resolveActiveHeadingIndex([100], 99)).toBe(0); // still index 0, nothing before it
  });
});
