import { describe, expect, it } from "vitest";
import {
  searchDemoDocuments,
  type DemoBridgeDocument,
} from "./demoDesktopBridge";

const documents: DemoBridgeDocument[] = [
  {
    path: "projects/launch.md",
    title: "Launch work",
    body: "## Checklist\nworkflow work WORK",
  },
  {
    path: "research/notes.md",
    title: "Research",
    body: "## Findings\nwork",
  },
];

describe("searchDemoDocuments", () => {
  it("honors regex and case sensitivity", () => {
    expect(
      searchDemoDocuments(documents, {
        query: "^## [A-Z]",
        regex: true,
        caseSensitive: true,
      }).map((entry) => entry.preview),
    ).toEqual(["## Checklist", "## Findings"]);
  });

  it("honors whole-word matching", () => {
    const results = searchDemoDocuments(documents, {
      query: "work",
      wholeWord: true,
      caseSensitive: true,
    });
    expect(results.map((entry) => entry.preview)).toEqual([
      "Launch work",
      "workflow work WORK",
      "work",
    ]);
    expect(results[1]).toMatchObject({ matchStart: 9, matchEnd: 13 });
  });

  it("honors include and exclude globs", () => {
    expect(
      searchDemoDocuments(documents, {
        query: "##",
        includeGlob: "**/*.md",
        excludeGlob: "research/**",
      }).map((entry) => entry.path),
    ).toEqual(["projects/launch.md"]);
  });

  it("returns no results for an invalid regular expression", () => {
    expect(
      searchDemoDocuments(documents, { query: "[", regex: true }),
    ).toEqual([]);
  });
});
