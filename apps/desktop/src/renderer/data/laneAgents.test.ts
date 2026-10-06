import { describe, expect, it, vi } from "vitest";
import type { ReadDesktop } from "../desktopOperations";
import { readLaneAgents, type LaneCache } from "./laneAgents";

const known = { id: "known", authorKind: "agent" as const, authorDisplayName: "Known agent", atMs: 10 };

describe("lane agent cache", () => {
  it.each(["threads", "messages"])("keeps a failed %s channel while updating successful channels", async failure => {
    const cached: LaneCache = { failed: { updatedAtMs: 10, spoke: [known] } };
    const listChannelThreads = vi.fn(async ({ channelId }: { channelId: string }) => {
      if (channelId === "failed" && failure === "threads") throw new Error("offline");
      return { threads: [{ id: channelId, createdAtMs: 1, updatedAtMs: 11 }] };
    });
    const listChatMessages = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "failed") throw new Error("offline");
      return { messages: [{ authorKind: "agent", authorUserId: "fresh", authorDisplayName: "Fresh agent", createdAtMs: 11 }] };
    });
    const desktop = { listChannelThreads, listChatMessages } as unknown as ReadDesktop;
    const result = await readLaneAgents(desktop, { workspaceId: "w", channelIds: ["failed", "fresh"] }, cached);
    expect(result).toEqual({
      agents: [{ ...known, channelId: "failed" }, { id: "fresh", authorKind: "agent", authorDisplayName: "Fresh agent", atMs: 11, channelId: "fresh" }],
      updates: { fresh: { updatedAtMs: 11, spoke: [{ id: "fresh", authorKind: "agent", authorDisplayName: "Fresh agent", atMs: 11 }] } },
    });
    expect(listChannelThreads.mock.calls.map(([input]) => input.channelId)).toEqual(["failed", "fresh"]);
    expect(listChatMessages.mock.calls.map(([input]) => input.threadId)).toEqual(failure === "threads" ? ["fresh"] : ["failed", "fresh"]);
    expect(cached).toEqual({ failed: { updatedAtMs: 10, spoke: [known] } });
  });

  it("a successful empty channel clears cached facts before another failure", async () => {
    const cached: LaneCache = { lane: { updatedAtMs: 10, spoke: [known] } };
    const listChannelThreads = vi.fn().mockResolvedValue({ threads: [] });
    const listChatMessages = vi.fn();
    const desktop = { listChannelThreads, listChatMessages } as unknown as ReadDesktop;
    const input = { workspaceId: "w", channelIds: ["lane"] };
    const empty = await readLaneAgents(desktop, input, cached);
    expect(empty).toEqual({ agents: [], updates: { lane: { updatedAtMs: null, spoke: [] } } });
    expect(listChannelThreads).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", channelId: "lane", lane: "chat" });
    expect(listChatMessages).not.toHaveBeenCalled();
    Object.assign(cached, empty.updates);
    listChannelThreads.mockRejectedValue(new Error("offline"));
    expect(await readLaneAgents(desktop, input, cached)).toEqual({ agents: [], updates: {} });
  });
});
