import { describe, expect, it } from "vitest";
import {
  HISTORY_DIFF_WORK_LIMIT,
  buildUnifiedDiffLines,
  computeTextDiff,
  diffWorkEstimate,
  splitDiffLines,
} from "./unifiedDiff";

function unified(before: string | undefined, after: string | undefined, limit = 600) {
  return buildUnifiedDiffLines(computeTextDiff(before, after, limit));
}

describe("buildUnifiedDiffLines", () => {
  it("renders added and removed lines with gutters", () => {
    const lines = unified("one\ntwo\n", "one\nthree\n");
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "one"],
      ["removed", "two"],
      ["added", "three"],
    ]);
  });

  it("says No text changes for identical texts", () => {
    expect(unified("same\n", "same\n")).toEqual([
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });

  // Regression (CodeRabbit arc gate): "a" vs "a\n" split into identical line
  // arrays, so these exact-text changes used to render as "No text changes".
  it("names final-newline-only changes instead of claiming no changes", () => {
    expect(unified("a", "a\n")).toEqual([
      {
        kind: "note",
        text: "Only line endings or the final newline changed",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });

  it("names line-ending-only (CRLF vs LF) changes honestly", () => {
    expect(unified("one\r\ntwo\r\n", "one\ntwo\n")).toEqual([
      {
        kind: "note",
        text: "Only line endings or the final newline changed",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });

  it("treats undefined-vs-empty as a create/delete of an empty file, not a line-ending change", () => {
    expect(unified(undefined, "")).toEqual([
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });
});

describe("changed line counts", () => {
  it("counts added and removed lines", () => {
    expect(computeTextDiff("one\ntwo\n", "one\nthree\nfour\n").counts).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("returns null when neither side exists", () => {
    expect(computeTextDiff(undefined, undefined).counts).toBeNull();
  });
});

// #516: the LCS compares WHOLE LINES per cell, so its cost follows body bytes,
// which the cell limit never bounded. These pin the byte bound and the
// allocation bound that replaced the unbounded work.
describe("diff work bound", () => {
  // 499 lines a side parks the cell count exactly on the cell ceiling
  // (500 * 500 = 250,000), so only the byte bound can decide those cases.
  function longLines(count: number, lineChars: number): string {
    const filler = "x".repeat(Math.max(0, lineChars - 12));
    const out: string[] = [];
    for (let index = 0; index < count; index += 1) {
      out.push(filler + String(index).padStart(12, "0"));
    }
    return out.join("\n") + "\n";
  }

  it("estimates the characters the inner loop compares, not the cell count", () => {
    const before = splitDiffLines(longLines(499, 8_200));
    const after = splitDiffLines(longLines(499, 8_200));
    expect((before.length + 1) * (after.length + 1)).toBe(250_000);
    expect(diffWorkEstimate(before, after)).toBeGreaterThan(HISTORY_DIFF_WORK_LIMIT);
  });

  it("keeps the line-by-line diff for a body inside the bound", () => {
    const before = longLines(499, 500);
    const after = before.replace("000000000100", "000000000999");
    const diff = computeTextDiff(before, after, 800);
    expect(diff.degraded).toBe(false);
    expect(diff.counts).toEqual({ added: 1, removed: 1 });
  });

  it("degrades a body over the bound to the contiguous diff instead of freezing", () => {
    const before = longLines(499, 8_200);
    const after = before.replace("000000000100", "000000000999");
    const diff = computeTextDiff(before, after, 800);
    expect(diff.degraded).toBe(true);
    // Still a usable diff: the one changed line, with its neighbours.
    expect(diff.counts).toEqual({ added: 1, removed: 1 });
    const lines = buildUnifiedDiffLines(diff);
    expect(lines.filter((line) => line.kind === "removed")).toHaveLength(1);
    expect(lines.filter((line) => line.kind === "added")).toHaveLength(1);
  });

  it("numbers the degraded diff from its place in the file, not from line 1", () => {
    const before = longLines(499, 8_200);
    const after = before.replace("000000000100", "000000000999");
    const lines = buildUnifiedDiffLines(computeTextDiff(before, after, 800));
    const removed = lines.find((line) => line.kind === "removed");
    // Line 101 of the file (index 100), not line 1.
    expect(removed?.oldLineNumber).toBe(101);
  });

  it("builds no more diff lines than the display shows, and still counts them all", () => {
    // A newline-heavy 10 MiB body: 250,000 lines a side is far past the cell
    // ceiling, so it degrades — and the degraded diff used to build one object
    // per line of the whole body before the 800-line display bound applied.
    const before = longLines(250_000, 40);
    const after = before.replace(/x/g, "y");
    expect(before.length).toBeGreaterThan(10_000_000);
    const diff = computeTextDiff(before, after, 800);
    expect(diff.degraded).toBe(true);
    expect(diff.lines.length).toBeLessThanOrEqual(804);
    expect(diff.hiddenLines).toBeGreaterThan(400_000);
    // The counts are the WHOLE change, never only what survived the bound.
    expect(diff.counts).toEqual({ added: 250_000, removed: 250_000 });
    const lines = buildUnifiedDiffLines(diff);
    expect(lines).toHaveLength(801);
    expect(lines[800].text).toBe("499200 more diff lines hidden");
  });

  it("bounds a create of a huge body the same way", () => {
    const diff = computeTextDiff(undefined, longLines(250_000, 40), 800);
    expect(diff.lines.length).toBeLessThanOrEqual(804);
    expect(diff.counts).toEqual({ added: 250_000, removed: 0 });
    expect(buildUnifiedDiffLines(diff)).toHaveLength(801);
  });
});
