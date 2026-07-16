import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import { markPersonalFeedSeenReadOnlySafe } from "./workspaces/chatFollowAccess";
import {
  createChatChannelIpcHandler,
  createReadAwareChatIpcHandler,
  createSetChatReactionIpcHandler,
  type MainChatIpcHandler,
} from "./mainChatIpcHandlers";

interface TestEvent {
  trusted: boolean;
}

interface TestContext {
  workspace: { workspaceId: string; readOnly: boolean };
}

type RegisteredHandler = MainChatIpcHandler<TestEvent, unknown>;

function runtimeHarness() {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handle(channel: string, handler: RegisteredHandler) {
      handlers.set(channel, handler);
    },
    invoke(channel: string, payload: unknown, event: TestEvent = { trusted: true }) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No runtime handler registered for ${channel}.`);
      return handler(event, payload);
    },
  };
}

function boundaryDeps(contexts: Map<string, TestContext>) {
  return {
    assertTrustedSender(event: TestEvent) {
      if (!event.trusted) throw new Error("Untrusted renderer.");
    },
    parsePayload(payload: unknown) {
      const parsed = payload as { workspaceId?: unknown };
      if (typeof parsed?.workspaceId !== "string") throw new Error("Invalid payload.");
      return { workspaceId: parsed.workspaceId };
    },
    async requireContext(workspaceId: string) {
      const context = contexts.get(workspaceId);
      if (!context) throw new Error("Workspace not found.");
      return context;
    },
    assertWritableWorkspace(workspace: TestContext["workspace"]) {
      if (workspace.readOnly) throw new Error("This is a shared view — it is read-only.");
    },
  };
}

describe("runtime main chat IPC boundaries", () => {
  it("rejects mutations and keeps read-shaped writes as no-ops in a read-only workspace", async () => {
    const workspaceId = "shared-view";
    const contexts = new Map<string, TestContext>([
      [workspaceId, { workspace: { workspaceId, readOnly: true } }],
    ]);
    const deps = boundaryDeps(contexts);
    const ipc = runtimeHarness();
    const create = vi.fn(async () => ({ channelId: "channel-1" }));
    const react = vi.fn(async () => ({ reactionId: "reaction-1" }));
    const mark = vi.fn(async () => undefined);
    const reconcileDms = vi.fn(async () => undefined);
    const listDms = vi.fn(async () => [] as string[]);
    const joinedSync = vi.fn();
    const cloudSync = vi.fn();

    ipc.handle(
      CHANNELS.createChatChannel,
      createChatChannelIpcHandler({
        ...deps,
        run: create,
        queueCloudSync: cloudSync,
      }),
    );
    ipc.handle(
      CHANNELS.setChatReaction,
      createSetChatReactionIpcHandler({
        ...deps,
        run: react,
        syncJoinedChannels: joinedSync,
        queueCloudSync: cloudSync,
      }),
    );
    ipc.handle(
      CHANNELS.markPersonalChatFeedSeen,
      createReadAwareChatIpcHandler({
        assertTrustedSender: deps.assertTrustedSender,
        parsePayload: deps.parsePayload,
        requireContext: deps.requireContext,
        isReadOnly: (workspace) => workspace.readOnly,
        run: async (_context, _payload, readOnly) =>
          markPersonalFeedSeenReadOnlySafe({ readOnly, mark }),
      }),
    );
    ipc.handle(
      CHANNELS.syncDms,
      createReadAwareChatIpcHandler({
        assertTrustedSender: deps.assertTrustedSender,
        parsePayload: deps.parsePayload,
        requireContext: deps.requireContext,
        isReadOnly: (workspace) => workspace.readOnly,
        run: async (_context, _payload, readOnly) => {
          if (!readOnly) await reconcileDms();
          return listDms();
        },
      }),
    );

    await expect(ipc.invoke(CHANNELS.createChatChannel, { workspaceId })).rejects.toThrow(
      /read-only/u,
    );
    await expect(ipc.invoke(CHANNELS.setChatReaction, { workspaceId })).rejects.toThrow(
      /read-only/u,
    );
    await expect(
      ipc.invoke(CHANNELS.markPersonalChatFeedSeen, { workspaceId }),
    ).resolves.toBeUndefined();
    await expect(ipc.invoke(CHANNELS.syncDms, { workspaceId })).resolves.toEqual([]);

    expect(create).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(reconcileDms).not.toHaveBeenCalled();
    expect(listDms).toHaveBeenCalledOnce();
    expect(joinedSync).not.toHaveBeenCalled();
    expect(cloudSync).not.toHaveBeenCalled();
  });

  it("queues cloud sync after channel creation and both sync lanes after a reaction write", async () => {
    const workspaceId = "owned-workspace";
    const contexts = new Map<string, TestContext>([
      [workspaceId, { workspace: { workspaceId, readOnly: false } }],
    ]);
    const deps = boundaryDeps(contexts);
    const ipc = runtimeHarness();
    const events: string[] = [];

    ipc.handle(
      CHANNELS.createChatChannel,
      createChatChannelIpcHandler({
        ...deps,
        run: async () => {
          events.push("channel-write");
          return { channelId: "channel-1" };
        },
        queueCloudSync: (id) => events.push(`cloud:${id}`),
      }),
    );
    ipc.handle(
      CHANNELS.setChatReaction,
      createSetChatReactionIpcHandler({
        ...deps,
        run: async () => {
          events.push("reaction-write");
          return { reactionId: "reaction-1" };
        },
        syncJoinedChannels: (id) => events.push(`joined:${id}`),
        queueCloudSync: (id) => events.push(`cloud:${id}`),
      }),
    );

    await ipc.invoke(CHANNELS.createChatChannel, { workspaceId });
    expect(events).toEqual(["channel-write", `cloud:${workspaceId}`]);
    events.length = 0;

    await ipc.invoke(CHANNELS.setChatReaction, { workspaceId });
    expect(events).toEqual([
      "reaction-write",
      `joined:${workspaceId}`,
      `cloud:${workspaceId}`,
    ]);
  });
});
