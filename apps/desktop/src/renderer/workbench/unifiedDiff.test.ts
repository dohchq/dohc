import { describe, expect, it } from "vitest";
import {
  HISTORY_DIFF_WORK_LIMIT,
  WORD_DIFF_CHAR_LIMIT,
  buildUnifiedDiffLines,
  changedWords,
  computeTextDiff,
  diffStatCells,
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

  // Regression: "a" vs "a\n" split into identical line
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

// The marked text of each changed line, in order.
function markedWords(before: string, after: string): [string, string[]][] {
  return unified(before, after)
    .filter((line) => line.kind === "added" || line.kind === "removed")
    .map((line) => [line.kind, (line.words ?? []).map(([start, end]) => line.text.slice(start, end))]);
}

describe("changed words", () => {
  it("marks the word a prose edit replaced, on both lines", () => {
    expect(
      markedWords(
        "- Get a new person to their first document in under 30 seconds\n",
        "- Get a new person to their first document in under 20 seconds\n",
      ),
    ).toEqual([
      ["removed", ["30"]],
      ["added", ["20"]],
    ]);
  });

  it("marks an insertion as one span, and nothing on the line it grew from", () => {
    const lines = unified(
      "- Make agent activity readable at a glance\n",
      "- Make agent activity readable at a glance, with who changed what\n",
    );
    expect(lines.map((line) => [line.kind, line.words])).toEqual([
      ["removed", []],
      ["added", [[42, 65]]],
    ]);
    expect(lines[1].text.slice(42, 65)).toBe(", with who changed what");
  });

  it("joins two changed words one space apart into one span", () => {
    expect(markedWords("the quick brown fox jumps\n", "the slow red fox jumps\n")).toEqual([
      ["removed", ["quick brown"]],
      ["added", ["slow red"]],
    ]);
  });

  it("marks a code edit at its token", () => {
    expect(
      markedWords(
        "const diff = computeTextDiff(before, after, 800);\n",
        "const diff = computeTextDiff(before, after, displayLimit);\n",
      ),
    ).toEqual([
      ["removed", ["800"]],
      ["added", ["displayLimit"]],
    ]);
  });

  it("splits CJK text into characters, which it does not space as words", () => {
    expect(markedWords("今日は晴れです\n", "今日は雨です\n")).toEqual([
      ["removed", ["晴れ"]],
      ["added", ["雨"]],
    ]);
  });

  it("pairs a block's removed and added lines in order", () => {
    expect(
      markedWords(
        "keep\nalpha one\nbeta two\nkeep\n",
        "keep\nalpha uno\nbeta dos\nkeep\n",
      ),
    ).toEqual([
      ["removed", ["one"]],
      ["removed", ["two"]],
      ["added", ["uno"]],
      ["added", ["dos"]],
    ]);
  });

  it("leaves a rewritten line whole, and an unpaired line whole", () => {
    const lines = unified(
      "intro\nThe meeting moved to Tuesday.\n",
      "intro\nBring snacks for everyone!\nA line nobody had before\n",
    );
    expect(lines.filter((line) => line.words !== undefined)).toEqual([]);
    expect(changedWords("The meeting moved to Tuesday.", "Bring snacks for everyone!")).toBeNull();
  });

  it("keeps notes and context lines free of word marks", () => {
    for (const line of unified("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\ne\nf\ng\nh changed\n")) {
      if (line.kind === "note" || line.kind === "context") expect(line.words).toBeUndefined();
    }
  });
});

describe("word marks' size limit", () => {
  // Pairs of lines that each differ by one word, totalling `chars` characters
  // across both sides.
  function pairsOf(chars: number): [string, string] {
    const lineChars = 1_000;
    const count = Math.round(chars / (2 * lineChars));
    const body = (word: string) =>
      Array.from({ length: count }, (_, index) => `${String(index).padStart(6, "0")} ${word} ${"x".repeat(lineChars - 14)}`).join("\n") + "\n";
    return [body("aaaaaa"), body("bbbbbb")];
  }

  it("marks every pair up to the limit", () => {
    const [before, after] = pairsOf(WORD_DIFF_CHAR_LIMIT);
    const lines = unified(before, after, 800);
    const changed = lines.filter((line) => line.kind !== "note" && line.kind !== "context");
    expect(changed).toHaveLength(200);
    expect(changed.every((line) => line.words?.length === 1)).toBe(true);
  });

  it("keeps the whole diff at line level past the limit, never half marked", () => {
    const [before, after] = pairsOf(WORD_DIFF_CHAR_LIMIT + 2_000);
    const lines = unified(before, after, 800);
    expect(lines.filter((line) => line.kind === "removed")).toHaveLength(101);
    expect(lines.some((line) => line.words !== undefined)).toBe(false);
  });

  it("keeps one huge line at line level and splits none of it", () => {
    const before = "word ".repeat(100_000);
    const lines = unified(before, before.replace("word word", "word other"));
    expect(lines.map((line) => [line.kind, line.words])).toEqual([
      ["removed", undefined],
      ["added", undefined],
    ]);
  });

  it("stops comparing word by word once the page has spent its comparisons", () => {
    // Each pair changes its first and last word, so it compares its whole
    // line: 99 tokens a side, 10,000 cells. The page has 1,000,000.
    const body = (start: string, end: string) =>
      Array.from({ length: 150 }, (_, index) => `${start}${index} ${"word ".repeat(48)}${end}${index}`).join("\n") + "\n";
    const lines = unified(body("a", "z"), body("b", "y"), 800).filter((line) => line.kind === "removed");
    expect(lines).toHaveLength(150);
    expect(lines[0].words).toHaveLength(2);
    // Past the budget, the marks would cover the whole line, so there are none.
    expect(lines[149].words).toBeUndefined();
    expect(lines.filter((line) => line.words?.length === 2)).toHaveLength(100);
  });

  it("marks the whole middle of a long rewrite inside a kept start and end", () => {
    const middle = (word: string) => Array.from({ length: 200 }, (_, index) => `${word}${index}`).join(" ");
    const before = `Start of the paragraph. ${middle("a")} ${"x ".repeat(600)}End.`;
    const after = `Start of the paragraph. ${middle("b")} ${"x ".repeat(600)}End.`;
    const words = changedWords(before, after);
    expect(words?.before).toEqual([[24, 24 + middle("a").length]]);
    expect(words?.after).toEqual([[24, 24 + middle("b").length]]);
  });
});

describe("the diff's size", () => {
  it("draws one cell per line while the change is five lines or fewer", () => {
    expect(diffStatCells(2, 2)).toEqual(["added", "added", "removed", "removed", "none"]);
    expect(diffStatCells(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
    expect(diffStatCells(5, 0)).toEqual(["added", "added", "added", "added", "added"]);
  });

  it("shares five cells in proportion past five lines, one at least for each side", () => {
    expect(diffStatCells(30, 10)).toEqual(["added", "added", "added", "added", "removed"]);
    expect(diffStatCells(1, 1000)).toEqual(["added", "removed", "removed", "removed", "removed"]);
    expect(diffStatCells(1000, 1)).toEqual(["added", "added", "added", "added", "removed"]);
    expect(diffStatCells(0, 40)).toEqual(["removed", "removed", "removed", "removed", "removed"]);
  });

  it("counts lines, not words, however many words a line changed", () => {
    // Two lines changed, four words among them: the count is the lines.
    expect(
      computeTextDiff("alpha one two\nbeta three four\n", "alpha uno dos\nbeta tres cuatro\n").counts,
    ).toEqual({ added: 2, removed: 2 });
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

// The LCS compares WHOLE LINES per cell, so its cost follows body bytes,
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

  // Both sides of the limit, one 2.5% step apart, so these pin the constant
  // itself rather than only its sign.
  const UNDER_BOUND_CHARS = 3_900;
  const OVER_BOUND_CHARS = 4_100;

  it("estimates the characters the inner loop compares, not the cell count", () => {
    const under = splitDiffLines(longLines(499, UNDER_BOUND_CHARS));
    const over = splitDiffLines(longLines(499, OVER_BOUND_CHARS));
    // Identical cell counts, on the cell ceiling: only the byte bound can tell
    // these two apart.
    expect((under.length + 1) * (under.length + 1)).toBe(250_000);
    expect((over.length + 1) * (over.length + 1)).toBe(250_000);
    expect(diffWorkEstimate(under, under)).toBeLessThan(HISTORY_DIFF_WORK_LIMIT);
    expect(diffWorkEstimate(over, over)).toBeGreaterThan(HISTORY_DIFF_WORK_LIMIT);
  });

  it("keeps the line-by-line diff for a body just inside the bound", () => {
    const before = longLines(499, UNDER_BOUND_CHARS);
    const after = before.replace("000000000100", "000000000999");
    const diff = computeTextDiff(before, after, 800);
    expect(diff.degraded).toBe(false);
    expect(diff.counts).toEqual({ added: 1, removed: 1 });
  });

  it("degrades a body just over the bound to the contiguous diff instead of freezing", () => {
    const before = longLines(499, OVER_BOUND_CHARS);
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
    const before = longLines(499, OVER_BOUND_CHARS);
    const after = before.replace("000000000100", "000000000999");
    const lines = buildUnifiedDiffLines(computeTextDiff(before, after, 800));
    // Line 101 of the file (index 100), on both sides, not line 1.
    expect(lines.find((line) => line.kind === "removed")?.oldLineNumber).toBe(101);
    expect(lines.find((line) => line.kind === "added")?.newLineNumber).toBe(101);
    const context = lines.find((line) => line.kind === "context");
    expect([context?.oldLineNumber, context?.newLineNumber]).toEqual([99, 99]);
  });

  // The degraded diff describes the span between the common prefix and the
  // common suffix as one block, and its counts follow the same rule. The page
  // header shows those counts, so the coarsening is user-visible.
  it("reports the degraded span in the counts, not the exact edit", () => {
    const before = longLines(499, OVER_BOUND_CHARS);
    const after = before
      .replace("000000000100", "000000000999")
      .replace("000000000400", "000000000998");
    const diff = computeTextDiff(before, after, 800);
    expect(diff.degraded).toBe(true);
    expect(diff.counts).toEqual({ added: 301, removed: 301 });
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
    // The counts are the whole change, never only what survived the bound.
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
