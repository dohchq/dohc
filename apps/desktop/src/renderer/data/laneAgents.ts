import type { ReadDesktop } from "../desktopOperations";

export type LaneCache = Record<string, { updatedAtMs: number | null; spoke: Array<{ id: string; authorKind: "agent"; authorDisplayName: string; atMs: number }> }>;

export async function readLaneAgents(desktop: ReadDesktop, input: { workspaceId: string; channelIds: readonly string[] }, cached: LaneCache) {
  const updates: LaneCache = {};
  const results = await Promise.allSettled(input.channelIds.map(async channelId => {
    const listed = await desktop.listChannelThreads({ workspaceId: input.workspaceId, channelId, lane: "chat" });
    const lane = [...listed.threads].sort((left, right) => left.createdAtMs - right.createdAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
    if (!lane) { updates[channelId] = { updatedAtMs: null, spoke: [] }; return []; }
    const hit = cached[channelId];
    let spoke = hit?.updatedAtMs === lane.updatedAtMs ? hit.spoke : undefined;
    if (!spoke) {
      const page = await desktop.listChatMessages({ workspaceId: input.workspaceId, threadId: lane.id });
      spoke = page.messages.filter(message => message.authorKind === "agent").map(message => ({
        id: message.authorUserId ?? message.authorDisplayName, authorKind: "agent" as const, authorDisplayName: message.authorDisplayName, atMs: message.createdAtMs,
      }));
      updates[channelId] = { updatedAtMs: lane.updatedAtMs, spoke };
    }
    return spoke.map(who => ({ ...who, channelId }));
  }));
  return { agents: results.flatMap((result, index) => result.status === "fulfilled" ? result.value
    : (cached[input.channelIds[index]!]?.spoke ?? []).map(who => ({ ...who, channelId: input.channelIds[index]! }))), updates };
}
