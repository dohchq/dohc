import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import {
  ListChatChannelSharesResult,
  MAX_CHAT_CHANNEL_SHARE_ROWS,
} from "./ipc/bridgeContract";
import { markPersonalFeedSeenReadOnlySafe } from "./workspaces/chatFollowAccess";
import {
  chatShareSessionKey,
  chatViewerAuthorId,
  handleRelayUnauthorized,
  createChatChannelIpcHandler,
  createReadAwareChatIpcHandler,
  createSharedChannelWritableChatIpcHandler,
  createSetChatReactionIpcHandler,
  reactionsForViewer,
  readRelayChatShareLanes,
  RelaySessionError,
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

// #551: a relay outage must resolve as "unreachable", never as an empty
// listing — an empty listing is an authoritative "there are no shares" and
// clobbers whatever the renderer has cached. A missing or rejected session is
// the third fact: "signed-out", which must CLEAR cached account-scoped rows
// rather than preserve them across a logout or account switch.
describe("readRelayChatShareLanes", () => {
  it("reports a transport failure as unreachable, never as an empty listing", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.reject(new Error("relay down")),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes).toEqual({ state: "unreachable" });
  });

  it("reports a session failure as signed-out, not as a transport outage", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.reject(
          new RelaySessionError(
            "Your dohc Cloud session expired. Sign in again, then retry.",
          ),
        ),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes).toEqual({ state: "signed-out" });
  });

  it("answers an authoritative empty listing when the relay has no rows", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({}),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes).toEqual({ state: "answered", granted: [], received: [] });
  });

  it("maps chat-channel rows and scopes grants to this workspace's remote identity", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "remote-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: {
                kind: "chat-channel",
                channelWireId: "wire-1",
                access: "read-only",
              },
            },
            // Managed by another workspace: not this listing's row.
            {
              shareId: "share-elsewhere",
              workspaceId: "remote-2",
              recipientEmail: "bo@example.com",
              revokedAtMs: null,
              selector: { kind: "chat-channel", channelWireId: "wire-2" },
            },
            // Not a chat-channel share.
            { shareId: "share-doc", workspaceId: "remote-1", selector: { kind: "document" } },
          ],
          received: [
            {
              shareId: "share-in",
              granterEmail: "owner@example.com",
              selector: { kind: "chat-channel", channelWireId: "wire-in" },
            },
            { shareId: "share-other", selector: { kind: "document" } },
          ],
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes).toEqual({
      state: "answered",
      granted: [
        {
          shareId: "share-mine",
          channelWireId: "wire-1",
          access: "read-only",
          recipientEmail: "ana@example.com",
          revokedAtMs: null,
        },
      ],
      received: [
        {
          shareId: "share-in",
          channelWireId: "wire-in",
          access: "read-write",
          granterEmail: "owner@example.com",
        },
      ],
    });
  });

  it("drops every grant when the workspace has no remote identity", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "remote-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat-channel", channelWireId: "wire-1" },
            },
          ],
        }),
      remoteWorkspaceId: null,
    });
    expect(lanes).toEqual({ state: "answered", granted: [], received: [] });
  });

  // The row cap is the one door row-level validation does not cover. Every row
  // below is structurally valid, so the guard used to answer "answered" and
  // hand the contract parse a lane it cannot represent: the parse throws, the
  // IPC call rejects, the renderer's .catch(() => null) commits a null
  // listing, and every cached invitation and grant disappears (#608).
  function relayRowsOverCap(lane: "granted" | "received") {
    const over = MAX_CHAT_CHANNEL_SHARE_ROWS + 1;
    const rows = Array.from({ length: over }, (_, index) => ({
      shareId: `share-${index}`,
      workspaceId: "remote-1",
      recipientEmail: "ana@example.com",
      granterEmail: "owner@example.com",
      revokedAtMs: null,
      selector: { kind: "chat-channel", channelWireId: `wire-${index}` },
    }));
    return { [lane]: rows };
  }

  for (const lane of ["granted", "received"] as const) {
    it(`reports an over-cap ${lane} lane as over-limit, so cached rows survive and the surface can name it`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const lanes = await readRelayChatShareLanes({
          shareIdsClaimedElsewhere: new Set<string>(),
          fetchListing: () => Promise.resolve(relayRowsOverCap(lane)),
          remoteWorkspaceId: "remote-1",
        });
        // NOT "unreachable": that word means dohc could not read the answer,
        // and it earns a Try again. This answer arrived and will arrive again
        // identically, so it carries what it observed and the limit instead,
        // and the surface names the constraint rather than posing as an
        // outage (#618 codex).
        expect(lanes).toEqual({
          state: "over-limit",
          lanes: [{ lane, rows: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }],
          limit: MAX_CHAT_CHANNEL_SHARE_ROWS,
        });
        // The log refusal still names the constraint, the limit, the unit, and
        // what it observed, because nobody reads this path except through it.
        expect(warn).toHaveBeenCalledWith(
          `[desktop] relay share listing "${lane}" holds ${
            MAX_CHAT_CHANNEL_SHARE_ROWS + 1
          } rows; the cap is ${MAX_CHAT_CHANNEL_SHARE_ROWS} rows per lane. Reporting the listing over-limit, so cached rows survive and the surface can name the constraint.`,
        );
        // The composition is the defect: the guard's answer must survive the
        // contract parse the IPC handler runs immediately after it. This is
        // the parse that used to throw.
        expect(() =>
          ListChatChannelSharesResult.parse({
            joined: [],
            sessionKey: "https://relay.example|user-1",
            relay: lanes,
          }),
        ).not.toThrow();
      } finally {
        warn.mockRestore();
      }
    });
  }

  // Naming one of two over-cap lanes sends the reader to fix half the problem.
  it("names every over-cap lane, not the first one it meets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lanes = await readRelayChatShareLanes({
        shareIdsClaimedElsewhere: new Set<string>(),
        fetchListing: () =>
          Promise.resolve({
            ...relayRowsOverCap("granted"),
            ...relayRowsOverCap("received"),
          }),
        remoteWorkspaceId: "remote-1",
      });
      expect(lanes).toEqual({
        state: "over-limit",
        lanes: [
          { lane: "granted", rows: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
          { lane: "received", rows: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
        ],
        limit: MAX_CHAT_CHANNEL_SHARE_ROWS,
      });
      expect(warn).toHaveBeenCalledWith(
        `[desktop] relay share listing "granted" holds ${
          MAX_CHAT_CHANNEL_SHARE_ROWS + 1
        } rows, "received" holds ${
          MAX_CHAT_CHANNEL_SHARE_ROWS + 1
        } rows; the cap is ${MAX_CHAT_CHANNEL_SHARE_ROWS} rows per lane. Reporting the listing over-limit, so cached rows survive and the surface can name the constraint.`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The cap must not reject a listing that fits. A lane exactly at the cap is
  // healthy work and stays authoritative.
  it("answers a lane that sits exactly at the cap", async () => {
    const rows = Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS }, (_, index) => ({
      shareId: `share-${index}`,
      workspaceId: "remote-1",
      recipientEmail: "ana@example.com",
      revokedAtMs: null,
      selector: { kind: "chat-channel", channelWireId: `wire-${index}` },
    }));
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({ granted: rows }),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes.state).toBe("answered");
    expect(lanes.state === "answered" && lanes.granted).toHaveLength(
      MAX_CHAT_CHANNEL_SHARE_ROWS,
    );
    expect(() =>
      ListChatChannelSharesResult.parse({
        joined: [],
        sessionKey: "https://relay.example|user-1",
        relay: lanes,
      }),
    ).not.toThrow();
  });

  // Filtering runs before the cap: an oversized body whose chat-channel rows
  // fit is a listing dohc CAN represent, and treating it as unreachable would
  // hide real shares behind rows that were never going to be listed.
  it("counts what it will list, not what the relay sent", async () => {
    const listed = Array.from({ length: 10 }, (_, index) => ({
      shareId: `share-${index}`,
      workspaceId: "remote-1",
      recipientEmail: "ana@example.com",
      revokedAtMs: null,
      selector: { kind: "chat-channel", channelWireId: `wire-${index}` },
    }));
    const filteredOut = Array.from(
      { length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
      (_, index) => ({
        shareId: `doc-${index}`,
        workspaceId: "remote-1",
        selector: { kind: "document" },
      }),
    );
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({ granted: [...listed, ...filteredOut] }),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes.state).toBe("answered");
    expect(lanes.state === "answered" && lanes.granted).toHaveLength(10);
  });

  // A received grant is ACCOUNT-wide: the relay answers the same rows in every
  // workspace. Scoping them to the workspace that claimed them is what keeps
  // one workspace's sharing surface independent of another's (#618).
  it("drops received shares another local workspace already claimed", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(["share-in-work"]),
      fetchListing: () =>
        Promise.resolve({
          received: [
            {
              shareId: "share-in-work",
              granterEmail: "owner@example.com",
              selector: { kind: "chat-channel", channelWireId: "wire-work" },
            },
            {
              shareId: "share-unclaimed",
              granterEmail: "owner@example.com",
              selector: { kind: "chat-channel", channelWireId: "wire-free" },
            },
          ],
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes.state === "answered" && lanes.received).toEqual([
      {
        shareId: "share-unclaimed",
        channelWireId: "wire-free",
        access: "read-write",
        granterEmail: "owner@example.com",
      },
    ]);
  });

  // The acceptance case for #618: another workspace's received lane being
  // unreadable must not blank a workspace that has shares of its own. The
  // scoping runs BEFORE the cap, so the rows homed elsewhere never count
  // against this workspace's lane.
  it("still answers this workspace's shares when the rows claimed elsewhere would blow the cap", async () => {
    const claimedElsewhere = Array.from(
      { length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
      (_, index) => ({
        shareId: `share-other-${index}`,
        granterEmail: "owner@example.com",
        selector: { kind: "chat-channel", channelWireId: `wire-other-${index}` },
      }),
    );
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(claimedElsewhere.map((row) => row.shareId)),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "remote-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat-channel", channelWireId: "wire-mine" },
            },
          ],
          received: [
            ...claimedElsewhere,
            {
              shareId: "share-here",
              granterEmail: "owner@example.com",
              selector: { kind: "chat-channel", channelWireId: "wire-here" },
            },
          ],
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes.state).toBe("answered");
    expect(lanes.state === "answered" && lanes.granted).toHaveLength(1);
    expect(lanes.state === "answered" && lanes.received.map((row) => row.shareId)).toEqual([
      "share-here",
    ]);
  });
});

// The session key scopes the renderer's cached relay rows to one account, so
// preservation through an outage can never keep another account's rows.
describe("chatShareSessionKey", () => {
  it("answers null without a session", () => {
    expect(chatShareSessionKey(null)).toBeNull();
  });

  it("is stable across token rotation and URL trailing slashes", () => {
    const key = chatShareSessionKey({
      serverUrl: "https://cloud.dohc.test",
      relayUrl: "https://relay.dohc.test",
      userId: "user-1",
    });
    expect(key).not.toBeNull();
    expect(
      chatShareSessionKey({
        serverUrl: "https://cloud.dohc.test/",
        relayUrl: "https://relay.dohc.test/",
        userId: "user-1",
      }),
    ).toBe(key);
  });

  it("differs across users, servers, and relays", () => {
    const key = chatShareSessionKey({
      serverUrl: "https://cloud.dohc.test",
      relayUrl: "https://relay.dohc.test",
      userId: "user-1",
    });
    expect(
      chatShareSessionKey({
        serverUrl: "https://cloud.dohc.test",
        relayUrl: "https://relay.dohc.test",
        userId: "user-2",
      }),
    ).not.toBe(key);
    expect(
      chatShareSessionKey({
        serverUrl: "https://other.dohc.test",
        relayUrl: "https://relay.dohc.test",
        userId: "user-1",
      }),
    ).not.toBe(key);
    // The same account on ANOTHER relay has different rows: its cache must
    // not carry over — including from a session with no relay configured.
    expect(
      chatShareSessionKey({
        serverUrl: "https://cloud.dohc.test",
        relayUrl: "https://relay-b.dohc.test",
        userId: "user-1",
      }),
    ).not.toBe(key);
    expect(
      chatShareSessionKey({ serverUrl: "https://cloud.dohc.test", userId: "user-1" }),
    ).not.toBe(key);
  });
});

// A relay 401 acts if and only if it belongs to the CURRENT credentials, and
// then it acts completely: memory, broadcast, persistent store — in that
// order, so views re-scope immediately and a restart cannot read the dead
// token back into a false connected state.
describe("handleRelayUnauthorized", () => {
  const sessionA = {
    serverUrl: "https://cloud.dohc.test",
    userId: "user-1",
    token: "token-a",
  };
  const sessionB = {
    serverUrl: "https://cloud.dohc.test",
    userId: "user-2",
    token: "token-b",
  };

  it("leaves the adopted session intact when a stale request's token 401s", async () => {
    const steps: string[] = [];
    const acted = await handleRelayUnauthorized({
      // The request went out under A; the user has since adopted B.
      requestCredentials: sessionA,
      currentCredentials: sessionB,
      clearCachedCredentials: () => steps.push("clear"),
      notifySessionChanging: () => steps.push("notify changing"),
      notifyCloudSessionChanged: () => steps.push("notify ready"),
      invalidatePersistedSessionIf: async () => {
        steps.push("invalidate store");
      },
    });
    expect(acted).toBe(false);
    expect(steps).toEqual([]);
  });

  it("acts completely and in order for a current-session 401", async () => {
    const steps: string[] = [];
    const expectedHandedToStore: unknown[] = [];
    const acted = await handleRelayUnauthorized({
      requestCredentials: sessionA,
      currentCredentials: sessionA,
      clearCachedCredentials: () => steps.push("clear"),
      notifySessionChanging: () => steps.push("notify changing"),
      notifyCloudSessionChanged: () => steps.push("notify ready"),
      invalidatePersistedSessionIf: async (expected) => {
        expectedHandedToStore.push(expected);
        steps.push("invalidate store");
      },
    });
    expect(acted).toBe(true);
    // The second notify is the FINAL state, after the store settled: a
    // status read raced by the first broadcast can have seen the expired
    // on-disk session and reported connected.
    expect(steps).toEqual([
      "clear",
      "notify changing",
      "invalidate store",
      "notify ready",
    ]);
    // The store does its own compare-and-clear atomically, against the
    // request identity — never an unconditional clear.
    expect(expectedHandedToStore).toEqual([sessionA]);
  });

  it("does not act on a rotated token of the same account", async () => {
    const steps: string[] = [];
    const acted = await handleRelayUnauthorized({
      requestCredentials: sessionA,
      currentCredentials: { ...sessionA, token: "token-a-rotated" },
      clearCachedCredentials: () => steps.push("clear"),
      notifySessionChanging: () => steps.push("notify changing"),
      notifyCloudSessionChanged: () => steps.push("notify ready"),
      invalidatePersistedSessionIf: async () => {
        steps.push("invalidate store");
      },
    });
    expect(acted).toBe(false);
    expect(steps).toEqual([]);
  });

  it("keeps the session error and still broadcasts when the store step fails", async () => {
    const steps: string[] = [];
    const acted = await handleRelayUnauthorized({
      requestCredentials: sessionA,
      currentCredentials: sessionA,
      clearCachedCredentials: () => steps.push("clear"),
      notifySessionChanging: () => steps.push("notify changing"),
      notifyCloudSessionChanged: () => steps.push("notify ready"),
      invalidatePersistedSessionIf: async () => {
        throw new Error("store unavailable");
      },
    });
    expect(acted).toBe(true);
    expect(steps).toEqual(["clear", "notify changing", "notify ready"]);
  });
});

// The catch classification: signed-out is authoritative only when the relay
// rejected the CURRENT credentials. A stale token's 401 — a listing still in
// flight across a same-account rotation — says nothing about the current
// session and must not clear cached rows.
describe("readRelayChatShareLanes session classification", () => {
  it("reports a stale session's 401 as unreachable, not signed-out", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.reject(
          new RelaySessionError("Your dohc Cloud session expired.", {
            sessionWasCurrent: false,
          }),
        ),
      remoteWorkspaceId: "remote-1",
    });
    expect(lanes).toEqual({ state: "unreachable" });
  });

  // A 200 with a malformed body is not an authoritative answer either: a
  // thrown mapping would reject the IPC call, which the renderer reads as an
  // unknown listing and clears — the exact clobber this contract prevents.
  it("reports a malformed 200 body as unreachable, not as a rejection", async () => {
    const nullBody = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve(null as unknown as { granted?: Array<Record<string, unknown>> }),
      remoteWorkspaceId: "remote-1",
    });
    expect(nullBody).toEqual({ state: "unreachable" });

    const nonArray = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ granted: 3 } as unknown as {
          granted?: Array<Record<string, unknown>>;
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(nonArray).toEqual({ state: "unreachable" });

    // The ITERABLE non-array: a string lane iterates per character, every
    // character filters out, and the result would read as an authoritative
    // EMPTY answer — clearing rows out of garbage.
    const stringLane = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ granted: "malformed" } as unknown as {
          granted?: Array<Record<string, unknown>>;
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(stringLane).toEqual({ state: "unreachable" });

    const stringReceived = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ received: "malformed" } as unknown as {
          received?: Array<Record<string, unknown>>;
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(stringReceived).toEqual({ state: "unreachable" });
  });

  // Row-LEVEL validation lives inside the same guard: a 200 whose entries
  // map cleanly but carry an invalid field would otherwise escape to the
  // contract parse and reject the IPC call — the same clear-by-rejection.
  it("reports invalid row fields as unreachable, not as a rejection", async () => {
    // A chat-channel grant with no shareId at all.
    const missingShareId = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              workspaceId: "remote-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat-channel", channelWireId: "wire-1" },
            },
          ],
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(missingShareId).toEqual({ state: "unreachable" });

    // A received row whose granterEmail is not an email or null.
    const badEmail = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          received: [
            {
              shareId: "share-in",
              granterEmail: 42,
              selector: { kind: "chat-channel", channelWireId: "wire-in" },
            },
          ],
        }),
      remoteWorkspaceId: "remote-1",
    });
    expect(badEmail).toEqual({ state: "unreachable" });
  });
});
