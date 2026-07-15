import { describe, expect, it } from "vitest";
import {
  extractChatFileReferences,
  extractChatFileReferenceTokens,
  formatChatFileReferenceToken,
} from "./chatFileMentions";

describe("chat file reference tokens", () => {
  it("round-trips whole-file and heading references", () => {
    expect(formatChatFileReferenceToken({ path: "docs/plan.md" })).toBe(
      "@[docs/plan.md]",
    );
    expect(
      formatChatFileReferenceToken({
        path: "docs/plan.md",
        headingAnchor: "launch-checklist",
      }),
    ).toBe("@[docs/plan.md#launch-checklist]");
  });

  it("extracts and deduplicates references while retaining token ranges", () => {
    const body = "Read @[docs/plan.md#scope] then @[docs/plan.md#scope].";
    expect(extractChatFileReferenceTokens(body)[0]).toMatchObject({
      path: "docs/plan.md",
      headingAnchor: "scope",
      text: "@[docs/plan.md#scope]",
      start: 5,
    });
    expect(extractChatFileReferences(body)).toEqual([
      { path: "docs/plan.md", headingAnchor: "scope" },
    ]);
  });

  it("round-trips reserved delimiters, percent signs, and Unicode paths", () => {
    const reference = {
      path: "notes/C# plan] 100% — 進捗.md",
      headingAnchor: "risks]#50%",
    };
    const token = formatChatFileReferenceToken(reference);

    expect(token).toBe(
      "@[notes/C%23 plan%5D 100%25 — 進捗.md#risks%5D%2350%25]",
    );
    expect(extractChatFileReferences(token)).toEqual([reference]);
    expect(
      extractChatFileReferences(formatChatFileReferenceToken({ path: "notes/literal%23.md" })),
    ).toEqual([{ path: "notes/literal%23.md" }]);
  });

  it("does not span malformed or multiline tokens", () => {
    expect(extractChatFileReferences("@[missing @[docs/a.md\n#bad]")).toEqual([]);
  });
});
