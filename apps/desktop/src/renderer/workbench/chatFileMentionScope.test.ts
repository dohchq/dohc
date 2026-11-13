import { describe, expect, it } from "vitest";
import { channelFileCandidates } from "./chatFileMentionScope";

const files = [
  { path: "team/plan.md", label: "plan" },
  { path: "team-notes.md", label: "team-notes" },
  { path: "docs/a.md", label: "a" },
  { path: "shared-with-me/ana/team/plan.md", label: "plan" },
  { path: "shared-with-me/ana/other/x.md", label: "x" },
  { path: "shared-with-me/bo/team/b.md", label: "b" },
];
const group = { fileLinks: { kind: "shared" as const, shares: [["team"]] } };

describe("channelFileCandidates", () => {
  it("offers every file where any may be linked, and none in a direct message", () => {
    expect(channelFileCandidates(files, null, null)).toBe(files);
    expect(channelFileCandidates(files, {}, null)).toBe(files);
    expect(channelFileCandidates(files, { fileLinks: { kind: "any" } }, null)).toBe(files);
    expect(channelFileCandidates(files, { fileLinks: { kind: "none" } }, null)).toEqual([]);
  });

  it("offers a shared Group's files that every share covers", () => {
    expect(channelFileCandidates(files, group, null)).toEqual([files[0]]);
    const twoShares = {
      fileLinks: { kind: "shared" as const, shares: [["team"], ["team", "docs"]] },
    };
    expect(channelFileCandidates(files, twoShares, null)).toEqual([files[0]]);
    const chatOnly = { fileLinks: { kind: "shared" as const, shares: [["team"], []] } };
    expect(channelFileCandidates(files, chatOnly, null)).toEqual([]);
  });

  it("offers a joined Group's mounted files under the paths its readers link", () => {
    expect(channelFileCandidates(files, group, { mountLabel: "ana" })).toEqual([
      { path: "team/plan.md", label: "plan", readPath: "shared-with-me/ana/team/plan.md" },
    ]);
  });

  it("offers no file of this workspace's own in a joined Group whose mount is missing", () => {
    expect(channelFileCandidates(files, group, { mountLabel: null })).toEqual([]);
    const noFolder = { fileLinks: { kind: "shared" as const, shares: [[]] } };
    expect(channelFileCandidates(files, noFolder, { mountLabel: "ana" })).toEqual([]);
  });
});
