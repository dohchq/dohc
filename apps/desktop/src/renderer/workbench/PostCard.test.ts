import { describe, expect, it } from "vitest";
import { postText, titleRepeatsFirstLine } from "./PostCard";

describe("post text", () => {
  const line =
    "@agent Read ideas.md, draft an itinerary in this folder, and build a poll app so the group can vote on Tokyo or Manila.";
  const cutTitle =
    "@agent Read ideas.md, draft an itinerary in this folder, and build a poll app s…";

  it("treats the title the engine derives from the first line as that line", () => {
    expect(titleRepeatsFirstLine(cutTitle, line)).toBe(true);
    expect(titleRepeatsFirstLine("Launch plan", "  Launch \u00a0 plan ")).toBe(true);
    expect(titleRepeatsFirstLine(`${"a".repeat(78)}…`, `${"a".repeat(78)} ${"b".repeat(10)}`)).toBe(
      true,
    );
    // Characters are code points: 81 emoji are cut to 79, not to 39.
    expect(titleRepeatsFirstLine(`${"🧭".repeat(79)}…`, "🧭".repeat(81))).toBe(true);
    const [a, b] = [`@[work:${"A".repeat(43)}]`, `@[work:${"B".repeat(43)}]`];
    expect(
      titleRepeatsFirstLine(`Plans live in ${a}. See…`, `Plans live in ${a}. See ${b} and more.`),
    ).toBe(true);
  });

  it("keeps an explicit title, even one that ends in …", () => {
    expect(titleRepeatsFirstLine("Budget review", line)).toBe(false);
    expect(titleRepeatsFirstLine("Roadmap…", "Roadmap for the next quarter")).toBe(false);
    expect(titleRepeatsFirstLine("…", line)).toBe(false);
    expect(titleRepeatsFirstLine("@agent Read ideas.md…", line)).toBe(false);
    expect(titleRepeatsFirstLine("New chat", "")).toBe(false);
    expect(postText("Roadmap…", "Roadmap for the next quarter")).toEqual({
      heading: "Roadmap…",
      excerpt: "Roadmap for the next quarter",
    });
  });
});
