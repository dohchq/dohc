import { describe, expect, it } from "vitest";
import {
  extractWorkspaceHeadings,
  findWorkspaceHeading,
  headingAnchorBase,
  workspaceHeadingSection,
} from "./workspaceHeadings";

describe("workspace headings", () => {
  it("extracts ATX and setext headings with deterministic duplicate anchors", () => {
    const markdown = [
      "# Launch Plan",
      "intro",
      "## Pricing & Regions",
      "first",
      "## Pricing & Regions",
      "second",
      "Appendix",
      "========",
      "tail",
    ].join("\n");
    const headings = extractWorkspaceHeadings(markdown);
    expect(headings.map(({ text, level, anchor, occurrence }) => ({ text, level, anchor, occurrence }))).toEqual([
      { text: "Launch Plan", level: 1, anchor: "launch-plan", occurrence: 0 },
      { text: "Pricing & Regions", level: 2, anchor: "pricing-regions", occurrence: 0 },
      { text: "Pricing & Regions", level: 2, anchor: "pricing-regions-1", occurrence: 1 },
      { text: "Appendix", level: 1, anchor: "appendix", occurrence: 0 },
    ]);
    expect(workspaceHeadingSection(markdown, headings[1]!)).toBe(
      "## Pricing & Regions\nfirst",
    );
  });

  it("ignores headings in fenced and indented code", () => {
    const headings = extractWorkspaceHeadings([
      "```md",
      "# hidden",
      "```not-a-close",
      "## still hidden",
      "```",
      "    ## also hidden",
      "## Visible",
    ].join("\n"));
    expect(headings.map((heading) => heading.text)).toEqual(["Visible"]);
  });

  it("does not treat a mixed backtick-and-tilde run as a code fence", () => {
    const headings = extractWorkspaceHeadings([
      "``~",
      "# Still visible",
    ].join("\n"));

    expect(headings.map((heading) => heading.text)).toEqual(["Still visible"]);
  });

  it("allows the opposite fence marker in a valid info string", () => {
    const headings = extractWorkspaceHeadings([
      "```~",
      "# Hidden by backticks",
      "```",
      "~~~`js",
      "## Hidden by tildes",
      "~~~",
      "## Visible",
    ].join("\n"));

    expect(headings.map((heading) => heading.text)).toEqual(["Visible"]);
  });

  it("resolves encoded anchors and falls back to text occurrence", () => {
    const headings = extractWorkspaceHeadings("## Café plan\nA\n## Café plan\nB");
    expect(findWorkspaceHeading(headings, { anchor: "caf%C3%A9-plan" })?.line).toBe(1);
    expect(findWorkspaceHeading(headings, { text: "Café plan", occurrence: 1 })?.line).toBe(3);
  });

  it("normalizes formatting without discarding unicode", () => {
    expect(headingAnchorBase("**Über** `Plan`!" )).toBe("über-plan");
  });

  it("preserves hashes in heading text unless closing hashes are whitespace-delimited", () => {
    expect(
      extractWorkspaceHeadings("## C#\n## Release notes ###\n").map(
        ({ text, anchor }) => ({ text, anchor }),
      ),
    ).toEqual([
      { text: "C#", anchor: "c" },
      { text: "Release notes", anchor: "release-notes" },
    ]);
  });

  it("does not promote list items or blockquotes before thematic breaks to setext headings", () => {
    const markdown = [
      "- first item",
      "---",
      "> quoted note",
      "===",
      "1. ordered item",
      "---",
      "C#",
      "---",
    ].join("\n");

    expect(
      extractWorkspaceHeadings(markdown).map(({ text, level }) => ({ text, level })),
    ).toEqual([{ text: "C#", level: 2 }]);
  });

  it("gives symbol-only headings stable non-empty anchors and preserves duplicates", () => {
    const firstBase = headingAnchorBase("🚀");
    expect(firstBase).toMatch(/^section-[a-z0-9]+$/);
    expect(headingAnchorBase("🚀")).toBe(firstBase);
    expect(headingAnchorBase("!!!")).not.toBe("");

    const headings = extractWorkspaceHeadings("# 🚀\nfirst\n# 🚀\nsecond\n# !!!");
    expect(headings.map(({ anchor, occurrence }) => ({ anchor, occurrence }))).toEqual([
      { anchor: firstBase, occurrence: 0 },
      { anchor: `${firstBase}-1`, occurrence: 1 },
      { anchor: headingAnchorBase("!!!"), occurrence: 0 },
    ]);
  });
});
