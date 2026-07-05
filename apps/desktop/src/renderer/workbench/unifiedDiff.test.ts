import { describe, expect, it } from "vitest";
import { buildUnifiedDiffLines, changedLineCounts } from "./unifiedDiff";

describe("buildUnifiedDiffLines", () => {
  it("renders added and removed lines with gutters", () => {
    const lines = buildUnifiedDiffLines("one\ntwo\n", "one\nthree\n");
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "one"],
      ["removed", "two"],
      ["added", "three"],
    ]);
  });

  it("says No text changes for identical texts", () => {
    expect(buildUnifiedDiffLines("same\n", "same\n")).toEqual([
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
    expect(buildUnifiedDiffLines("a", "a\n")).toEqual([
      {
        kind: "note",
        text: "Only line endings or the final newline changed",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });

  it("names line-ending-only (CRLF vs LF) changes honestly", () => {
    const lines = buildUnifiedDiffLines("one\r\ntwo\r\n", "one\ntwo\n");
    expect(lines).toEqual([
      {
        kind: "note",
        text: "Only line endings or the final newline changed",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });

  it("treats undefined-vs-empty as a create/delete of an empty file, not a line-ending change", () => {
    expect(buildUnifiedDiffLines(undefined, "")).toEqual([
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ]);
  });
});

describe("changedLineCounts", () => {
  it("counts added and removed lines", () => {
    expect(changedLineCounts("one\ntwo\n", "one\nthree\nfour\n")).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("returns null when neither side exists", () => {
    expect(changedLineCounts(undefined, undefined)).toBeNull();
  });
});
