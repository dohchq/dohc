import type { ReachRoster } from "@dohc/automation-executor/automation-reach";
import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";

/**
 * The dohc MCP tools a dispatched run's agent gets: every tool dohc-mcp
 * offers a local workspace at the Owner level, or only the reply tool.
 */
export type RunDohcTools = "all" | "reply";

// The one switch for a run in a chat someone else can see, such as a Group
// shared with another person. False keeps that run at the reply tool.
export const SHARED_CHAT_RUNS_GET_ALL_TOOLS: boolean = false;

/**
 * The tools a run in this thread gets. Main decides from the workspace's
 * chat store, registry, and share roster, never from the thread's text.
 */
export async function runDohcToolsFor(input: {
  store: Pick<LinkedChatStore, "findThreadChannelId" | "getChannelWireId">;
  workspaceId: string;
  threadId: string;
  // The channels this workspace joined from someone else's share.
  joinedChannelWireIds: readonly string[];
  roster(): Promise<ReachRoster>;
}): Promise<RunDohcTools> {
  if (SHARED_CHAT_RUNS_GET_ALL_TOOLS) return "all";
  const { store, workspaceId, threadId } = input;
  const channelId = await store.findThreadChannelId({ workspaceId, threadId });
  const wireId = channelId === null ? null : await store.getChannelWireId({ workspaceId, channelId });
  return chatSharedWithOthers(wireId, input.joinedChannelWireIds, await input.roster()) ? "reply" : "all";
}

// Someone else can see a chat that this workspace joined, or that the
// owner's roster has a Group, chat, or link grant on. A thread dohc can't tie
// to one shared channel, such as a Comment, counts when the workspace has any
// grant, because a file share carries the Comments on its files. A roster
// dohc can't read counts as shared.
export function chatSharedWithOthers(
  channelWireId: string | null,
  joinedChannelWireIds: readonly string[],
  roster: ReachRoster,
): boolean {
  if (channelWireId !== null && joinedChannelWireIds.includes(channelWireId)) return true;
  if (roster.kind !== "owner") return true;
  return channelWireId === null
    ? roster.grants.length > 0
    : roster.grants.some((grant) => grant.channel?.wireId === channelWireId);
}
