import { describe, expect, it } from "vitest";
import { codeRanges } from "@dohc/workspace-contracts/chat-mentions";
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

// The regular-expression scanner this one replaced, kept to check that the
// linear one finds the same tokens.
function regexTokens(body: string) {
  const pattern = /@\[([^\]\r\n#]+?)(?:#([^\]\r\n]+))?\]/gu;
  const decode = (value: string) =>
    value.replace(/%(23|5d|25)/giu, (escape) => ({ "%23": "#", "%5d": "]" } as Record<string, string>)[escape.toLowerCase()] ?? "%");
  const ranges = codeRanges(body);
  const tokens = [];
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    if (match[0].slice(2).includes("@[")) continue;
    if (ranges.some(([start, end]) => match!.index >= start && match!.index < end)) continue;
    const path = decode(match[1]!);
    if (!path.trim()) continue;
    const headingAnchor = match[2] !== undefined ? decode(match[2].trim()) : undefined;
    if (match[2] !== undefined && !headingAnchor) continue;
    tokens.push({
      path,
      ...(headingAnchor ? { headingAnchor } : {}),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return tokens;
}

describe("the linear reference scanner", () => {
  it("finds what the regular expression found", () => {
    const pieces = ["@[", "]", "#", "\n", "\r", "a", " ", "`", "```\n", "~~~\n", "%23", "%5D", "@", "[", "b.md"];
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 5000; run++) {
      let body = "";
      const size = Math.floor(random() * 40);
      for (let at = 0; at < size; at++) body += pieces[Math.floor(random() * pieces.length)];
      expect({ body, tokens: extractChatFileReferenceTokens(body) }).toEqual({ body, tokens: regexTokens(body) });
    }
  });

  it("reads a long body of openers in linear time", () => {
    for (const body of ["@[".repeat(25_000), "@[a".repeat(16_000), `${"`@[a]".repeat(10_000)}`]) {
      const started = performance.now();
      extractChatFileReferenceTokens(body);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
