import { describe, expect, it } from "vitest";
import { postText, titleRepeatsFirstLine } from "./PostCard";

describe("post text", () => {
  const line =
    "@agent Read ideas.md, draft an itinerary in this folder, and build a poll app so the group can vote on Tokyo or Manila.";
  // What the engine stores as the title of an untitled post with this line.
  const cutTitle = "@agent Read ideas.md, draft an itinerary in this folder, and build a poll app s…";

  it("treats the title the engine derives from the first line as that line", () => {
    // The title the running app stored for this post (trip-08).
    expect(titleRepeatsFirstLine(cutTitle, line)).toBe(true);
    expect(titleRepeatsFirstLine("Launch plan", "  Launch \u00a0 plan ")).toBe(true);
    // A cut that ends on a space drops it before the "…".
    expect(titleRepeatsFirstLine(`${"a".repeat(78)}…`, `${"a".repeat(78)} ${"b".repeat(10)}`)).toBe(true);
    // Characters are code points: 81 emoji are cut to 79, not to 39.
    expect(titleRepeatsFirstLine(`${"🧭".repeat(79)}…`, "🧭".repeat(81))).toBe(true);
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

  it("shows a one-line post once, whole", () => {
    expect(postText(cutTitle, line)).toEqual({ heading: line, excerpt: "" });
  });

  it("shows the whole first line, then the rest, for a longer post", () => {
    expect(postText(cutTitle, `${line}\nBudget is 2,000.`)).toEqual({
      heading: line,
      excerpt: "Budget is 2,000.",
    });
  });

  it("keeps an explicit title and the whole body", () => {
    expect(postText("Trip plan", line)).toEqual({ heading: "Trip plan", excerpt: line });
  });
});
