import { describe, expect, it } from "vitest";
import type { ReachRoster, RosterGrant } from "@dohc/automation-executor/automation-reach";
import { chatSharedWithOthers, runDohcToolsFor, SHARED_CHAT_RUNS_GET_ALL_TOOLS } from "./runDohcTools";

const fileGrant: RosterGrant = {
  grantId: "grant-files",
  recipientUserId: "user-ana",
  recipientEmail: "ana@example.com",
  files: { paths: ["Notes"], versionId: null, access: "edit" },
  channel: null,
};
const groupGrant: RosterGrant = {
  grantId: "grant-group",
  recipientUserId: null,
  recipientEmail: "ben@example.com",
  files: { paths: ["Trip"], versionId: null, access: "edit" },
  channel: { wireId: "wire-trip", canPost: true },
};

function owner(...grants: RosterGrant[]): ReachRoster {
  return { kind: "owner", ownerUserId: "user-owner", grants };
}

describe("chatSharedWithOthers", () => {
  it("counts a Group the owner shared and no other", () => {
    expect(chatSharedWithOthers("wire-trip", [], owner(fileGrant, groupGrant))).toBe(true);
    expect(chatSharedWithOthers("wire-dm", [], owner(fileGrant, groupGrant))).toBe(false);
  });

  it("counts a Group this workspace joined", () => {
    expect(chatSharedWithOthers("wire-joined", ["wire-joined"], owner())).toBe(true);
  });

  it("counts a thread outside any shared channel once the workspace has a grant", () => {
    expect(chatSharedWithOthers(null, [], owner())).toBe(false);
    expect(chatSharedWithOthers(null, [], owner(fileGrant))).toBe(true);
  });

  it("counts a roster dohc can't read, and a shared view", () => {
    expect(chatSharedWithOthers("wire-dm", [], { kind: "unknown", problem: { kind: "unchecked", next: "Try again in a moment." } })).toBe(true);
    expect(chatSharedWithOthers("wire-dm", [], { kind: "shared-view" })).toBe(true);
  });
});

describe("runDohcToolsFor", () => {
  const store = {
    findThreadChannelId: async ({ threadId }: { threadId: string }) =>
      ({ "thread-trip": "channel-trip", "thread-agent": "channel-agent" } as Record<string, string>)[threadId] ?? null,
    getChannelWireId: async ({ channelId }: { channelId: string }) =>
      ({ "channel-trip": "wire-trip", "channel-agent": "wire-agent" } as Record<string, string>)[channelId] ?? null,
  };
  const toolsFor = (threadId: string, roster: ReachRoster) => runDohcToolsFor({
    store, workspaceId: "ws-1", threadId, joinedChannelWireIds: [], roster: async () => roster,
  });

  it("keeps a run in a shared Group at the reply tool while the switch is off", async () => {
    expect(SHARED_CHAT_RUNS_GET_ALL_TOOLS).toBe(false);
    expect(await toolsFor("thread-trip", owner(groupGrant))).toBe("reply");
    expect(await toolsFor("thread-agent", owner(groupGrant))).toBe("all");
    expect(await toolsFor("thread-comment", owner())).toBe("all");
    expect(await toolsFor("thread-comment", owner(groupGrant))).toBe("reply");
  });
});
