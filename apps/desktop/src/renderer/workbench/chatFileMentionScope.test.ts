import { describe, expect, it } from "vitest";
import { channelFileCandidates, DM_FILE_CANDIDATES } from "./chatFileMentionScope";

const files = [
  { path: "team/plan.md", label: "plan" },
  { path: "team-notes.md", label: "team-notes" },
  { path: "shared-with-me/ana/team/plan.md", label: "plan" },
  { path: "shared-with-me/ana/other/x.md", label: "x" },
  { path: "shared-with-me/bo/team/b.md", label: "b" },
];
const group = { kind: "channel" as const, folderPath: "team" };

describe("channelFileCandidates", () => {
  it("offers every file outside a shared Group, and none in a direct message", () => {
    expect(channelFileCandidates(files, null, { kind: "unshared" })).toBe(files);
    expect(channelFileCandidates(files, { kind: "agent" }, { kind: "owned" })).toBe(files);
    expect(channelFileCandidates(files, group, { kind: "unshared" })).toBe(files);
    expect(channelFileCandidates(files, { kind: "dm" }, { kind: "unshared" })).toBe(
      DM_FILE_CANDIDATES,
    );
  });

  it("offers an owned Group's folder", () => {
    expect(channelFileCandidates(files, group, { kind: "owned" })).toEqual([files[0]]);
  });

  it("offers a joined Group's mounted files under the paths its readers link", () => {
    expect(channelFileCandidates(files, group, { kind: "joined", mountLabel: "ana" })).toEqual([
      { path: "team/plan.md", label: "plan", readPath: "shared-with-me/ana/team/plan.md" },
    ]);
  });

  it("offers no file of this workspace's own in a joined Group whose mount is missing", () => {
    expect(channelFileCandidates(files, group, { kind: "joined", mountLabel: null })).toEqual([]);
    expect(
      channelFileCandidates(files, { kind: "channel" }, { kind: "joined", mountLabel: "ana" }),
    ).toEqual([]);
  });
});
