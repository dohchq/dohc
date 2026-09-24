import { describe, expect, it } from "vitest";
import { postText, titleRepeatsFirstLine } from "./PostCard";

describe("post text", () => {
  const line =
    "@agent Read ideas.md, draft an itinerary in this folder, and build a poll app so the group can vote on Tokyo or Manila.";
  // What the engine stores as the title of an untitled post with this line.
  const cutTitle = "@agent Read ideas.md, draft an itinerary in this folder, and build a poll app s…";

  it("treats a title cut from the first line as that line", () => {
    expect(titleRepeatsFirstLine(cutTitle, line)).toBe(true);
    expect(titleRepeatsFirstLine("Launch plan", "  Launch   plan ")).toBe(true);
    expect(titleRepeatsFirstLine("Budget review", line)).toBe(false);
    expect(titleRepeatsFirstLine("@agent Read…", "Something else")).toBe(false);
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
