import { expect, it, vi } from "vitest";
import type { ChatChannelSummary } from "@dohc/workspace-contracts/engine";
import { createJoinedGroup } from "./joinedGroupCreate";
import { signalChatWrite, subscribeChatWrites } from "./chatWriteSignals";

const team = {
  id: "channel_wire_team",
  workspaceId: "joined",
  name: "Team",
  slug: "team",
  kind: "channel",
  type: "both",
  purpose: "",
  createdAtMs: 1,
  updatedAtMs: 1,
  threadCount: 0,
  unreadCount: 0,
} as ChatChannelSummary;

// Proves: an agent's New group finishes while no window pulls the joined
// workspace, because the creation starts the pull that brings the Group.
it("pulls the joined workspace itself, so the Group arrives with no window pulling", async () => {
  const channels: ChatChannelSummary[] = [];
  const pullJoinedWorkspace = vi.fn(async (workspaceId: string) => {
    channels.push(team);
    signalChatWrite(workspaceId);
  });
  const created = createJoinedGroup(
    {
      createJoinedWorkspaceGroup: async () => ({ channelWireId: team.id }),
      subscribeChatWrites,
      pullJoinedWorkspace,
    },
    {
      workspace: { workspaceId: "joined", shareView: {} },
      store: { listChannels: async () => [...channels] },
    },
    { name: "Team" },
    () => undefined,
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const noPull = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("Nothing pulled the joined workspace.")), 2_000);
  });
  try {
    await expect(Promise.race([created, noPull])).resolves.toEqual({
      channel: team,
      channelWireId: team.id,
    });
  } finally {
    clearTimeout(deadline);
  }
  expect(pullJoinedWorkspace).toHaveBeenCalledWith("joined");
});

// Proves: a failed pull does not fail the creation; the wait still hears a
// pull that brings the Group from elsewhere.
it("keeps waiting when its own pull fails", async () => {
  const channels: ChatChannelSummary[] = [];
  const created = createJoinedGroup(
    {
      createJoinedWorkspaceGroup: async () => ({ channelWireId: team.id }),
      subscribeChatWrites,
      pullJoinedWorkspace: async () => {
        throw new Error("offline");
      },
    },
    {
      workspace: { workspaceId: "joined-2", shareView: {} },
      store: { listChannels: async () => [...channels] },
    },
    { name: "Team" },
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  channels.push(team);
  signalChatWrite("joined-2");
  await expect(created).resolves.toEqual({ channel: team, channelWireId: team.id });
});
