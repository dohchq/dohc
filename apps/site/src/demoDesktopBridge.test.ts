import { describe, expect, it } from "vitest";
import {
  answerDemoJoinedLane,
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
    expect(searchDemoDocuments(documents, { query: "[", regex: true })).toEqual([]);
  });
});

describe("answerDemoJoinedLane", () => {
  it("answers exactly the wire ids the caller named", () => {
    expect(answerDemoJoinedLane(["wire-general", "wire-projects"])).toEqual([
      { channelWireId: "wire-general", joined: null },
      { channelWireId: "wire-projects", joined: null },
    ]);
  });

  it("answers no grant, which is what makes an owned local channel writable", () => {
    // null is "asked, and this workspace holds no grant". Absent would be
    // "nobody asked", and that fails closed.
    const [answer] = answerDemoJoinedLane(["wire-general"]);
    expect(answer).toHaveProperty("joined", null);
  });

  it("answers nothing for a caller that named nothing", () => {
    expect(answerDemoJoinedLane([])).toEqual([]);
  });
});
