import { describe, expect, it } from "vitest";
import {
  extractWorkspaceHeadings,
  findWorkspaceHeading,
  headingAnchorBase,
  resolveWorkspaceHeadingAnchorTarget,
  workspaceHeadingRecords,
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

  it("keeps anchors unique when a literal heading occupies a duplicate suffix", () => {
    const headings = extractWorkspaceHeadings([
      "# Foo",
      "# Foo-1",
      "# Foo",
      "# Foo",
    ].join("\n"));

    expect(headings.map(({ anchor, occurrence }) => ({ anchor, occurrence }))).toEqual([
      { anchor: "foo", occurrence: 0 },
      { anchor: "foo-1", occurrence: 0 },
      { anchor: "foo-2", occurrence: 1 },
      { anchor: "foo-3", occurrence: 2 },
    ]);
    expect(new Set(headings.map((heading) => heading.anchor)).size).toBe(headings.length);
    expect(findWorkspaceHeading(headings, { anchor: "foo-2", occurrence: 1 }))
      .toBe(headings[2]);
    expect(findWorkspaceHeading(headings, { anchor: "foo", occurrence: 1 }))
      .toBe(headings[2]);
    expect(findWorkspaceHeading(headings, { anchor: "foo-1", occurrence: 1 }))
      .toBe(headings[2]);
  });

  it("uniquifies a literal suffixed base that follows an existing duplicate", () => {
    const headings = extractWorkspaceHeadings("# Foo\n# Foo\n# Foo-1");

    expect(headings.map(({ anchor, occurrence }) => ({ anchor, occurrence }))).toEqual([
      { anchor: "foo", occurrence: 0 },
      { anchor: "foo-1", occurrence: 1 },
      { anchor: "foo-1-1", occurrence: 0 },
    ]);
  });

  it("prefers a genuine suffixed-base occurrence over the legacy fallback", () => {
    const headings = extractWorkspaceHeadings([
      "# Foo",
      "# Foo-1",
      "# Foo",
      "# Foo-1",
    ].join("\n"));

    expect(findWorkspaceHeading(headings, { anchor: "foo-1", occurrence: 1 }))
      .toBe(headings[3]);
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

  it("does not open a backtick fence whose info string contains a backtick", () => {
    const headings = extractWorkspaceHeadings([
      "```lang`invalid",
      "# Visible after invalid opener",
    ].join("\n"));

    expect(headings.map((heading) => heading.text)).toEqual([
      "Visible after invalid opener",
    ]);
  });

  it("keeps the heading picker usable when an ordinary heading exceeds IPC limits", () => {
    const headings = extractWorkspaceHeadings([
      `# ${"a".repeat(500)}`,
      "## Still available",
    ].join("\n"));

    expect(workspaceHeadingRecords(headings)).toEqual([{
      text: "Still available",
      level: 2,
      anchor: "still-available",
      occurrence: 0,
      line: 2,
    }]);
  });

  it("resolves encoded anchors and falls back to text occurrence", () => {
    const headings = extractWorkspaceHeadings("## Café plan\nA\n## Café plan\nB");
    expect(findWorkspaceHeading(headings, { anchor: "caf%C3%A9-plan" })?.line).toBe(1);
    expect(
      findWorkspaceHeading(headings, {
        anchor: "caf%C3%A9-plan",
        occurrence: 1,
      })?.line,
    ).toBe(3);
    expect(
      findWorkspaceHeading(headings, {
        anchor: "caf%C3%A9-plan-1",
        occurrence: 1,
      })?.line,
    ).toBe(3);
    expect(findWorkspaceHeading(headings, { text: "Café plan", occurrence: 1 })?.line).toBe(3);
  });

  it("decodes a raw heading fragment exactly once", () => {
    const headings = [
      { anchor: "a b", text: "Space", occurrence: 0 },
      { anchor: "a%20b", text: "Literal escape", occurrence: 0 },
      {
        anchor: "bad%E0%A4%A",
        text: "Malformed escape",
        occurrence: 0,
      },
    ];

    expect(
      resolveWorkspaceHeadingAnchorTarget(headings, { anchor: "a%20b" }),
    ).toBe(headings[0]);
    expect(
      resolveWorkspaceHeadingAnchorTarget(headings, { anchor: "a%2520b" }),
    ).toBe(headings[1]);
    expect(
      resolveWorkspaceHeadingAnchorTarget(headings, {
        anchor: "bad%E0%A4%A",
      }),
    ).toBe(headings[2]);
    expect(
      resolveWorkspaceHeadingAnchorTarget(headings, { anchor: "" }),
    ).toBeNull();
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
