import { describe, expect, it } from "vitest";
import { findQuote, quoteForSelection, quotedCommentBody } from "./commentAnchors";
import { boldText, doc, hardBreak, heading, paragraph } from "./testDocs";

const textAt = (d: ReturnType<typeof doc>, range: { from: number; to: number } | null) =>
  range ? d.textBetween(range.from, range.to, " ", " ").replace(/\s+/g, " ") : null;

describe("findQuote", () => {
  it("finds a passage across marks and returns its document range", () => {
    const d = doc(paragraph("Ship the ", boldText("launch"), " plan on Monday"));
    const range = findQuote(d, "the launch plan");
    expect(range).toEqual({ from: 6, to: 21 });
    expect(textAt(d, range)).toBe("the launch plan");
  });

  it("matches across block boundaries, hard breaks and wrapped lines", () => {
    const d = doc(heading(2, "Budget"), paragraph("Costs rise", hardBreak(), "in   June"));
    expect(textAt(d, findQuote(d, "Budget\nCosts rise in June"))).toBe("Budget Costs rise in June");
  });

  it("finds nothing for a passage the document no longer has", () => {
    const d = doc(paragraph("Ship on Monday"));
    expect(findQuote(d, "Ship on Friday")).toBeNull();
    expect(findQuote(d, "   ")).toBeNull();
  });
});

describe("quoteForSelection", () => {
  it("quotes a passage that reads once as selected", () => {
    const d = doc(paragraph("Ship the launch plan on Monday"));
    expect(quoteForSelection(d, 10, 21)).toEqual({ quote: "launch plan", from: 10, to: 21 });
  });

  it("widens a repeated word until the quote reads once, and the quote finds that passage", () => {
    const d = doc(paragraph("the plan is late"), paragraph("but the plan is good"));
    const from = 19 + "but the ".length;
    const picked = quoteForSelection(d, from, from + 4)!;
    expect(picked.quote).toBe("but the plan is good");
    expect(findQuote(d, picked.quote)).toEqual({ from: picked.from, to: picked.to });
    expect(textAt(d, picked)).toBe("but the plan is good");
  });

  it("widens no further than the selection's block", () => {
    const d = doc(paragraph("plan"), paragraph("plan"));
    expect(quoteForSelection(d, 7, 11)).toEqual({ quote: "plan", from: 7, to: 11 });
  });

  it("trims whitespace at the selection's edges and refuses a selection with no text", () => {
    const d = doc(paragraph("alpha beta"), paragraph("gamma"));
    expect(quoteForSelection(d, 6, 11)?.quote).toBe("beta");
    expect(quoteForSelection(d, 6, 7)).toBeNull();
  });
});

describe("quotedCommentBody", () => {
  it("opens with the quote as one Markdown quote line", () => {
    expect(quotedCommentBody("a\n  b", "Why?")).toBe("> a b\n\nWhy?");
  });

  it("escapes the quote's punctuation, so it reads as text and names no one", () => {
    expect(quotedCommentBody("Ship *the* plan, @ada", "Why?")).toBe(
      "> Ship \\*the\\* plan\\, \\@ada\n\nWhy?",
    );
  });

  it("keeps the first thousand characters of a long quote", () => {
    expect(quotedCommentBody("a".repeat(1_500), "Why?")).toBe(`> ${"a".repeat(1_000)}\n\nWhy?`);
  });
});
