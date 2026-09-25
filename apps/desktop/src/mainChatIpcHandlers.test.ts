import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./ipc/channels";
import {
  ListChatChannelSharesResult,
  MAX_CHAT_CHANNEL_SHARE_ROWS,
} from "./ipc/bridgeContract";
import {
  chatShareSessionKey,
  chatViewerAuthorId,
  handleRelayUnauthorized,
  createChatChannelIpcHandler,
  createListJoinedSharedChannelsIpcHandler,
  createMarkChatThreadReadIpcHandler,
  reactionsForViewer,
  readRelayChatShareLanes,
  RelaySessionError,
  awaitCredentialGeneration,
  type MainChatIpcHandler,
} from "./mainChatIpcHandlers";
import { scopeJoinedChannels } from "./workspaces/sharedChannels";
import { createLastKnownDmRequestLanesCache } from "./workspaces/dmRequests";

interface TestEvent {
  trusted: boolean;
  activeWorkspaceId?: string;
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
    assertWritable(context: TestContext) {
      if (context.workspace.readOnly) {
        throw new Error("This is a shared view — it is read-only.");
      }
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
      "Your server session changed. Try again.",
    );
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

  it("shows a signed-out reaction cell as the signed-in viewer's", () => {
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
  });

  it("rejects channel creation in a read-only workspace", async () => {
    const workspaceId = "shared-view";
    const contexts = new Map<string, TestContext>([
      [workspaceId, { workspace: { workspaceId, readOnly: true } }],
    ]);
    const deps = boundaryDeps(contexts);
    const ipc = runtimeHarness();
    const create = vi.fn(async () => ({ channelId: "channel-1" }));
    const cloudSync = vi.fn();

    ipc.handle(
      CHANNELS.createChatChannel,
      createChatChannelIpcHandler({
        ...deps,
        run: create,
        queueCloudSync: cloudSync,
      }),
    );

    await expect(ipc.invoke(CHANNELS.createChatChannel, { workspaceId })).rejects.toThrow(
      /read-only/u,
    );
    expect(create).not.toHaveBeenCalled();
    expect(cloudSync).not.toHaveBeenCalled();
  });

  it("queues cloud sync after channel creation", async () => {
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

    await ipc.invoke(CHANNELS.createChatChannel, { workspaceId });
    expect(events).toEqual(["channel-write", `cloud:${workspaceId}`]);
  });

  it("updates reader-local state without a write boundary", async () => {
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
    const parsePayload = vi.fn((payload): MarkThreadReadPayload => {
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
    });
    const requireContext = vi.fn(deps.requireContext);
    ipc.handle(
      CHANNELS.markChatThreadRead,
      createMarkChatThreadReadIpcHandler({
        assertTrustedSender: deps.assertTrustedSender,
        parsePayload,
        requireContext,
        run: markThreadRead,
      }),
    );

    await expect(
      ipc.invoke(CHANNELS.markChatThreadRead, {
        workspaceId,
        threadId: "thread-view",
        upToSequence: 4,
      }),
    ).resolves.toEqual({ lastReadSequence: 4, revision: 2 });

    const validParseCount = parsePayload.mock.calls.length;
    await expect(
      ipc.invoke(
        CHANNELS.markChatThreadRead,
        { workspaceId, threadId: "thread-view", upToSequence: 4 },
        { trusted: false },
      ),
    ).rejects.toThrow("Untrusted renderer.");
    expect(parsePayload).toHaveBeenCalledTimes(validParseCount);
    expect(requireContext).toHaveBeenCalledTimes(1);
    await expect(
      ipc.invoke(CHANNELS.markChatThreadRead, { workspaceId }),
    ).rejects.toThrow("Invalid payload.");
    expect(requireContext).toHaveBeenCalledTimes(1);
    await expect(
      ipc.invoke(CHANNELS.markChatThreadRead, {
        workspaceId: "missing-workspace",
        threadId: "thread-view",
        upToSequence: 4,
      }),
    ).rejects.toThrow("Workspace not found.");
    expect(requireContext).toHaveBeenCalledTimes(2);
    expect(markThreadRead).toHaveBeenCalledTimes(1);
  });
});

// A relay outage must resolve as "unreachable", never as an empty
// listing — an empty listing is an authoritative "there are no shares" and
// clobbers whatever the renderer has cached. A missing or rejected session is
// the third fact: "signed-out", which must clear cached account-scoped rows
// rather than preserve them across a logout or account switch.
describe("readRelayChatShareLanes", () => {
  it("reports a transport failure as unreachable, never as an empty listing", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.reject(new Error("relay down")),
      workspaceId: "workspace-1",
    });
    expect(lanes).toEqual({ state: "unreachable" });
  });

  it("reports a session failure as signed-out, not as a transport outage", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.reject(
          new RelaySessionError(
            "Your server session expired. Sign in again, then retry.",
          ),
        ),
      workspaceId: "workspace-1",
    });
    expect(lanes).toEqual({ state: "signed-out" });
  });

  it("answers an authoritative empty listing when the relay has no rows", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({}),
      workspaceId: "workspace-1",
    });
    expect(lanes).toEqual({ state: "answered", granted: [], received: [] });
  });

  it("maps chat rows and scopes grants to this workspace coordinate", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: {
                kind: "chat",
                channelWireId: "wire-1",
              },
              access: "read-only",
              grantId: "grant-mine",
              generation: 1,
            },
            // Managed by another workspace: not this listing's row.
            {
              shareId: "share-elsewhere",
              workspaceId: "remote-2",
              recipientEmail: "bo@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-2" },
              access: "read-write",
            },
            // Not a chat share.
            { shareId: "share-doc", workspaceId: "workspace-1", selector: { kind: "document" } },
          ],
          received: [
            {
              shareId: "share-in",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-in" },
              access: "read-write",
            },
            // A group is an invitation to its channel; the folder follows.
            {
              shareId: "share-group",
              granterEmail: "owner@example.com",
              selector: { kind: "group", channelWireId: "wire-group", paths: ["team"], versionId: null },
              access: "read-only",
            },
            { shareId: "share-other", selector: { kind: "document" } },
          ],
        }),
      workspaceId: "workspace-1",
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
        {
          shareId: "share-group",
          channelWireId: "wire-group",
          access: "read-only",
          granterEmail: "owner@example.com",
        },
      ],
    });
  });

  it("reports a chat row with unreadable access as unreachable", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-corrupt",
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-corrupt" },
              access: "edit",
            },
          ],
        }),
      workspaceId: "workspace-1",
    });

    expect(lanes).toEqual({ state: "unreachable" });
  });

  it("excludes a cached DM share id from the ordinary received-channel lane", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(["share-dm"]),
      fetchListing: () =>
        Promise.resolve({
          received: [
            {
              shareId: "share-dm",
              granterEmail: "dm@example.com",
              selector: { kind: "chat", channelWireId: "wire-dm" },
              access: "read-write",
            },
            {
              shareId: "share-channel",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-channel" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: "workspace-1",
    });

    expect(lanes).toEqual({
      state: "answered",
      granted: [],
      received: [
        {
          shareId: "share-channel",
          channelWireId: "wire-channel",
          access: "read-write",
          granterEmail: "owner@example.com",
        },
      ],
    });
  });

  it("drops every grant when the workspace has no cloud binding", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-1" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: null,
    });
    expect(lanes).toEqual({ state: "answered", granted: [], received: [] });
  });

  // The row cap is the one door row-level validation does not cover. Every row
  // below is structurally valid, so the guard used to answer "answered" and
  // hand the contract parse a lane it cannot represent: the parse throws, the
  // IPC call rejects, the renderer's .catch(() => null) commits a null
  // listing, and every cached invitation and grant disappears.
  function relayRowsOverCap(lane: "granted" | "received") {
    const over = MAX_CHAT_CHANNEL_SHARE_ROWS + 1;
    const rows = Array.from({ length: over }, (_, index) => ({
      shareId: `share-${index}`,
      workspaceId: "workspace-1",
      recipientEmail: "ana@example.com",
      granterEmail: "owner@example.com",
      revokedAtMs: null,
      selector: { kind: "chat", channelWireId: `wire-${index}` },
      access: "read-write",
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
          workspaceId: "workspace-1",
        });
        // Not "unreachable": that word means dohc could not read the answer,
        // and it earns a Try again. This answer arrived and will arrive again
        // identically, so it carries what it observed and the limit instead,
        // and the surface names the constraint rather than posing as an
        // outage.
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
        workspaceId: "workspace-1",
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
      workspaceId: "workspace-1",
      recipientEmail: "ana@example.com",
      revokedAtMs: null,
      selector: { kind: "chat", channelWireId: `wire-${index}` },
      access: "read-write",
    }));
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({ granted: rows }),
      workspaceId: "workspace-1",
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

  // Filtering runs before the cap: an oversized body whose chat rows
  // fit is a listing dohc can represent, and treating it as unreachable would
  // hide real shares behind rows that were never going to be listed.
  it("counts what it will list, not what the relay sent", async () => {
    const listed = Array.from({ length: 10 }, (_, index) => ({
      shareId: `share-${index}`,
      workspaceId: "workspace-1",
      recipientEmail: "ana@example.com",
      revokedAtMs: null,
      selector: { kind: "chat", channelWireId: `wire-${index}` },
      access: "read-write",
    }));
    const filteredOut = Array.from(
      { length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
      (_, index) => ({
        shareId: `doc-${index}`,
        workspaceId: "workspace-1",
        selector: { kind: "document" },
      }),
    );
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({ granted: [...listed, ...filteredOut] }),
      workspaceId: "workspace-1",
    });
    expect(lanes.state).toBe("answered");
    expect(lanes.state === "answered" && lanes.granted).toHaveLength(10);
  });

  // A received grant is ACCOUNT-wide: the relay answers the same rows in every
  // workspace. Scoping them to the workspace that claimed them is what keeps
  // one workspace's sharing surface independent of another's.
  it("drops received shares another local workspace already claimed", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(["share-in-work"]),
      fetchListing: () =>
        Promise.resolve({
          received: [
            {
              shareId: "share-in-work",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-work" },
              access: "read-write",
            },
            {
              shareId: "share-unclaimed",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-free" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: "workspace-1",
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

  // The relay keeps returning revoked grants to the
  // granter, so counting them made the cap measure an account's lifetime
  // grants: past the cap the listing stayed over-limit with every grant
  // revoked, and revoking more could not reduce it. Third time this cap
  // produced a permanent-refusal shape, same cause each time — counting rows
  // the user cannot remove.
  it("drops revoked grants, so revoking one gets an account back under the cap", async () => {
    const grantRows = (revokedFrom: number) =>
      Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }, (_, index) => ({
        shareId: `share-${index}`,
        workspaceId: "workspace-1",
        recipientEmail: "ana@example.com",
        revokedAtMs: index >= revokedFrom ? 1_700_000_000_000 : null,
        selector: { kind: "chat", channelWireId: `wire-${index}` },
        access: "read-write",
      }));

    // Every grant live: genuinely over the cap.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const allLive = await readRelayChatShareLanes({
        shareIdsClaimedElsewhere: new Set<string>(),
        fetchListing: () =>
          Promise.resolve({ granted: grantRows(MAX_CHAT_CHANNEL_SHARE_ROWS + 1) }),
        workspaceId: "workspace-1",
      });
      expect(allLive.state).toBe("over-limit");
    } finally {
      warn.mockRestore();
    }

    // Revoke ONE. The relay still returns it, but it no longer counts, so the
    // account is back under the cap and can list again.
    const afterOneRevoke = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ granted: grantRows(MAX_CHAT_CHANNEL_SHARE_ROWS) }),
      workspaceId: "workspace-1",
    });
    expect(afterOneRevoke.state).toBe("answered");
    expect(
      afterOneRevoke.state === "answered" && afterOneRevoke.granted,
    ).toHaveLength(MAX_CHAT_CHANNEL_SHARE_ROWS);
    // And no revoked row is listed at all — nothing renders them, and carrying
    // them would leave the payload unbounded while merely uncounting them.
    expect(
      afterOneRevoke.state === "answered" &&
        afterOneRevoke.granted.every((row) => row.revokedAtMs === null),
    ).toBe(true);
  });

  // An ended row in another workspace claims nothing. The
  // tombstone is that workspace's own write gate and stays for that, but it
  // was never an argument for cross-workspace exclusivity — once A has left,
  // filtering the invitation out of every other workspace makes leaving
  // irreversible everywhere except A, where the only offered action is to
  // rejoin. The caller builds the set; this pins what the guard does with it.
  it("lists a received share again once the workspace holding it has left", async () => {
    const listing = () =>
      Promise.resolve({
        received: [
          {
            shareId: "share-left-elsewhere",
            granterEmail: "owner@example.com",
            selector: { kind: "chat", channelWireId: "wire-left" },
            access: "read-write",
          },
        ],
      });
    // While workspace A still holds it live, this workspace does not offer it.
    const whileHeld = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(["share-left-elsewhere"]),
      fetchListing: listing,
      workspaceId: "workspace-1",
    });
    expect(whileHeld.state === "answered" && whileHeld.received).toHaveLength(0);

    // Once A leaves, its row is ended and claims nothing, so the invitation
    // comes back here and the share can move.
    const afterLeave = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: listing,
      workspaceId: "workspace-1",
    });
    expect(
      afterLeave.state === "answered" && afterLeave.received.map((row) => row.shareId),
    ).toEqual(["share-left-elsewhere"]);
  });

  // The acceptance case for #618: another workspace's received lane being
  // unreadable must not blank a workspace that has shares of its own. The
  // scoping runs before the cap, so the rows homed elsewhere never count
  // against this workspace's lane.
  it("still answers this workspace's shares when the rows claimed elsewhere would blow the cap", async () => {
    const claimedElsewhere = Array.from(
      { length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
      (_, index) => ({
        shareId: `share-other-${index}`,
        granterEmail: "owner@example.com",
        selector: { kind: "chat", channelWireId: `wire-other-${index}` },
        access: "read-write",
      }),
    );
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(claimedElsewhere.map((row) => row.shareId)),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-mine" },
              access: "read-write",
            },
          ],
          received: [
            ...claimedElsewhere,
            {
              shareId: "share-here",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-here" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: "workspace-1",
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
    // The same account on another relay has different rows: its cache must
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

// A relay 401 acts if and only if it belongs to the current credentials, and
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
    // The second notify is the final state, after the store settled: a
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

  // #742 P1 SECURITY, round 5: a current-session 401 IS an account-session
  // end — main.ts's clearCachedCredentials() (called here as
  // clearCachedCredentials, exactly as main.ts wires it) also clears the DM
  // request-lanes cache, so a new account's first failed poll can never be
  // served the previous account's cached request rows. Driven through the
  // real createLastKnownDmRequestLanesCache, not a string log, so this
  // proves the cache itself ends up empty, not just that some callback fired.
  it("clears a real DM request-lanes cache when the current-session 401 path runs", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", {
      pending: [{ shareId: "share-a", granterEmail: "a@x.com" }],
      declined: [],
    });
    const acted = await handleRelayUnauthorized({
      requestCredentials: sessionA,
      currentCredentials: sessionA,
      clearCachedCredentials: () => cache.clear(),
      notifySessionChanging: () => undefined,
      notifyCloudSessionChanged: () => undefined,
      invalidatePersistedSessionIf: async () => undefined,
    });
    expect(acted).toBe(true);
    expect(cache.get("workspace-a")).toBeUndefined();
  });
});

// The catch classification: signed-out is authoritative only when the relay
// rejected the current credentials. A stale token's 401 — a listing still in
// flight across a same-account rotation — says nothing about the current
// session and must not clear cached rows.
describe("readRelayChatShareLanes session classification", () => {
  it("reports a stale session's 401 as unreachable, not signed-out", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.reject(
          new RelaySessionError("Your server session expired.", {
            sessionWasCurrent: false,
          }),
        ),
      workspaceId: "workspace-1",
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
      workspaceId: "workspace-1",
    });
    expect(nullBody).toEqual({ state: "unreachable" });

    const nonArray = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ granted: 3 } as unknown as {
          granted?: Array<Record<string, unknown>>;
        }),
      workspaceId: "workspace-1",
    });
    expect(nonArray).toEqual({ state: "unreachable" });

    // The ITERABLE non-array: a string lane iterates per character, every
    // character filters out, and the result would read as an authoritative
    // empty answer — clearing rows out of garbage.
    const stringLane = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ granted: "malformed" } as unknown as {
          granted?: Array<Record<string, unknown>>;
        }),
      workspaceId: "workspace-1",
    });
    expect(stringLane).toEqual({ state: "unreachable" });

    const stringReceived = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({ received: "malformed" } as unknown as {
          received?: Array<Record<string, unknown>>;
        }),
      workspaceId: "workspace-1",
    });
    expect(stringReceived).toEqual({ state: "unreachable" });
  });

  // Row-LEVEL validation lives inside the same guard: a 200 whose entries
  // map cleanly but carry an invalid field would otherwise escape to the
  // contract parse and reject the IPC call — the same clear-by-rejection.
  it("reports invalid row fields as unreachable, not as a rejection", async () => {
    // A chat grant with no shareId at all.
    const missingShareId = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-1" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: "workspace-1",
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
              selector: { kind: "chat", channelWireId: "wire-in" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: "workspace-1",
    });
    expect(badEmail).toEqual({ state: "unreachable" });
  });
});

// Acceptance: the joined-lane response size must be independent of how
// many channels the account has ever joined. A source-text pin cannot observe
// a response size, so this drives the real handler — parse, scope, and the
// contract parse the answer actually crosses IPC through.
describe("createListJoinedSharedChannelsIpcHandler", () => {
  // The registry as main holds it: one row per channel ever joined, most of
  // them tombstones from channels the workspace has left.
  function registry(size: number) {
    return Array.from({ length: size }, (_, index) => ({
      shareId: `share-${index}`,
      channelWireId: `wire-${index}`,
      access: "read-write" as const,
      granterEmail: null,
      ended: index % 2 === 0,
    }));
  }

  function handlerOver(rows: ReturnType<typeof registry>) {
    return createListJoinedSharedChannelsIpcHandler<TestEvent>({
      assertTrustedSender: () => undefined,
      withWorkspaceOperation: async (event, workspaceId, work) => {
        if (
          event.activeWorkspaceId !== undefined &&
          event.activeWorkspaceId !== workspaceId
        ) {
          throw new Error("This window changed workspaces.");
        }
        return await work({
          workspace: { workspaceId },
          assertCurrent: () => undefined,
        });
      },
      answerJoinedChannels: (_workspace, channelWireIds) =>
        scopeJoinedChannels(
          rows.map((row) => ({
            ...row,
            relayUrl: "http://relay.test",
            recipientUserId: "member-1",
          })),
          channelWireIds,
        ),
    });
  }

  // The mutation test at the layer that crosses IPC. Make the handler answer
  // from the full registry and this fails on the response size.
  it("answers a small named scope out of a huge registry, at the size of the scope", async () => {
    const shown = ["wire-3", "wire-7", "wire-9"];
    const answered = [];
    for (const size of [10, 1_000, 20_000]) {
      const result = await handlerOver(registry(size))(
        { trusted: true },
        { workspaceId: "ws-1", channelWireIds: shown },
      );
      expect(result.joined).toHaveLength(shown.length);
      expect(result.joined.map((answer) => answer.channelWireId)).toEqual(shown);
      answered.push(result.joined);
      // The serialized payload is what actually crosses IPC, and it does not
      // grow with the registry either.
      expect(JSON.stringify(result).length).toBeLessThan(1_000);
    }
    expect(answered[1]).toEqual(answered[0]);
    expect(answered[2]).toEqual(answered[0]);
  });

  it("names a channel it holds no row for, rather than omitting it", async () => {
    const result = await handlerOver(registry(4))(
      { trusted: true },
      { workspaceId: "ws-1", channelWireIds: ["wire-1", "wire-local"] },
    );
    expect(result.joined).toEqual([
      {
        channelWireId: "wire-1",
        joined: {
          shareId: "share-1",
          channelWireId: "wire-1",
          access: "read-write",
          granterEmail: null,
          ended: false,
        },
      },
      { channelWireId: "wire-local", joined: null },
    ]);
  });

  it("refuses a payload workspace that is not active in the renderer", async () => {
    const handler = handlerOver(registry(4));

    await expect(
      handler(
        { trusted: true, activeWorkspaceId: "ws-2" },
        { workspaceId: "ws-1", channelWireIds: ["wire-1"] },
      ),
    ).rejects.toThrow("changed workspaces");
  });

  it("refuses an untrusted sender before it reads anything", async () => {
    const handler = createListJoinedSharedChannelsIpcHandler<TestEvent>({
      assertTrustedSender: (event) => {
        if (!event.trusted) throw new Error("untrusted");
      },
      withWorkspaceOperation: async (_event, workspaceId, work) =>
        await work({
          workspace: { workspaceId },
          assertCurrent: () => undefined,
        }),
      answerJoinedChannels: () => {
        throw new Error("must not read");
      },
    });
    await expect(
      handler({ trusted: false }, { workspaceId: "ws-1", channelWireIds: [] }),
    ).rejects.toThrow("untrusted");
  });
});

// Read state is the reader's own, written locally and never replicated, so a
// share view marks threads read at every level, and after the share ends.
describe("chat read state in a share view", () => {
  const workspaceId = "workspace-share";

  it("marks a thread read at every level and after the share ends", async () => {
    for (const [label, over] of [
      ["view", { access: "view" }],
      ["comment", { access: "comment" }],
      ["edit", { access: "edit" }],
      ["ended", { access: "comment", ended: true }],
    ] as const) {
      const ipc = runtimeHarness();
      const run = vi.fn(async () => ({ ok: true }));
      ipc.handle(
        CHANNELS.markChatThreadRead,
        createMarkChatThreadReadIpcHandler({
          assertTrustedSender(event: TestEvent) {
            if (!event.trusted) throw new Error("Untrusted renderer.");
          },
          parsePayload(payload: unknown) {
            const parsed = payload as { workspaceId?: unknown };
            if (typeof parsed?.workspaceId !== "string") throw new Error("Invalid payload.");
            return { workspaceId: parsed.workspaceId };
          },
          requireContext: async () => ({ kind: "share" as const, workspace: { workspaceId }, ...over }),
          run,
        }),
      );
      await expect(ipc.invoke(CHANNELS.markChatThreadRead, { workspaceId })).resolves.toEqual({
        ok: true,
      });
      expect(run, label).toHaveBeenCalledTimes(1);
    }
  });
});
