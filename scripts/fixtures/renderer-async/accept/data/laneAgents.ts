import type { ReadDesktop } from "../desktopOperations";
type Spoke = readonly { readonly id: string; readonly atMs: number }[];
export type LaneCache = { readonly [channelId: string]: { readonly updatedAtMs: number; readonly spoke: Spoke } };
export async function readLaneAgents(desktop: ReadDesktop, input: { workspaceId: string; channelIds: readonly string[] }, cached: LaneCache) {
  const updates: { [channelId: string]: { updatedAtMs: number; spoke: Spoke } } = {};
  const agents = await Promise.all(input.channelIds.map(async (channelId) => {
    const listed = await desktop.listChannelThreads({ workspaceId: input.workspaceId, channelId, lane: "chat" });
    const lane = [...listed.threads].sort((a: any, b: any) => a.createdAtMs - b.createdAtMs)[0];
    if (!lane) return [];
    const hit = cached[channelId];
    if (hit && hit.updatedAtMs === lane.updatedAtMs) return hit.spoke;
    const page = await desktop.listChatMessages({ workspaceId: input.workspaceId, threadId: lane.id });
    const spoke = page.messages.filter((m: any) => m.authorKind === "agent").map((m: any) => ({ id: m.authorUserId ?? m.authorDisplayName, atMs: m.createdAtMs }));
    updates[channelId] = { updatedAtMs: lane.updatedAtMs, spoke };
    return spoke;
  }));
  return { agents: agents.flat(), updates };
}
