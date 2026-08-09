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
  classifyDmRequestsWithFallback,
  createLastKnownDmRequestLanesCache,
  isShareAcceptedInWorkspace,
  liveSharedChannelHoldersByShareId,
  liveSharedChannelHoldersByWireId,
  markLeftInLastKnownLanes,
  otherLiveSharedChannelHolderByWireId,
  reserveAndPullSharedChannel,
  withholdDmsInRequestLanes,
  type DmRequestLanes,
} from "./dmRequests";
import type { JoinedSharedChannel } from "./registryStore";
import { endJoinedChannel } from "./sharedChannels";
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
      holdersByWireId: () => new Map<string, ReadonlySet<string>>(),
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
      holdersByWireId: () => new Map<string, ReadonlySet<string>>(),
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

  it("withholds a re-grant while its wire id is live in another workspace", async () => {
    const input = {
      received: [
        {
          shareId: "share-new",
          granterEmail: "owner@example.com",
          selector: { kind: "chat-channel", channelWireId: "wire-x" },
        },
      ],
      kindCache: new Map<string, "dm" | "not-dm">(),
      peekKind: async () => "dm" as const,
      holdersByShareId: () =>
        new Map<string, ReadonlySet<string>>([
          ["share-old", new Set(["workspace-a"])],
        ]),
      holdersByWireId: () =>
        new Map<string, ReadonlySet<string>>([
          ["wire-x", new Set(["workspace-a"])],
        ]),
      declinedShareIds: new Set<string>(),
    };

    await expect(classifyDmRequests(input)).resolves.toEqual({
      pending: [],
      declined: [],
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

  it("refuses a direct re-grant reservation when its resolved wire id is held elsewhere", async () => {
    const registry = new Map<string, JoinedSharedChannel[]>([
      [
        "workspace-a",
        [joined({ shareId: "share-old", channelWireId: "wire-x" })],
      ],
      ["workspace-b", []],
    ]);
    const writeSharedChannels = vi.fn(
      (workspaceId: string, channels: JoinedSharedChannel[]) => {
        registry.set(workspaceId, channels);
      },
    );
    const preWrite = (info: { channelWireId: string }) => {
      const holder = otherLiveSharedChannelHolderByWireId({
        workspaces: [...registry].map(([workspaceId, sharedChannels]) => ({
          workspaceId,
          rootPath: `/workspaces/${workspaceId}`,
          sharedChannels,
        })),
        workspaceId: "workspace-b",
        channelWireId: info.channelWireId,
      });
      if (holder) {
        const workspaceName = holder.rootPath.split("/").at(-1);
        throw new Error(
          `This conversation already lives in ${workspaceName}. Open that workspace to continue.`,
        );
      }
    };

    await expect(
      reserveAndPullSharedChannel({
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId: "share-new",
        workspaceId: "workspace-b",
        rootPath: "/workspaces/workspace-b",
        recipientUserId: "user-b",
        relayUrl: "http://relay.test",
        readSharedChannels: (workspaceId) => registry.get(workspaceId) ?? [],
        writeSharedChannels,
        fetchInfo: async () => ({
          shareId: "share-new",
          granterUserId: "granter",
          granterEmail: "owner@example.com",
          channelWireId: "wire-x",
          access: "read-write",
          createdAtMs: 1,
        }),
        pull: async () => ({ applied: 0 }),
        serialize: async (_workspaceId, run) => await run(),
        preWrite,
      }),
    ).rejects.toThrow(
      "This conversation already lives in workspace-a. Open that workspace to continue.",
    );
    expect(writeSharedChannels).not.toHaveBeenCalled();
  });

  it("releases a wire id after its old workspace row ends", async () => {
    const ended = joined({
      shareId: "share-old",
      channelWireId: "wire-x",
      ended: true,
    });
    const workspaces = [
      {
        workspaceId: "workspace-a",
        rootPath: "/workspaces/workspace-a",
        sharedChannels: [ended],
      },
      {
        workspaceId: "workspace-b",
        rootPath: "/workspaces/workspace-b",
        sharedChannels: [] as JoinedSharedChannel[],
      },
    ];
    const classified = await classifyDmRequests({
      received: [
        {
          shareId: "share-new",
          granterEmail: "owner@example.com",
          selector: { kind: "chat-channel", channelWireId: "wire-x" },
        },
      ],
      kindCache: new Map(),
      peekKind: async () => "dm",
      holdersByShareId: () => liveSharedChannelHoldersByShareId(workspaces),
      holdersByWireId: () => liveSharedChannelHoldersByWireId(workspaces),
      declinedShareIds: new Set(),
    });
    expect(classified.pending).toEqual([
      { shareId: "share-new", granterEmail: "owner@example.com" },
    ]);

    const writeSharedChannels = vi.fn(
      (workspaceId: string, channels: JoinedSharedChannel[]) => {
        const workspace = workspaces.find(
          (candidate) => candidate.workspaceId === workspaceId,
        );
        if (workspace) workspace.sharedChannels = channels;
      },
    );
    await expect(
      reserveAndPullSharedChannel({
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId: "share-new",
        workspaceId: "workspace-b",
        rootPath: "/workspaces/workspace-b",
        recipientUserId: "user-b",
        relayUrl: "http://relay.test",
        readSharedChannels: (workspaceId) =>
          workspaces.find((workspace) => workspace.workspaceId === workspaceId)
            ?.sharedChannels ?? [],
        writeSharedChannels,
        fetchInfo: async () => ({
          shareId: "share-new",
          granterUserId: "granter",
          granterEmail: "owner@example.com",
          channelWireId: "wire-x",
          access: "read-write",
          createdAtMs: 1,
        }),
        pull: async () => ({ applied: 0 }),
        serialize: async (_workspaceId, run) => await run(),
        preWrite: (info) => {
          const holder = otherLiveSharedChannelHolderByWireId({
            workspaces,
            workspaceId: "workspace-b",
            channelWireId: info.channelWireId,
          });
          if (holder) throw new Error("wire held elsewhere");
        },
      }),
    ).resolves.toMatchObject({
      shareId: "share-new",
      channelWireId: "wire-x",
    });
    expect(writeSharedChannels).toHaveBeenCalledOnce();
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
      holdersByWireId: () => liveSharedChannelHoldersByWireId(workspaces),
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

  // #742: drives the leave control's own reversibility flow end-to-end,
  // starting from a LIVE accepted row (not a pre-fabricated ended fixture)
  // and calling endJoinedChannel — the exact function leaveDm/
  // leaveSharedChannel call — so this proves the NEW control's mechanism,
  // not just that an already-ended row is reversible.
  it("leaving a live row (endJoinedChannel) makes it a request again and lets another workspace accept it", async () => {
    const live = joined({ shareId: "share-live", channelWireId: "wire-live" });
    const workspaces = [
      { workspaceId: "workspace-a", rootPath: "/a", sharedChannels: [live] },
      { workspaceId: "workspace-b", rootPath: "/b", sharedChannels: [] },
    ];

    // One shared kindCache across both calls, like the real syncDms poll
    // (peekedReceivedGrantKinds persists across polls): the second call needs
    // no fixture kind, it reuses what the first call already resolved.
    const kindCache = new Map<string, "dm" | "not-dm">();
    const classify = () =>
      classifyDmRequests({
        received: [
          {
            shareId: "share-live",
            granterEmail: "x@example.com",
            selector: { kind: "chat-channel", channelWireId: "wire-live" },
          },
        ],
        kindCache,
        peekKind: async () => "dm",
        holdersByShareId: () => liveSharedChannelHoldersByShareId(workspaces),
        holdersByWireId: () => liveSharedChannelHoldersByWireId(workspaces),
        declinedShareIds: new Set(),
      });

    // Before leaving: workspace-a holds it, so it is not a pending request.
    expect((await classify()).pending).toEqual([]);

    // Leave: the same endJoinedChannel call leaveDm's IPC handler makes.
    workspaces[0]!.sharedChannels = endJoinedChannel(
      workspaces[0]!.sharedChannels,
      "share-live",
    );
    expect(isShareAcceptedInWorkspace(workspaces[0]!.sharedChannels, "share-live")).toBe(
      false,
    );

    // After leaving: no workspace holds it, so it reappears as a request.
    const afterLeave = await classify();
    expect(afterLeave.pending.map((row) => row.shareId)).toEqual(["share-live"]);

    // Accepting elsewhere (workspace-b) succeeds.
    const writeSharedChannels = vi.fn(
      (workspaceId: string, channels: JoinedSharedChannel[]) => {
        const workspace = workspaces.find(
          (candidate) => candidate.workspaceId === workspaceId,
        );
        if (workspace) workspace.sharedChannels = channels;
      },
    );
    const revived = await reserveAndPullSharedChannel({
      relay: { baseUrl: "http://relay.test", token: "token" },
      shareId: "share-live",
      workspaceId: "workspace-b",
      rootPath: "/b",
      recipientUserId: "user-b",
      relayUrl: "http://relay.test",
      readSharedChannels: (workspaceId) =>
        workspaces.find((workspace) => workspace.workspaceId === workspaceId)
          ?.sharedChannels ?? [],
      writeSharedChannels,
      fetchInfo: async () => ({
        shareId: "share-live",
        granterUserId: "granter",
        granterEmail: "x@example.com",
        channelWireId: "wire-live",
        access: "read-write",
        createdAtMs: 1,
      }),
      pull: async () => ({ applied: 0 }),
      serialize: async (_workspaceId, run) => await run(),
    });
    expect(revived).toMatchObject({ shareId: "share-live", channelWireId: "wire-live" });
    expect(
      isShareAcceptedInWorkspace(workspaces[1]!.sharedChannels, "share-live"),
    ).toBe(true);
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
      holdersByWireId: () =>
        liveSharedChannelHoldersByWireId([
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

// #742 P1-A: without this, leaving a DM ends its row but the SAME conversation
// stays visible twice — once as the readable-tombstone row the test above
// just proved listDmRecords keeps (connected:false), and once as the pending
// request classifyDmRequests re-lists once no workspace holds a live row.
// "One identity, one place" — the request-lane representation wins.
describe("withholdDmsInRequestLanes", () => {
  it("drops a dm whose shareId is pending or declined, keeps everything else", () => {
    const endedLeft = { shareId: "share-left", channelWireId: "wire-left", connected: false };
    const endedDeclined = {
      shareId: "share-declined",
      channelWireId: "wire-declined",
      connected: false,
    };
    const liveOther = { shareId: "share-other", channelWireId: "wire-other", connected: true };
    const owned = { shareId: null, channelWireId: "wire-owned", connected: true };
    const result = withholdDmsInRequestLanes({
      dms: [endedLeft, endedDeclined, liveOther, owned],
      requestShareIds: new Set(["share-left", "share-declined"]),
      holdersByShareId: new Map(),
      holdersByWireId: new Map(),
      workspaceId: "workspace-a",
    });
    expect(result).toEqual([liveOther, owned]);
  });

  it("leaves the owner-revoked tombstone case alone: no request AND no other live holder", () => {
    // The owner-revoked case: the grant is gone from the relay's received
    // listing (no request), and nobody accepted it anywhere (no live
    // holder, by either shareId or wire) — every check passes it through.
    const revoked = { shareId: "share-revoked", channelWireId: "wire-revoked", connected: false };
    const result = withholdDmsInRequestLanes({
      dms: [revoked],
      requestShareIds: new Set(),
      holdersByShareId: new Map(),
      holdersByWireId: new Map(),
      workspaceId: "workspace-a",
    });
    expect(result).toEqual([revoked]);
  });

  // #742 P1 (round 4): leave in workspace A, accept the SAME request into
  // workspace B — the share leaves the request lanes the moment B holds it
  // live, and the request-lane check ALONE would stop withholding it, so A's
  // ended row would reappear. Built through the REAL holder-map function
  // (liveSharedChannelHoldersByShareId), not a hand-typed Map, so this proves
  // the actual integration, not just the filter's own arithmetic.
  it("withholds an ended row whose share is held live by another workspace, even once it leaves the request lanes", () => {
    const endedInA = joined({
      shareId: "share-x",
      channelWireId: "wire-x",
      ended: true,
    });
    const liveInB = joined({
      shareId: "share-x",
      channelWireId: "wire-x",
    });
    const workspaces = [
      { workspaceId: "workspace-a", rootPath: "/a", sharedChannels: [endedInA] },
      { workspaceId: "workspace-b", rootPath: "/b", sharedChannels: [liveInB] },
    ];
    const holdersByShareId = liveSharedChannelHoldersByShareId(workspaces);
    const holdersByWireId = liveSharedChannelHoldersByWireId(workspaces);
    expect(holdersByShareId.get("share-x")).toEqual(new Set(["workspace-b"]));

    const result = withholdDmsInRequestLanes({
      dms: [{ shareId: "share-x", channelWireId: "wire-x", connected: false }],
      // Accepted elsewhere: the share is no longer a request anywhere.
      requestShareIds: new Set(),
      holdersByShareId,
      holdersByWireId,
      workspaceId: "workspace-a",
    });
    expect(result).toEqual([]);
  });

  it("does not withhold a live holder held by the SAME workspace (not 'other')", () => {
    const liveHere = joined({ shareId: "share-y", channelWireId: "wire-y" });
    const workspaces = [
      { workspaceId: "workspace-a", rootPath: "/a", sharedChannels: [liveHere] },
    ];
    const holdersByShareId = liveSharedChannelHoldersByShareId(workspaces);
    const holdersByWireId = liveSharedChannelHoldersByWireId(workspaces);
    const result = withholdDmsInRequestLanes({
      dms: [{ shareId: "share-y", channelWireId: "wire-y", connected: true }],
      requestShareIds: new Set(),
      holdersByShareId,
      holdersByWireId,
      workspaceId: "workspace-a",
    });
    expect(result).toEqual([{ shareId: "share-y", channelWireId: "wire-y", connected: true }]);
  });

  // #742 (round 6): a re-grant mints a NEW shareId for the SAME
  // channelWireId (PR #737 round 5) — end in A under share A1, then accept
  // the SAME conversation elsewhere under a re-granted share B1. A1 itself
  // is never held live by anyone (B holds B1, a different shareId, and A1's
  // grant is revoked so it never re-enters the request lanes either) — the
  // shareId-only checks would both miss this and A's ended A1 row would
  // reappear. Only the wire id, the conversation's real stable identity
  // across the re-grant, catches it.
  it("withholds an ended row via wire identity when a re-grant gave the live holder a DIFFERENT shareId", () => {
    const endedInA = joined({
      shareId: "share-a1",
      channelWireId: "wire-shared",
      ended: true,
    });
    const liveInBUnderNewShare = joined({
      shareId: "share-b1",
      channelWireId: "wire-shared",
    });
    const workspaces = [
      { workspaceId: "workspace-a", rootPath: "/a", sharedChannels: [endedInA] },
      {
        workspaceId: "workspace-b",
        rootPath: "/b",
        sharedChannels: [liveInBUnderNewShare],
      },
    ];
    const holdersByShareId = liveSharedChannelHoldersByShareId(workspaces);
    const holdersByWireId = liveSharedChannelHoldersByWireId(workspaces);
    // The share-id map alone misses this: nobody holds "share-a1" live.
    expect(holdersByShareId.get("share-a1")).toBeUndefined();
    expect(holdersByWireId.get("wire-shared")).toEqual(new Set(["workspace-b"]));

    const result = withholdDmsInRequestLanes({
      dms: [{ shareId: "share-a1", channelWireId: "wire-shared", connected: false }],
      // share-a1's grant is revoked (superseded by share-b1), so it never
      // re-enters the request lanes either.
      requestShareIds: new Set(),
      holdersByShareId,
      holdersByWireId,
      workspaceId: "workspace-a",
    });
    expect(result).toEqual([]);
  });
});

// #742 P1 (rounds 3–4): the syncDms fallback + session-transition machinery,
// extracted pure and dependency-injected so it gets real executing coverage
// (the #737 precedent for anything that would otherwise be a main.ts-only
// closure).
describe("createLastKnownDmRequestLanesCache / classifyDmRequestsWithFallback", () => {
  const laneA = { pending: [{ shareId: "share-a", granterEmail: "a@x.com" }], declined: [] };
  const laneB = { pending: [{ shareId: "share-b", granterEmail: "b@x.com" }], declined: [] };

  // A stable generation for tests that aren't exercising round 6's
  // mid-classify session-transition guard.
  const stableGeneration = () => 1;

  it("seeds from the cache on a classify failure (offline / relay error)", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", laneA);
    const result = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: stableGeneration,
      classify: async () => {
        throw new Error("relay unreachable");
      },
    });
    expect(result).toEqual(laneA);
  });

  it("returns empty lanes on failure when nothing was ever cached for this workspace", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    const result = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: stableGeneration,
      classify: async () => {
        throw new Error("relay unreachable");
      },
    });
    expect(result).toEqual({ pending: [], declined: [] });
  });

  it("overwrites the cache on a successful classify, so the NEXT failure falls back to the NEW value", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", laneA);
    const succeeded = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: stableGeneration,
      classify: async () => laneB,
    });
    expect(succeeded).toEqual(laneB);

    const fellBack = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: stableGeneration,
      classify: async () => {
        throw new Error("relay unreachable");
      },
    });
    expect(fellBack).toEqual(laneB);
  });

  it("never records a failed classify's result", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: stableGeneration,
      classify: async () => {
        throw new Error("relay unreachable");
      },
    });
    expect(cache.get("workspace-a")).toBeUndefined();
  });

  // #742 P1 SECURITY (round 4): the cross-account leak this whole cache
  // exists to close. Without clear() at a session transition, a signed-in
  // account's cached rows (sender emails included) would answer for whoever
  // signs in next, the moment their own first poll fails.
  it("clear() removes every workspace's cached lanes, so a session transition can never leak the previous account's rows", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", laneA);
    cache.set("workspace-b", laneB);

    cache.clear();

    expect(
      await classifyDmRequestsWithFallback({
        workspaceId: "workspace-a",
        cache,
        credentialGeneration: stableGeneration,
        classify: async () => {
          throw new Error("no relay yet for the new account");
        },
      }),
    ).toEqual({ pending: [], declined: [] });
    expect(
      await classifyDmRequestsWithFallback({
        workspaceId: "workspace-b",
        cache,
        credentialGeneration: stableGeneration,
        classify: async () => {
          throw new Error("no relay yet for the new account");
        },
      }),
    ).toEqual({ pending: [], declined: [] });
  });

  it("keeps each workspace's cache independent", () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", laneA);
    cache.set("workspace-b", laneB);
    expect(cache.get("workspace-a")).toEqual(laneA);
    expect(cache.get("workspace-b")).toEqual(laneB);
  });

  // #742 P1 SECURITY (round 6): the cache WRITE happens AFTER classify()'s
  // own awaits — a session transition (account switch) can land while an
  // OLD account's classify is still in flight. Without the generation
  // guard, that stale result would repopulate the cache right after the
  // transition just cleared it, silently reopening the round-4/5
  // cross-account leak. This drives the exact sequence: start sync as
  // account A, transition to B mid-await (bump the generation AND clear the
  // cache, exactly as main.ts's clearCachedCredentials does), then resolve
  // A's classify — the cache must stay empty.
  it("drops the cache write if the credential generation changed mid-classify (a session transition raced the poll)", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    let generation = 1; // account A
    let resolveClassify!: (lanes: DmRequestLanes) => void;
    const classifyGate = new Promise<DmRequestLanes>((resolve) => {
      resolveClassify = resolve;
    });
    const resultPromise = classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: () => generation,
      classify: () => classifyGate,
    });

    // The session transitions to account B WHILE classify is still in
    // flight — main.ts's clearCachedCredentials() would run exactly this:
    // bump the generation (a new credential snapshot) and clear the cache.
    generation = 2;
    cache.clear();

    // Account A's classify FINALLY resolves, after the transition.
    resolveClassify(laneA);
    const result = await resultPromise;

    // The stale result is still RETURNED (the caller's own session
    // guard handles a stale IPC response, same as everywhere else) — but
    // the cache write is dropped.
    expect(result).toEqual(laneA);
    expect(cache.get("workspace-a")).toBeUndefined();
  });

  it("still records the write when the generation is unchanged (the common case)", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    const result = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: stableGeneration,
      classify: async () => laneA,
    });
    expect(result).toEqual(laneA);
    expect(cache.get("workspace-a")).toEqual(laneA);
  });
});

// #742 P1 (round 5): the cache's last recorded lanes were classified while
// the DM was still accepted, so an outage right after Leave falls back to
// stale pre-leave lanes that still call the share accepted — the ended row
// would reappear. markLeftInLastKnownLanes closes that gap: leaveDm records
// the leave in the cache itself, without needing the relay at all.
describe("markLeftInLastKnownLanes", () => {
  it("inserts the left share into the cache's pending lane", () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", {
      pending: [],
      declined: [{ shareId: "share-other", granterEmail: null }],
    });
    markLeftInLastKnownLanes(cache, "workspace-a", {
      shareId: "share-left",
      granterEmail: "alice@example.com",
    });
    expect(cache.get("workspace-a")).toEqual({
      pending: [{ shareId: "share-left", granterEmail: "alice@example.com" }],
      declined: [{ shareId: "share-other", granterEmail: null }],
    });
  });

  it("starts from empty lanes when nothing was cached for this workspace yet", () => {
    const cache = createLastKnownDmRequestLanesCache();
    markLeftInLastKnownLanes(cache, "workspace-a", {
      shareId: "share-left",
      granterEmail: "alice@example.com",
    });
    expect(cache.get("workspace-a")).toEqual({
      pending: [{ shareId: "share-left", granterEmail: "alice@example.com" }],
      declined: [],
    });
  });

  it("is idempotent: leaving twice never duplicates the pending row", () => {
    const cache = createLastKnownDmRequestLanesCache();
    const row = { shareId: "share-left", granterEmail: "alice@example.com" };
    markLeftInLastKnownLanes(cache, "workspace-a", row);
    markLeftInLastKnownLanes(cache, "workspace-a", row);
    expect(cache.get("workspace-a")?.pending).toEqual([row]);
  });

  // The real flow the pin describes: leave, then a relay outage — the
  // fallback must serve the conversation as a pending request, not silently
  // keep calling it accepted.
  it("REAL FLOW: leave -> relay rejects on the next poll -> the fallback lanes list the conversation as pending", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    // Before leaving: the DM was accepted, so its shareId was never in any
    // classified lane.
    cache.set("workspace-a", { pending: [], declined: [] });

    // leaveDm's local, relay-free side effect.
    markLeftInLastKnownLanes(cache, "workspace-a", {
      shareId: "share-left",
      granterEmail: "alice@example.com",
    });

    // The very next syncDms poll: the relay rejects.
    const result = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: () => 1,
      classify: async () => {
        throw new Error("relay unreachable");
      },
    });

    expect(result.pending).toEqual([
      { shareId: "share-left", granterEmail: "alice@example.com" },
    ]);
    // Consistent with withholdDmsInRequestLanes (#742 P1-A): the ended row is
    // now withheld from the list, because its shareId IS a pending request.
    const requestShareIds = new Set(
      [...result.pending, ...result.declined].map((row) => row.shareId),
    );
    const endedRow = { shareId: "share-left", channelWireId: "wire-left", connected: false };
    expect(
      withholdDmsInRequestLanes({
        dms: [endedRow],
        requestShareIds,
        holdersByShareId: new Map(),
        holdersByWireId: new Map(),
        workspaceId: "workspace-a",
      }),
    ).toEqual([]);
  });
});
