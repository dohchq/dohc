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
      "```",
      "    ## also hidden",
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
});
