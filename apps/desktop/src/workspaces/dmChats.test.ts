import { rm } from "node:fs/promises";
import { CHATS_METHOD, ChatsLoopbackEngine, type Request } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dmChannelNameFor,
  grantDmRecipients,
  listDmRecords,
  matchDmChannelByRecipients,
  parseDmRecipients,
  peekReceivedGrantKind,
  requireShareableChatChannel,
  resolveDmKinds,
  shareIdsToWithholdFromOrdinaryInvites,
  type ShareLogPage,
} from "./dmChats";
import {
  classifyDmRequests,
  isShareAcceptedInWorkspace,
  liveSharedChannelHoldersByShareId,
  reserveAndPullSharedChannel,
} from "./dmRequests";
import type { JoinedSharedChannel } from "./registryStore";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { createTestScratch } from "./testTemp";

// WS-MU-C3 — the desktop DM orchestration: role derivation (owner vs
// participant), display labels, and connected-state — all sourced from the
// local chat store plus the MU-C4 JoinedSharedChannel registry. A DM is a
// `kind:"dm"` channel; participant metadata rides the shared-channel grant.

const WS = "workspace-a";
const roots: string[] = [];

async function makeStore(): Promise<{
  store: ReturnType<typeof createLiveLinkedChatStore>;
  loopback: ChatsLoopbackEngine;
  seed: (request: Omit<Request, "id" | "workspace">) => Promise<void>;
}> {
  const root = await createTestScratch("dohc-dm-desktop-");
  roots.push(root);
  const loopback = new ChatsLoopbackEngine();
  const client = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request) {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: WS } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
  const store = createLiveLinkedChatStore({ workspaceId: WS, rootPath: root }, sessions);
  let nextRequestId = 1;
  return {
    store,
    loopback,
    seed: async (request) => {
      await loopback.sendRequest({ ...request, id: nextRequestId++, workspace: WS });
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function joined(overrides: Partial<JoinedSharedChannel> & { channelWireId: string }): JoinedSharedChannel {
  return {
    shareId: "share-1",
    access: "read-write",
    granterEmail: "alice@x.com",
    relayUrl: "http://relay.test",
    ...overrides,
    recipientUserId: overrides.recipientUserId ?? "member-1",
  };
}

describe("parseDmRecipients / dmChannelNameFor", () => {
  it("normalizes, dedupes, sorts, and validates recipient emails", () => {
    expect(parseDmRecipients(" Bob@X.com, alice@y.com  bob@x.com ")).toEqual([
      "alice@y.com",
      "bob@x.com",
    ]);
    expect(() => parseDmRecipients("not-an-email")).toThrow(/email/u);
    expect(() => parseDmRecipients("")).toThrow();
  });

  it("bounds the owner-side channel name to the 80-char cap", () => {
    const many = Array.from({ length: 6 }, (_, i) => `person-${i}@example.com`);
    expect(dmChannelNameFor(["bob@x.com"])).toBe("bob@x.com");
    expect(dmChannelNameFor(many).length).toBeLessThanOrEqual(80);
  });

  it("is PRESENTATION-ONLY: distinct recipient sets sharing a long prefix collide, so the name must never be a dedup key", () => {
    // Two genuinely different recipient sets whose derived names truncate to the
    // same 80-char string. This collision is EXPECTED and acceptable precisely
    // because DM identity is the recipient set (matchDmChannelByRecipients),
    // never this cosmetic name — the regression that fix locks in.
    const longA = `${"a".repeat(78)}1@example.com`;
    const longB = `${"a".repeat(78)}2@example.com`;
    expect(dmChannelNameFor([longA])).toBe(dmChannelNameFor([longB]));
    // The identity key (the sorted recipient set) DOES differ — see the
    // matchDmChannelByRecipients suite, which proves the two never dedupe.
    expect([longA]).not.toEqual([longB]);
  });
});

describe("matchDmChannelByRecipients", () => {
  // The DM's identity is its LIVE grant recipient set — NEVER the (truncatable,
  // collidable) display name. Two distinct recipient sets whose names collide at
  // the 80-char cap must resolve to DIFFERENT channels.
  it("reuses a DM only when its live grant recipient set EXACTLY equals the request, ignoring name collisions", () => {
    const longA = `${"a".repeat(78)}1@example.com`;
    const longB = `${"a".repeat(78)}2@example.com`;
    // Both derive the SAME 80-char-capped display name.
    expect(dmChannelNameFor([longA])).toBe(dmChannelNameFor([longB]));

    // Channel c1 is the live DM to longA (wire w1).
    const channels = [{ id: "c1", wireId: "w1" }];
    const liveGrantEmailsByWire = new Map([["w1", new Set([longA])]]);

    // The colliding request (longB) must NOT reuse c1.
    expect(
      matchDmChannelByRecipients({
        recipients: [longB],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBeNull();

    // The SAME recipient set (longA) reuses c1 (existing behaviour preserved).
    expect(
      matchDmChannelByRecipients({
        recipients: [longA],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBe("c1");
  });

  it("requires the FULL set to match — a subset or superset is a different DM", () => {
    const channels = [{ id: "c1", wireId: "w1" }];
    const liveGrantEmailsByWire = new Map([["w1", new Set(["a@x.com", "b@x.com"])]]);
    // Superset request (a,b) reuses; subset (a) or a different member (a,c) do not.
    expect(
      matchDmChannelByRecipients({
        recipients: ["a@x.com", "b@x.com"],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBe("c1");
    expect(
      matchDmChannelByRecipients({ recipients: ["a@x.com"], channels, liveGrantEmailsByWire }),
    ).toBeNull();
    expect(
      matchDmChannelByRecipients({
        recipients: ["a@x.com", "c@x.com"],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBeNull();
  });

  it("never matches a channel with no live grants (a fresh/orphaned DM) against a non-empty request", () => {
    const channels = [{ id: "c1", wireId: "w1" }];
    expect(
      matchDmChannelByRecipients({
        recipients: ["a@x.com"],
        channels,
        liveGrantEmailsByWire: new Map(),
      }),
    ).toBeNull();
  });
});

describe("grantDmRecipients", () => {
  it("grants every missing recipient and skips already-covered ones", async () => {
    const created: string[] = [];
    await grantDmRecipients({
      recipients: ["a@x.com", "b@x.com", "c@x.com"],
      covered: new Set(["b@x.com"]),
      createGrant: async (email) => {
        created.push(email);
        return `share-${email}`;
      },
      revokeGrant: async () => {
        throw new Error("must not revoke on the happy path");
      },
    });
    expect(created).toEqual(["a@x.com", "c@x.com"]);
  });

  it("rolls back THIS call's grants and rethrows when a later grant fails (no half-granted channel)", async () => {
    // Simulate the grant POST failing on the 2nd of 2 recipients.
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com", "b@x.com"],
        covered: new Set(),
        createGrant: async (email) => {
          if (email === "b@x.com") throw new Error("grant POST failed");
          return `share-${email}`;
        },
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
      }),
    ).rejects.toThrow(/grant POST failed/u);
    // The first recipient's grant was revoked → the channel has zero live grants.
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("never lets a revoke failure mask the original grant error", async () => {
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com", "b@x.com"],
        covered: new Set(),
        createGrant: async (email) => {
          if (email === "b@x.com") throw new Error("original grant error");
          return `share-${email}`;
        },
        revokeGrant: async () => {
          throw new Error("revoke also failed");
        },
      }),
    ).rejects.toThrow(/original grant error/u);
  });

  it("rolls back with the pinned grant client when the account changes", async () => {
    let current = true;
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com"],
        covered: new Set(),
        createGrant: async (email) => {
          current = false;
          return `share-${email}`;
        },
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        },
      }),
    ).rejects.toThrow("Your dohc Cloud session changed. Try again.");
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("rolls back when the session changes during post-grant preparation", async () => {
    let current = true;
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com"],
        covered: new Set(),
        createGrant: async (email) => `share-${email}`,
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        },
        beforeCommit: async () => {
          current = false;
        },
      }),
    ).rejects.toThrow("Your dohc Cloud session changed. Try again.");
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("rolls back when the first message mutation fails", async () => {
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com"],
        covered: new Set(),
        createGrant: async (email) => `share-${email}`,
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
        commit: async () => {
          throw new Error("journal write failed");
        },
      }),
    ).rejects.toThrow("journal write failed");
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("treats a null shareId as a failed grant and rolls back the rest", async () => {
    // The relay accepting a grant but withholding its id leaves an untrackable
    // grant we could never revoke — so it must fail the call (and roll back the
    // grants we CAN revoke), not slip through untracked.
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com", "b@x.com"],
        covered: new Set(),
        createGrant: async (email) => (email === "b@x.com" ? null : `share-${email}`),
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
      }),
    ).rejects.toThrow(/no share id/u);
    expect(revoked).toEqual(["share-a@x.com"]);
  });
});

describe("peekReceivedGrantKind", () => {
  // The share-log GET paginates RAW relay rows BEFORE the share filter, so the
  // FIRST page of a normal owner log (workspace.init THEN chat.channel.create)
  // is served EMPTY with hasMore=true. The peek must page nextCursor until the
  // first SERVED op — the create bootstrap — appears; matching the relay's real
  // {ops, nextCursor, hasMore} response shape.
  it("pages past a filtered prefix and detects kind:dm on the first served op", async () => {
    const pages = new Map<number, ShareLogPage>([
      // since=0: workspace.init is filtered out → empty page, cursor advances.
      [0, { ops: [], nextCursor: 1, hasMore: true }],
      // since=1: the chat.channel.create bootstrap is the first served op.
      [
        1,
        {
          ops: [{ opKind: "chat.channel.create", payload: { kind: "dm" } }],
          nextCursor: 2,
          hasMore: false,
        },
      ],
    ]);
    const seen: number[] = [];
    const kind = await peekReceivedGrantKind({
      fetchPage: async (since) => {
        seen.push(since);
        return pages.get(since) ?? null;
      },
    });
    expect(kind).toBe("dm");
    // It actually followed the cursor (did not stop on the empty first page).
    expect(seen).toEqual([0, 1]);
  });

  it("reports a regular kind:channel grant as a definitive not-dm (cacheable)", async () => {
    const kind = await peekReceivedGrantKind({
      fetchPage: async (since) =>
        since === 0
          ? { ops: [], nextCursor: 1, hasMore: true }
          : {
              ops: [{ opKind: "chat.channel.create", payload: { kind: "channel" } }],
              nextCursor: 2,
              hasMore: false,
            },
    });
    expect(kind).toBe("not-dm");
  });

  it("does not cache a malformed bootstrap as a definitive non-DM", async () => {
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({
          ops: [{ opKind: "chat.message.append", payload: {} }],
          nextCursor: 1,
          hasMore: false,
        }),
      }),
    ).resolves.toBe("unknown");
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({
          ops: [{ opKind: "chat.channel.create", payload: {} }],
          nextCursor: 1,
          hasMore: false,
        }),
      }),
    ).resolves.toBe("unknown");
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({
          ops: [{ opKind: "chat.channel.create", payload: { kind: "agent" } }],
          nextCursor: 1,
          hasMore: false,
        }),
      }),
    ).resolves.toBe("unknown");
  });

  it("caps pages scanned but keeps an all-filtered log retryable", async () => {
    let calls = 0;
    const kind = await peekReceivedGrantKind({
      // Every page is empty but keeps claiming hasMore with an advancing cursor.
      fetchPage: async (since) => {
        calls++;
        return { ops: [], nextCursor: since + 1, hasMore: true };
      },
      maxPages: 5,
    });
    expect(kind).toBe("unknown");
    expect(calls).toBe(5);
  });

  it("stops after one page when hasMore carries a stalled cursor", async () => {
    let calls = 0;
    const kind = await peekReceivedGrantKind({
      fetchPage: async (since) => {
        calls++;
        return { ops: [], nextCursor: since, hasMore: true };
      },
    });

    expect(kind).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("stops after one page when hasMore carries a non-numeric cursor", async () => {
    let calls = 0;
    const kind = await peekReceivedGrantKind({
      fetchPage: async () => {
        calls++;
        return { ops: [], nextCursor: "not-a-cursor", hasMore: true };
      },
    });

    expect(kind).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("keeps exhausted and un-fetchable logs transient until a create is visible", async () => {
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({ ops: [], nextCursor: 1, hasMore: false }),
      }),
    ).resolves.toBe("unknown");
    // A page that can't be fetched (network/relay hiccup) is UNKNOWN, never
    // cached as not-dm — otherwise a transient failure would permanently block
    // a real DM from ever auto-joining.
    await expect(
      peekReceivedGrantKind({ fetchPage: async () => null }),
    ).resolves.toBe("unknown");
  });

  it("retries when a grant races ahead of owner ops and detects the DM on the next poll", async () => {
    let ownerBootstrapVisible = false;
    const fetchPage = async (): Promise<ShareLogPage> =>
      ownerBootstrapVisible
        ? {
            ops: [
              { opKind: "chat.channel.create", payload: { kind: "dm" } },
              { opKind: "chat.thread.create", payload: { threadId: "thread-1" } },
              { opKind: "chat.message.append", payload: { messageId: "message-1" } },
            ],
            nextCursor: 3,
            hasMore: false,
          }
        : { ops: [], nextCursor: 0, hasMore: false };

    // First syncDms poll: grant exists, but the owner has not pushed its
    // channel/thread/message bootstrap. UNKNOWN must not enter the kind cache.
    await expect(peekReceivedGrantKind({ fetchPage })).resolves.toBe("unknown");
    ownerBootstrapVisible = true;
    // A later poll sees the immutable create and can list the message request.
    await expect(peekReceivedGrantKind({ fetchPage })).resolves.toBe("dm");
  });
});

describe("resolveDmKinds", () => {
  it("withholds confirmed DMs and unknown rows from the ordinary invite lane", async () => {
    const cache = new Map<string, "dm" | "not-dm">();

    await resolveDmKinds({
      shareIds: ["share-dm", "share-channel", "share-unknown"],
      cache,
      peekKind: async (shareId) => {
        if (shareId === "share-dm") return "dm";
        if (shareId === "share-channel") return "not-dm";
        return "unknown";
      },
    });

    expect(
      shareIdsToWithholdFromOrdinaryInvites({
        shareIds: ["share-dm", "share-channel", "share-unknown"],
        cache,
      }),
    ).toEqual(new Set(["share-dm", "share-unknown"]));
  });

  it("withholds unresolved grants and retries their peek on the next call", async () => {
    const cache = new Map<string, "dm" | "not-dm">();
    const peekKind = vi
      .fn<(shareId: string) => Promise<"unknown" | "not-dm">>()
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("not-dm");

    await resolveDmKinds({ shareIds: ["share-late"], cache, peekKind });
    expect(cache.has("share-late")).toBe(false);
    await resolveDmKinds({ shareIds: ["share-late"], cache, peekKind });
    expect(cache.get("share-late")).toBe("not-dm");
    expect(peekKind).toHaveBeenCalledTimes(2);
  });

  it("peeks uncached grants with bounded parallelism", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const peekKind = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return "not-dm" as const;
    });

    await resolveDmKinds({
      shareIds: Array.from({ length: 7 }, (_, index) => `share-${index}`),
      cache: new Map(),
      peekKind,
    });

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});

describe("DM request decisions", () => {
  it("classifies a poll without any path that can materialize a request", async () => {
    const kindCache = new Map<string, "dm" | "not-dm">([
      ["share-claimed", "dm"],
    ]);
    const peekKind = vi.fn(async (shareId: string) => {
      if (shareId === "share-pending" || shareId === "share-declined") return "dm";
      if (shareId === "share-channel") return "not-dm";
      return "unknown";
    });
    const holdersByShareId = vi.fn(() =>
      new Map<string, ReadonlySet<string>>([
        ["share-claimed", new Set(["workspace-a"])],
      ]),
    );
    const input: Parameters<typeof classifyDmRequests>[0] = {
      received: [
        { shareId: "share-pending", granterEmail: "pending@example.com", selector: { kind: "chat-channel", channelWireId: "wire-pending" } },
        { shareId: "share-declined", granterEmail: "declined@example.com", selector: { kind: "chat-channel", channelWireId: "wire-declined" } },
        { shareId: "share-channel", selector: { kind: "chat-channel", channelWireId: "wire-channel" } },
        { shareId: "share-unknown", selector: { kind: "chat-channel", channelWireId: "wire-unknown" } },
        { shareId: "share-claimed", selector: { kind: "chat-channel", channelWireId: "wire-claimed" } },
      ],
      kindCache,
      peekKind,
      holdersByShareId,
      declinedShareIds: new Set(["share-declined"]),
    };

    await expect(classifyDmRequests(input)).resolves.toEqual({
      pending: [
        { shareId: "share-pending", granterEmail: "pending@example.com" },
      ],
      declined: [
        { shareId: "share-declined", granterEmail: "declined@example.com" },
      ],
    });
    expect(peekKind).not.toHaveBeenCalledWith("share-claimed");
    expect(kindCache.has("share-unknown")).toBe(false);
  });

  it("withholds requests when the declined store cannot be read", async () => {
    const received = [
      {
        shareId: "share-pending",
        granterEmail: "pending@example.com",
        selector: { kind: "chat-channel", channelWireId: "wire-pending" },
      },
      {
        shareId: "share-declined",
        granterEmail: "declined@example.com",
        selector: { kind: "chat-channel", channelWireId: "wire-declined" },
      },
    ];
    const kindCache = new Map<string, "dm" | "not-dm">();
    const peekKind = vi.fn(async () => "dm" as const);
    const common = {
      received,
      kindCache,
      peekKind,
      holdersByShareId: () => new Map<string, ReadonlySet<string>>(),
    };

    await expect(
      classifyDmRequests({ ...common, declinedShareIds: null }),
    ).resolves.toEqual({ pending: [], declined: [] });
    expect(peekKind).toHaveBeenCalledTimes(2);

    await expect(
      classifyDmRequests({
        ...common,
        declinedShareIds: new Set(["share-declined"]),
      }),
    ).resolves.toEqual({
      pending: [
        { shareId: "share-pending", granterEmail: "pending@example.com" },
      ],
      declined: [
        { shareId: "share-declined", granterEmail: "declined@example.com" },
      ],
    });
  });

  it("reserves and pulls in the explicitly chosen workspace", async () => {
    const registry = new Map<string, JoinedSharedChannel[]>([
      ["workspace-a", []],
      ["workspace-b", []],
      ["workspace-c", []],
    ]);
    const writeSharedChannels = vi.fn(
      (workspaceId: string, channels: JoinedSharedChannel[]) => {
        registry.set(workspaceId, channels);
      },
    );
    const pull = vi.fn(async () => ({ applied: 1 }));

    await reserveAndPullSharedChannel({
      relay: { baseUrl: "http://relay.test", token: "token" },
      shareId: "share-c",
      workspaceId: "workspace-c",
      rootPath: "/workspaces/c",
      recipientUserId: "user-c",
      relayUrl: "http://relay.test",
      readSharedChannels: (workspaceId) => registry.get(workspaceId) ?? [],
      writeSharedChannels,
      fetchInfo: async () => ({
        shareId: "share-c",
        granterUserId: "granter",
        granterEmail: "granter@example.com",
        channelWireId: "wire-c",
        access: "read-write",
        createdAtMs: 1,
      }),
      pull,
      serialize: async (_workspaceId, run) => await run(),
    });

    expect(writeSharedChannels).toHaveBeenCalledTimes(1);
    expect(writeSharedChannels.mock.calls[0]?.[0]).toBe("workspace-c");
    expect(registry.get("workspace-a")).toEqual([]);
    expect(registry.get("workspace-b")).toEqual([]);
    expect(registry.get("workspace-c")?.[0]?.shareId).toBe("share-c");
  });

  it("lets only one concurrent workspace reserve the same DM share", async () => {
    const registry = new Map<string, JoinedSharedChannel[]>([
      ["workspace-a", []],
      ["workspace-b", []],
    ]);
    const info = {
      shareId: "share-race",
      granterUserId: "granter",
      granterEmail: "granter@example.com",
      channelWireId: "wire-race",
      access: "read-write" as const,
      createdAtMs: 1,
    };
    const fetchResolvers: Array<(value: typeof info) => void> = [];
    const fetchInfo = vi.fn(
      () =>
        new Promise<typeof info>((resolve) => {
          fetchResolvers.push(resolve);
        }),
    );
    const writeSharedChannels = (
      workspaceId: string,
      channels: JoinedSharedChannel[],
    ) => {
      registry.set(workspaceId, channels);
    };
    const reserve = (workspaceId: string) =>
      reserveAndPullSharedChannel({
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId: info.shareId,
        workspaceId,
        rootPath: `/workspaces/${workspaceId}`,
        recipientUserId: "user-1",
        relayUrl: "http://relay.test",
        readSharedChannels: (candidateId) => registry.get(candidateId) ?? [],
        writeSharedChannels,
        fetchInfo,
        pull: async () => ({ applied: 0 }),
        serialize: async (_candidateId, run) => await run(),
        preWrite: () => {
          const heldElsewhere = [...registry.entries()].some(
            ([candidateId, channels]) =>
              candidateId !== workspaceId &&
              channels.some(
                (channel) =>
                  channel.shareId === info.shareId && channel.ended !== true,
              ),
          );
          if (heldElsewhere) throw new Error("share already held elsewhere");
        },
      });

    const first = reserve("workspace-a");
    const second = reserve("workspace-b");
    expect(fetchResolvers).toHaveLength(2);
    fetchResolvers[0]!(info);
    await expect(first).resolves.toMatchObject({ shareId: info.shareId });
    fetchResolvers[1]!(info);
    await expect(second).rejects.toThrow("share already held elsewhere");

    const holders = [...registry.values()].filter((channels) =>
      channels.some(
        (channel) => channel.shareId === info.shareId && channel.ended !== true,
      ),
    );
    expect(holders).toHaveLength(1);
  });

  it("treats an ended row as re-requestable and re-accepts it", async () => {
    const ended = joined({
      shareId: "share-x",
      channelWireId: "wire-x",
      ended: true,
    });
    const workspaces = [
      { workspaceId: "workspace-a", rootPath: "/a", sharedChannels: [ended] },
      { workspaceId: "workspace-b", rootPath: "/b", sharedChannels: [] },
    ];
    const classified = await classifyDmRequests({
      received: [
        { shareId: "share-x", granterEmail: "x@example.com", selector: { kind: "chat-channel", channelWireId: "wire-x" } },
      ],
      kindCache: new Map(),
      peekKind: async () => "dm",
      holdersByShareId: () => liveSharedChannelHoldersByShareId(workspaces),
      declinedShareIds: new Set(),
    });
    expect(classified.pending.map((row) => row.shareId)).toEqual(["share-x"]);
    expect(isShareAcceptedInWorkspace([ended], "share-x")).toBe(false);

    const pull = vi.fn(async () => ({ applied: 0 }));
    const writeSharedChannels = vi.fn();
    await reserveAndPullSharedChannel({
      relay: { baseUrl: "http://relay.test", token: "token" },
      shareId: "share-x",
      workspaceId: "workspace-a",
      rootPath: "/a",
      recipientUserId: "user-a",
      relayUrl: "http://relay.test",
      readSharedChannels: () => [ended],
      writeSharedChannels,
      fetchInfo: async () => ({
        shareId: "share-x",
        granterUserId: "granter",
        granterEmail: "x@example.com",
        channelWireId: "wire-x",
        access: "read-write",
        createdAtMs: 1,
      }),
      pull,
      serialize: async (_workspaceId, run) => await run(),
    });
    expect(writeSharedChannels.mock.calls[0]?.[1]?.[0]?.ended).toBeUndefined();
    expect(pull).toHaveBeenCalledOnce();
  });
});

describe("requireShareableChatChannel", () => {
  it("rejects a crafted generic-share request for a DM at runtime", async () => {
    const { store, seed } = await makeStore();
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "dm-1", name: "bob@x.com", kind: "dm", nowMs: 1 },
    });

    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "dm-1", store }),
    ).rejects.toThrow(/Direct messages can't be shared as channels/u);

    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "channel-1", name: "Project room", kind: "channel", nowMs: 2 },
    });
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "channel-1", store }),
    ).resolves.toBeUndefined();

    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "agent-1", name: "My agent", kind: "agent", nowMs: 3 },
    });
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "agent-1", store }),
    ).rejects.toThrow(/Only ordinary channels can be shared/u);
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "missing-channel", store }),
    ).rejects.toThrow(/no longer exists/u);
  });
});

describe("listDmRecords", () => {
  it("derives owner role from wire id == channel id and labels it by the recipient set", async () => {
    const { store, seed } = await makeStore();
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "dm-1", name: "bob@x.com", kind: "dm", nowMs: 1 },
    });
    await seed({
      method: CHATS_METHOD.threadStart,
      idempotencyKey: "thread-1:message-1",
      params: {
        channelId: "dm-1",
        threadId: "thread-1",
        messageId: "message-1",
        authorKind: "human",
        authorDisplayName: "Alice",
        authorUserId: "user-alice",
        body: "hello",
        nowMs: 2,
      },
    });
    // A PLAIN channel never appears in the DM list.
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "channel-1", name: "general-ish", kind: "channel", nowMs: 3 },
    });

    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: [] });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      channelId: "dm-1",
      channelWireId: "dm-1",
      role: "owner",
      peerLabel: "bob@x.com",
      threadId: "thread-1",
      shareId: null,
      connected: true,
    });
  });

  it("hides an OWNER DM with no thread (aborted/rolled-back start) but keeps a committed owner DM", async () => {
    const { store, seed } = await makeStore();
    // An aborted start: the channel was created but grants failed → rolled back
    // before the first message, so there is no thread.
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "dm-aborted", name: "aborted@x.com", kind: "dm", nowMs: 1 },
    });
    expect(await listDmRecords({ workspaceId: WS, store, sharedChannels: [] })).toHaveLength(0);

    // A committed owner DM (first message sent → a thread exists) still shows.
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "dm-live", name: "bob@x.com", kind: "dm", nowMs: 2 },
    });
    await seed({
      method: CHATS_METHOD.threadStart,
      idempotencyKey: "thread-live:message-live",
      params: {
        channelId: "dm-live",
        threadId: "thread-live",
        messageId: "message-live",
        authorKind: "human",
        authorDisplayName: "Alice",
        authorUserId: "user-alice",
        body: "hi",
        nowMs: 3,
      },
    });
    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: [] });
    expect(dms.map((d) => d.channelId)).toEqual(["dm-live"]);
  });

  it("keeps an accepted participant DM visible while its first thread is still missing", async () => {
    const { store, loopback } = await makeStore();
    // A replayed DM whose owner granted before sending — channel.create only,
    // no thread.create yet. Current Rust replay preserves the owner's channel
    // id, so the durable joined-share row is the participant provenance.
    // The accepted DM stays visible instead of looking like an owner orphan.
    loopback.seedChannel({
      workspace: WS,
      channelId: "owner-channel-1",
      wireId: "owner-channel-1",
      name: "bob@x.com",
      kind: "dm",
      createdAtMs: 1,
    });
    const registry = [joined({ shareId: "share-1", channelWireId: "owner-channel-1" })];
    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: registry });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      role: "participant",
      channelWireId: "owner-channel-1",
      threadId: null,
      connected: true,
    });
  });

  it("keeps a pre-existing accepted DM live after the dmHomeStore deletion", async () => {
    const { store, loopback, seed } = await makeStore();
    loopback.seedChannel({
      workspace: WS,
      channelId: "owner-channel-existing",
      wireId: "owner-channel-existing",
      name: "member@example.com",
      kind: "dm",
      createdAtMs: 1,
    });
    await seed({
      method: CHATS_METHOD.threadStart,
      idempotencyKey: "thread-existing:message-existing",
      params: {
        channelId: "owner-channel-existing",
        threadId: "thread-existing",
        messageId: "message-existing",
        authorKind: "human",
        authorDisplayName: "Alice",
        authorUserId: "user-alice",
        body: "Existing history",
        nowMs: 2,
      },
    });
    const registry = [
      joined({
        shareId: "share-existing",
        channelWireId: "owner-channel-existing",
      }),
    ];

    const dms = await listDmRecords({
      workspaceId: WS,
      store,
      sharedChannels: registry,
    });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      role: "participant",
      shareId: "share-existing",
      threadId: "thread-existing",
      connected: true,
    });

    const requests = await classifyDmRequests({
      received: [
        {
          shareId: "share-existing",
          granterEmail: "alice@x.com",
          selector: {
            kind: "chat-channel",
            channelWireId: "owner-channel-existing",
          },
        },
      ],
      kindCache: new Map([["share-existing", "dm"]]),
      peekKind: async () => "dm",
      holdersByShareId: () =>
        liveSharedChannelHoldersByShareId([
          { workspaceId: WS, rootPath: "/accepted", sharedChannels: registry },
          { workspaceId: "workspace-b", rootPath: "/other", sharedChannels: [] },
        ]),
      declinedShareIds: new Set(),
    });
    expect(requests).toEqual({ pending: [], declined: [] });
  });

  it("derives participant role from a replayed channel and labels it by the GRANTER, not the replicated name", async () => {
    const { store, loopback, seed } = await makeStore();
    // A replayed DM with the active Rust import shape: local id and wire id
    // are equal. The joined row supplies participant role and granter label.
    loopback.seedChannel({
      workspace: WS,
      channelId: "owner-channel-1",
      wireId: "owner-channel-1",
      // The owner's recipient list — i.e. THIS participant's own address.
      name: "bob@x.com",
      kind: "dm",
      createdAtMs: 1,
    });
    await seed({
      method: CHATS_METHOD.threadStart,
      idempotencyKey: "thread-dm:message-dm",
      params: {
        channelId: "owner-channel-1",
        threadId: "thread-dm",
        messageId: "message-dm",
        authorKind: "human",
        authorDisplayName: "Alice",
        body: "hi",
        nowMs: 2,
      },
    });

    const registry = [joined({ shareId: "share-1", channelWireId: "owner-channel-1" })];
    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: registry });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      channelWireId: "owner-channel-1",
      role: "participant",
      // Labelled by the GRANTER — the replicated name is the participant's own
      // address and would otherwise read as a DM with themselves.
      peerLabel: "alice@x.com",
      shareId: "share-1",
      threadId: "thread-dm",
      connected: true,
    });

    // The grant ends (revoked / owner gone): reading stays, sending closes.
    const ended = await listDmRecords({
      workspaceId: WS,
      store,
      sharedChannels: [joined({ shareId: "share-1", channelWireId: "owner-channel-1", ended: true })],
    });
    expect(ended[0]).toMatchObject({ role: "participant", connected: false });

    // No joined provenance models a normal owner-workspace replay. Equal ids
    // remain owner-owned and writable; member leave keeps an ended row instead.
    const ownerReplay = await listDmRecords({ workspaceId: WS, store, sharedChannels: [] });
    expect(ownerReplay[0]).toMatchObject({
      role: "owner",
      connected: true,
      shareId: null,
      peerLabel: "bob@x.com",
    });
  });
});
