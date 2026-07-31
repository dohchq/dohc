import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import { markPersonalFeedSeenReadOnlySafe } from "./workspaces/chatFollowAccess";
import {
  chatViewerAuthorId,
  createChatChannelIpcHandler,
  createReadAwareChatIpcHandler,
  createSharedChannelWritableChatIpcHandler,
  createSetChatReactionIpcHandler,
  reactionsForViewer,
  awaitCredentialGeneration,
  setChatReactionFromMain,
  writeChatMessageFromMain,
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
  it("rejects an identity resolved across a credential-generation change", async () => {
    let resolveIdentity!: (value: { authorUserId: string }) => void;
    const pendingIdentity = new Promise<{ authorUserId: string }>((resolve) => {
      resolveIdentity = resolve;
    });
    let generation = 1;
    const resolving = awaitCredentialGeneration({
      capturedGeneration: generation,
      currentGeneration: () => generation,
      run: () => pendingIdentity,
    });

    generation += 1;
    resolveIdentity({ authorUserId: "old-user-id" });

    await expect(resolving).rejects.toThrow(
      "Your dohc Cloud session changed. Try again.",
    );
  });

  it("passes the authenticated relay identity into the reaction mutation", async () => {
    const setReaction = vi.fn(async () => ({ reactionId: "reaction-1" }));

    await expect(
      setChatReactionFromMain({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        messageId: "message-1",
        emoji: "👍",
        state: "added",
        localFallbackAuthorId: "local-user-id",
        localAuthorDisplayName: "Ice",
        resolveReplicationAuthorId: async () => "verified-user-id",
        revalidateReplicationAuthorId: async () => undefined,
        setReaction,
      }),
    ).resolves.toEqual({ reactionId: "reaction-1" });
    expect(setReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        author: expect.objectContaining({ authorId: "verified-user-id" }),
        replicationAuthorId: "verified-user-id",
      }),
    );
  });

  it("keeps a signed-out reaction local and omits the replication author", async () => {
    const setReaction = vi.fn(
      async (mutation: {
        author: { authorId: string };
        replicationAuthorId?: string;
      }) => ({ reactionId: "reaction-1", mutation }),
    );

    await setChatReactionFromMain({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      messageId: "message-1",
      emoji: "👍",
      state: "added",
      localFallbackAuthorId: "local-user-id",
      localAuthorDisplayName: "Ice",
      resolveReplicationAuthorId: async () => undefined,
      revalidateReplicationAuthorId: async () => undefined,
      setReaction,
    });

    const mutation = setReaction.mock.calls[0]![0];
    expect(mutation.author.authorId).toBe("local-user-id");
    expect(mutation).not.toHaveProperty("replicationAuthorId");
  });

  it("uses the same signed-in or local reaction identity for reaction reads", async () => {
    await expect(
      chatViewerAuthorId({
        localFallbackAuthorId: "local-user-id",
        resolveReplicationAuthorId: async () => "verified-user-id",
      }),
    ).resolves.toBe("verified-user-id");
    await expect(
      chatViewerAuthorId({
        localFallbackAuthorId: "local-user-id",
        resolveReplicationAuthorId: async () => undefined,
      }),
    ).resolves.toBe("local-user-id");
  });

  it("keeps signed-out reaction cells reversible after sign-in", async () => {
    expect(
      reactionsForViewer(
        [
          {
            reactionId: "local",
            threadId: "thread-1",
            messageId: "message-1",
            emoji: "👍",
            authorId: "local-user-id",
          },
          {
            reactionId: "verified",
            threadId: "thread-1",
            messageId: "message-1",
            emoji: "👍",
            authorId: "verified-user-id",
          },
        ],
        {
          viewerAuthorId: "verified-user-id",
          localFallbackAuthorId: "local-user-id",
        },
      ),
    ).toEqual([
      {
        reactionId: "verified",
        threadId: "thread-1",
        messageId: "message-1",
        emoji: "👍",
        authorId: "verified-user-id",
      },
    ]);

    const setReaction = vi.fn(
      async (mutation: {
        author: { authorId: string };
        replicationAuthorId?: string;
      }) => ({ reactionId: "reaction-1", mutation }),
    );
    await setChatReactionFromMain({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      messageId: "message-1",
      emoji: "👍",
      state: "removed",
      localFallbackAuthorId: "local-user-id",
      localAuthorDisplayName: "Ice",
      resolveReplicationAuthorId: async () => "verified-user-id",
      revalidateReplicationAuthorId: async () => undefined,
      listReactions: async () => [
        {
          messageId: "message-1",
          emoji: "👍",
          author: { authorId: "local-user-id" },
        },
      ],
      setReaction,
    });

    expect(setReaction).toHaveBeenCalledOnce();
    expect(setReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        author: expect.objectContaining({ authorId: "local-user-id" }),
        state: "removed",
      }),
    );
    expect(setReaction.mock.calls[0]![0]).not.toHaveProperty(
      "replicationAuthorId",
    );
  });

  it("checks message identity before attachments and passes one captured author to the writer", async () => {
    const resolveAttachments = vi.fn(async () => ["attachment-1"]);
    const revalidateAuthorUserId = vi.fn(async () => undefined);
    const write = vi.fn(async () => ({ messageId: "message-1" }));

    await expect(
      writeChatMessageFromMain({
        resolveAuthorUserId: async () => {
          throw new Error(
            "Sign in to dohc Cloud to send a message in this shared channel.",
          );
        },
        resolveAttachments,
        revalidateAuthorUserId,
        write,
      }),
    ).rejects.toThrow(/Sign in to dohc Cloud/u);
    expect(resolveAttachments).not.toHaveBeenCalled();
    expect(revalidateAuthorUserId).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    await expect(
      writeChatMessageFromMain({
        resolveAuthorUserId: async () => "verified-user-id",
        resolveAttachments,
        revalidateAuthorUserId,
        write,
      }),
    ).resolves.toEqual({ messageId: "message-1" });
    expect(revalidateAuthorUserId).toHaveBeenCalledWith("verified-user-id");
    expect(write).toHaveBeenCalledWith({
      authorUserId: "verified-user-id",
      attachments: ["attachment-1"],
    });
  });

  it("revalidates access after attachments and before the message write", async () => {
    const events: string[] = [];
    const write = vi.fn(async () => ({ messageId: "message-1" }));

    await expect(
      writeChatMessageFromMain({
        resolveAuthorUserId: async () => {
          events.push("identity");
          return "verified-user-id";
        },
        resolveAttachments: async () => {
          events.push("attachments");
          return ["attachment-1"];
        },
        revalidateAuthorUserId: async (authorUserId) => {
          events.push(`revalidate:${authorUserId}`);
          throw new Error("This shared channel is read-only.");
        },
        write,
      }),
    ).rejects.toThrow("This shared channel is read-only.");

    expect(events).toEqual([
      "identity",
      "attachments",
      "revalidate:verified-user-id",
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("revalidates the reaction author before the mutation", async () => {
    const setReaction = vi.fn(async () => ({ reactionId: "reaction-1" }));
    const revalidateReplicationAuthorId = vi.fn(async () => {
      throw new Error("Your dohc Cloud session changed. Try again.");
    });

    await expect(
      setChatReactionFromMain({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        messageId: "message-1",
        emoji: "👍",
        state: "added",
        localFallbackAuthorId: "local-user-id",
        localAuthorDisplayName: "Ice",
        resolveReplicationAuthorId: async () => "verified-user-id",
        revalidateReplicationAuthorId,
        setReaction,
      }),
    ).rejects.toThrow("Your dohc Cloud session changed. Try again.");

    expect(revalidateReplicationAuthorId).toHaveBeenCalledWith(
      "verified-user-id",
    );
    expect(setReaction).not.toHaveBeenCalled();
  });

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

  it("rejects a read-cursor write before mutation when its joined channel is locked", async () => {
    interface MarkThreadReadPayload {
      workspaceId: string;
      threadId: string;
      upToSequence: number;
    }
    const workspaceId = "joined-workspace";
    const contexts = new Map<string, TestContext>([
      [workspaceId, { workspace: { workspaceId, readOnly: false } }],
    ]);
    const deps = boundaryDeps(contexts);
    const ipc = runtimeHarness();
    const markThreadRead = vi.fn(
      async (_context: TestContext, _payload: MarkThreadReadPayload) => ({
        lastReadSequence: 4,
        revision: 2,
      }),
    );
    const assertJoinedChannelWritable = vi.fn(
      async (_context: TestContext, payload: MarkThreadReadPayload) => {
        if (payload.threadId === "thread-locked") {
          throw new Error("This shared channel is read-only.");
        }
      },
    );

    ipc.handle(
      CHANNELS.markChatThreadRead,
      createSharedChannelWritableChatIpcHandler({
        assertTrustedSender: deps.assertTrustedSender,
        parsePayload: (payload): MarkThreadReadPayload => {
          const parsed = payload as {
            workspaceId?: unknown;
            threadId?: unknown;
            upToSequence?: unknown;
          };
          if (
            typeof parsed.workspaceId !== "string" ||
            typeof parsed.threadId !== "string" ||
            typeof parsed.upToSequence !== "number"
          ) {
            throw new Error("Invalid payload.");
          }
          return {
            workspaceId: parsed.workspaceId,
            threadId: parsed.threadId,
            upToSequence: parsed.upToSequence,
          };
        },
        requireContext: deps.requireContext,
        assertWritableWorkspace: deps.assertWritableWorkspace,
        assertSharedChannelWritable: assertJoinedChannelWritable,
        run: markThreadRead,
      }),
    );

    await expect(
      ipc.invoke(CHANNELS.markChatThreadRead, {
        workspaceId,
        threadId: "thread-locked",
        upToSequence: 4,
      }),
    ).rejects.toThrow(/read-only/u);
    expect(markThreadRead).not.toHaveBeenCalled();

    await expect(
      ipc.invoke(CHANNELS.markChatThreadRead, {
        workspaceId,
        threadId: "thread-writable",
        upToSequence: 4,
      }),
    ).resolves.toEqual({ lastReadSequence: 4, revision: 2 });
    expect(assertJoinedChannelWritable).toHaveBeenLastCalledWith(
      contexts.get(workspaceId),
      expect.objectContaining({ threadId: "thread-writable" }),
    );
    expect(markThreadRead).toHaveBeenCalledOnce();
  });
});
