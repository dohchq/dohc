import { describe, expect, it } from "vitest";
import {
  chatFileKind,
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

  it("preserves leading and trailing spaces in paths byte-for-byte", () => {
    const references = [
      { path: " notes/leading.md" },
      { path: "notes/trailing.md " },
      { path: " notes/both.md ", headingAnchor: "scope" },
    ];

    expect(references.map(formatChatFileReferenceToken)).toEqual([
      "@[ notes/leading.md]",
      "@[notes/trailing.md ]",
      "@[ notes/both.md #scope]",
    ]);
    for (const reference of references) {
      expect(extractChatFileReferences(formatChatFileReferenceToken(reference))).toEqual([
        reference,
      ]);
    }
  });

  it("keeps edge-space paths distinct from their trimmed path", () => {
    const body = [
      "@[ notes/collision.md ]",
      "@[notes/collision.md]",
      "@[ notes/collision.md ]",
    ].join(" ");

    expect(extractChatFileReferences(body)).toEqual([
      { path: " notes/collision.md " },
      { path: "notes/collision.md" },
    ]);
  });

  it("rejects whitespace-only path and heading values", () => {
    expect(extractChatFileReferences("@[   ] @[docs/plan.md#   ]")).toEqual([]);
    expect(extractChatFileReferences("@[docs/plan.md# scope ]")).toEqual([
      { path: "docs/plan.md", headingAnchor: "scope" },
    ]);
  });

  it("does not span malformed or multiline tokens", () => {
    expect(extractChatFileReferences("@[missing @[docs/a.md\n#bad]")).toEqual([]);
    expect(extractChatFileReferences("@[missing @[docs/a.md]]")).toEqual([]);
  });

  it("treats inline and fenced code references as inert", () => {
    const body = [
      "Use `@[docs/inline.md]` as an example.",
      "```md",
      "@[docs/fenced.md#scope]",
      "```",
      "Read @[docs/live.md#scope].",
    ].join("\n");

    expect(extractChatFileReferences(body)).toEqual([
      { path: "docs/live.md", headingAnchor: "scope" },
    ]);
  });
});

describe("chatFileKind", () => {
  it("picks the chip glyph by extension", () => {
    expect(chatFileKind("docs/plan.md")).toBe("text");
    expect(chatFileKind("notes.TXT")).toBe("text");
    expect(chatFileKind("data/sales.csv")).toBe("data");
    expect(chatFileKind("shots\cover.png")).toBe("image");
    expect(chatFileKind("build/app.exe")).toBe("file");
    expect(chatFileKind(".env")).toBe("file");
    expect(chatFileKind("README")).toBe("file");
  });
});
