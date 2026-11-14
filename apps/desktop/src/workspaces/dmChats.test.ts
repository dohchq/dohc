import { rm } from "node:fs/promises";
import { CHATS_METHOD, type Request } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
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

function joined(
  overrides: Partial<JoinedSharedChannel> & { channelWireId: string },
): JoinedSharedChannel {
  return {
    shareId: "share-1",
    access: "read-write",
    granterEmail: "alice@x.com",
    relayUrl: "http://relay.test",
    ...overrides,
    recipientUserId: overrides.recipientUserId ?? "member-1",
  };
}

type ChannelsUpdate = (channels: readonly JoinedSharedChannel[]) => readonly JoinedSharedChannel[];

function registryUpdater(registry: Map<string, JoinedSharedChannel[]>) {
  return vi.fn(async (workspaceId: string, update: ChannelsUpdate) => {
    registry.set(workspaceId, [...update(registry.get(workspaceId) ?? [])]);
  });
}

function workspacesUpdater(
  workspaces: Array<{ workspaceId: string; sharedChannels: JoinedSharedChannel[] }>,
) {
  return vi.fn(async (workspaceId: string, update: ChannelsUpdate) => {
    const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (workspace) workspace.sharedChannels = [...update(workspace.sharedChannels)];
  });
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
    // same 80-char string. This collision is expected and acceptable precisely
    // because DM identity is the recipient set (matchDmChannelByRecipients),
    // never this cosmetic name — the regression that fix locks in.
    const longA = `${"a".repeat(78)}1@example.com`;
    const longB = `${"a".repeat(78)}2@example.com`;
    expect(dmChannelNameFor([longA])).toBe(dmChannelNameFor([longB]));
    // The identity key (the sorted recipient set) does differ — see the
    // matchDmChannelByRecipients suite, which proves the two never dedupe.
    expect([longA]).not.toEqual([longB]);
  });
});

describe("matchDmChannelByRecipients", () => {
  it("reuses a DM only when its live grant recipient set exactly equals the request, ignoring name collisions", () => {
    const longA = `${"a".repeat(78)}1@example.com`;
    const longB = `${"a".repeat(78)}2@example.com`;
    expect(dmChannelNameFor([longA])).toBe(dmChannelNameFor([longB]));

    const channels = [{ id: "c1", wireId: "w1" }];
    const liveGrantEmailsByWire = new Map([["w1", new Set([longA])]]);

    expect(
      matchDmChannelByRecipients({
        recipients: [longB],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBeNull();

    expect(
      matchDmChannelByRecipients({
        recipients: [longA],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBe("c1");
  });

  it("requires the full set to match — a subset or superset is a different DM", () => {
    const channels = [{ id: "c1", wireId: "w1" }];
    const liveGrantEmailsByWire = new Map([["w1", new Set(["a@x.com", "b@x.com"])]]);
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

  it("rolls back this call's grants and rethrows when a later grant fails (no half-granted channel)", async () => {
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
            throw new Error("Your server session changed. Try again.");
          }
        },
      }),
    ).rejects.toThrow("Your server session changed. Try again.");
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
            throw new Error("Your server session changed. Try again.");
          }
        },
        beforeCommit: async () => {
          current = false;
        },
      }),
    ).rejects.toThrow("Your server session changed. Try again.");
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
    // grants we can revoke), not slip through untracked.
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
  it("pages past a filtered prefix and detects kind:dm on the first served op", async () => {
    const pages = new Map<number, ShareLogPage>([
      [0, { ops: [], nextCursor: 1, hasMore: true }],
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
    // A page that can't be fetched (network/relay hiccup) is unknown, never
    // cached as not-dm — otherwise a transient failure would permanently block
    // a real DM from ever auto-joining.
    await expect(peekReceivedGrantKind({ fetchPage: async () => null })).resolves.toBe("unknown");
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
    // channel/thread/message bootstrap. Unknown must not enter the kind cache.
    await expect(peekReceivedGrantKind({ fetchPage })).resolves.toBe("unknown");
    ownerBootstrapVisible = true;
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
    const kindCache = new Map<string, "dm" | "not-dm">([["share-claimed", "dm"]]);
    const peekKind = vi.fn(async (shareId: string) => {
      if (shareId === "share-pending" || shareId === "share-declined") return "dm";
      if (shareId === "share-channel") return "not-dm";
      return "unknown";
    });
    const holdersByShareId = vi.fn(
      () => new Map<string, ReadonlySet<string>>([["share-claimed", new Set(["workspace-a"])]]),
    );
    const input: Parameters<typeof classifyDmRequests>[0] = {
      received: [
        {
          shareId: "share-pending",
          granterEmail: "pending@example.com",
          selector: { kind: "chat", channelWireId: "wire-pending" },
        },
        {
          shareId: "share-declined",
          granterEmail: "declined@example.com",
          selector: { kind: "chat", channelWireId: "wire-declined" },
        },
        { shareId: "share-channel", selector: { kind: "chat", channelWireId: "wire-channel" } },
        { shareId: "share-unknown", selector: { kind: "chat", channelWireId: "wire-unknown" } },
        { shareId: "share-claimed", selector: { kind: "chat", channelWireId: "wire-claimed" } },
      ],
      kindCache,
      peekKind,
      holdersByShareId,
      holdersByWireId: () => new Map<string, ReadonlySet<string>>(),
      declinedShareIds: new Set(["share-declined"]),
    };

    await expect(classifyDmRequests(input)).resolves.toEqual({
      pending: [{ shareId: "share-pending", granterEmail: "pending@example.com" }],
      declined: [{ shareId: "share-declined", granterEmail: "declined@example.com" }],
    });
    expect(peekKind).not.toHaveBeenCalledWith("share-claimed");
    expect(kindCache.has("share-unknown")).toBe(false);
  });

  it("withholds requests when the declined store cannot be read", async () => {
    const received = [
      {
        shareId: "share-pending",
        granterEmail: "pending@example.com",
        selector: { kind: "chat", channelWireId: "wire-pending" },
      },
      {
        shareId: "share-declined",
        granterEmail: "declined@example.com",
        selector: { kind: "chat", channelWireId: "wire-declined" },
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

    await expect(classifyDmRequests({ ...common, declinedShareIds: null })).resolves.toEqual({
      pending: [],
      declined: [],
    });
    expect(peekKind).toHaveBeenCalledTimes(2);

    await expect(
      classifyDmRequests({
        ...common,
        declinedShareIds: new Set(["share-declined"]),
      }),
    ).resolves.toEqual({
      pending: [{ shareId: "share-pending", granterEmail: "pending@example.com" }],
      declined: [{ shareId: "share-declined", granterEmail: "declined@example.com" }],
    });
  });

  it("withholds a re-grant while its wire id is live in another workspace", async () => {
    const input = {
      received: [
        {
          shareId: "share-new",
          granterEmail: "owner@example.com",
          selector: { kind: "chat", channelWireId: "wire-x" },
        },
      ],
      kindCache: new Map<string, "dm" | "not-dm">(),
      peekKind: async () => "dm" as const,
      holdersByShareId: () =>
        new Map<string, ReadonlySet<string>>([["share-old", new Set(["workspace-a"])]]),
      holdersByWireId: () =>
        new Map<string, ReadonlySet<string>>([["wire-x", new Set(["workspace-a"])]]),
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
    const updateSharedChannels = registryUpdater(registry);
    const pull = vi.fn(async () => ({ applied: 1 }));

    await reserveAndPullSharedChannel({
      serverUrl: "HTTPS://ACCOUNTS.TEST:443/",
      relay: { baseUrl: "http://relay.test", token: "token" },
      shareId: "share-c",
      workspaceId: "workspace-c",
      rootPath: "/workspaces/c",
      recipientUserId: "user-c",
      relayUrl: "http://relay.test",
      updateSharedChannels,
      fetchInfo: async () => ({
        shareId: "share-c",
        granterUserId: "granter",
        granterEmail: "granter@example.com",
        channelWireId: "wire-c",
        access: "read-write",
        kind: "chat" as const,
        createdAtMs: 1,
      }),
      pull,
      serialize: async (_workspaceId, run) => await run(),
    });

    expect(updateSharedChannels).toHaveBeenCalledTimes(1);
    expect(updateSharedChannels.mock.calls[0]?.[0]).toBe("workspace-c");
    expect(registry.get("workspace-a")).toEqual([]);
    expect(registry.get("workspace-b")).toEqual([]);
    expect(registry.get("workspace-c")?.[0]?.shareId).toBe("share-c");
    expect(registry.get("workspace-c")?.[0]?.serverUrl).toBe("https://accounts.test");
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
      kind: "chat" as const,
      createdAtMs: 1,
    };
    const fetchResolvers: Array<(value: typeof info) => void> = [];
    const fetchInfo = vi.fn(
      () =>
        new Promise<typeof info>((resolve) => {
          fetchResolvers.push(resolve);
        }),
    );
    const updateSharedChannels = registryUpdater(registry);
    const reserve = (workspaceId: string) =>
      reserveAndPullSharedChannel({
        serverUrl: "HTTPS://ACCOUNTS.TEST:443/",
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId: info.shareId,
        workspaceId,
        rootPath: `/workspaces/${workspaceId}`,
        recipientUserId: "user-1",
        relayUrl: "http://relay.test",
        updateSharedChannels,
        fetchInfo,
        pull: async () => ({ applied: 0 }),
        serialize: async (_candidateId, run) => await run(),
        preWrite: () => {
          const heldElsewhere = [...registry.entries()].some(
            ([candidateId, channels]) =>
              candidateId !== workspaceId &&
              channels.some(
                (channel) => channel.shareId === info.shareId && channel.ended !== true,
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
      channels.some((channel) => channel.shareId === info.shareId && channel.ended !== true),
    );
    expect(holders).toHaveLength(1);
  });

  it("checks other workspaces where a delayed reservation lands, so one wire id gets one live holder", async () => {
    const registry = new Map<string, JoinedSharedChannel[]>([
      ["workspace-a", []],
      ["workspace-b", []],
    ]);
    // Like the registry: the update runs once before the folder's history
    // wait and again, on the channels as they stand, when the row lands.
    const landings: Array<() => void> = [];
    const bothWaiting = Promise.withResolvers<void>();
    const updateSharedChannels = async (workspaceId: string, update: ChannelsUpdate) => {
      update(registry.get(workspaceId) ?? []);
      await new Promise<void>((resolve) => {
        landings.push(resolve);
        if (landings.length === 2) bothWaiting.resolve();
      });
      registry.set(workspaceId, [...update(registry.get(workspaceId) ?? [])]);
    };
    const pulled: string[] = [];
    const reserve = (workspaceId: string, shareId: string) =>
      reserveAndPullSharedChannel({
        serverUrl: "https://accounts.test",
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId,
        workspaceId,
        rootPath: `/workspaces/${workspaceId}`,
        recipientUserId: "user-1",
        relayUrl: "http://relay.test",
        updateSharedChannels,
        fetchInfo: async () => ({
          shareId,
          granterUserId: "granter",
          granterEmail: "granter@example.com",
          channelWireId: "wire-race",
          access: "read-write",
          kind: "chat" as const,
          createdAtMs: 1,
        }),
        pull: async () => {
          pulled.push(workspaceId);
          return { applied: 0 };
        },
        serialize: async (_workspaceId, run) => await run(),
        preWrite: (info) => {
          const holder = otherLiveSharedChannelHolderByWireId({
            workspaces: [...registry].map(([candidateId, sharedChannels]) => ({
              workspaceId: candidateId,
              rootPath: `/workspaces/${candidateId}`,
              sharedChannels,
            })),
            workspaceId,
            channelWireId: info.channelWireId,
          });
          if (holder) throw new Error("wire held elsewhere");
        },
      });

    const first = reserve("workspace-a", "share-old");
    const second = reserve("workspace-b", "share-new");
    await bothWaiting.promise;
    landings[0]!();
    await expect(first).resolves.toMatchObject({ shareId: "share-old" });
    landings[1]!();
    await expect(second).rejects.toThrow("wire held elsewhere");

    expect(registry.get("workspace-b")).toEqual([]);
    expect(pulled).toEqual(["workspace-a"]);
  });

  it("refuses a direct re-grant reservation when its resolved wire id is held elsewhere", async () => {
    const registry = new Map<string, JoinedSharedChannel[]>([
      ["workspace-a", [joined({ shareId: "share-old", channelWireId: "wire-x" })]],
      ["workspace-b", []],
    ]);
    const updateSharedChannels = registryUpdater(registry);
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
        serverUrl: "HTTPS://ACCOUNTS.TEST:443/",
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId: "share-new",
        workspaceId: "workspace-b",
        rootPath: "/workspaces/workspace-b",
        recipientUserId: "user-b",
        relayUrl: "http://relay.test",
        updateSharedChannels,
        fetchInfo: async () => ({
          shareId: "share-new",
          granterUserId: "granter",
          granterEmail: "owner@example.com",
          channelWireId: "wire-x",
          access: "read-write",
          kind: "chat" as const,
          createdAtMs: 1,
        }),
        pull: async () => ({ applied: 0 }),
        serialize: async (_workspaceId, run) => await run(),
        preWrite,
      }),
    ).rejects.toThrow(
      "This conversation already lives in workspace-a. Open that workspace to continue.",
    );
    expect(registry.get("workspace-b")).toEqual([]);
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
          selector: { kind: "chat", channelWireId: "wire-x" },
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

    const updateSharedChannels = workspacesUpdater(workspaces);
    await expect(
      reserveAndPullSharedChannel({
        serverUrl: "HTTPS://ACCOUNTS.TEST:443/",
        relay: { baseUrl: "http://relay.test", token: "token" },
        shareId: "share-new",
        workspaceId: "workspace-b",
        rootPath: "/workspaces/workspace-b",
        recipientUserId: "user-b",
        relayUrl: "http://relay.test",
        updateSharedChannels,
        fetchInfo: async () => ({
          shareId: "share-new",
          granterUserId: "granter",
          granterEmail: "owner@example.com",
          channelWireId: "wire-x",
          access: "read-write",
          kind: "chat" as const,
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
    expect(updateSharedChannels).toHaveBeenCalledOnce();
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
        {
          shareId: "share-x",
          granterEmail: "x@example.com",
          selector: { kind: "chat", channelWireId: "wire-x" },
        },
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
    const registry = new Map([["workspace-a", [ended]]]);
    await reserveAndPullSharedChannel({
      serverUrl: "HTTPS://ACCOUNTS.TEST:443/",
      relay: { baseUrl: "http://relay.test", token: "token" },
      shareId: "share-x",
      workspaceId: "workspace-a",
      rootPath: "/a",
      recipientUserId: "user-a",
      relayUrl: "http://relay.test",
      updateSharedChannels: registryUpdater(registry),
      fetchInfo: async () => ({
        shareId: "share-x",
        granterUserId: "granter",
        granterEmail: "x@example.com",
        channelWireId: "wire-x",
        access: "read-write",
        kind: "chat" as const,
        createdAtMs: 1,
      }),
      pull,
      serialize: async (_workspaceId, run) => await run(),
    });
    expect(registry.get("workspace-a")?.[0]?.ended).toBeUndefined();
    expect(pull).toHaveBeenCalledOnce();
  });

  // Drives the leave control's own reversibility flow end-to-end,
  // starting from a live accepted row (not a pre-fabricated ended fixture)
  // and calling endJoinedChannel — the exact function leaveDm/
  // leaveSharedChannel call — so this proves the new control's mechanism,
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
            selector: { kind: "chat", channelWireId: "wire-live" },
          },
        ],
        kindCache,
        peekKind: async () => "dm",
        holdersByShareId: () => liveSharedChannelHoldersByShareId(workspaces),
        holdersByWireId: () => liveSharedChannelHoldersByWireId(workspaces),
        declinedShareIds: new Set(),
      });

    expect((await classify()).pending).toEqual([]);

    workspaces[0]!.sharedChannels = endJoinedChannel(workspaces[0]!.sharedChannels, "share-live");
    expect(isShareAcceptedInWorkspace(workspaces[0]!.sharedChannels, "share-live")).toBe(false);

    const afterLeave = await classify();
    expect(afterLeave.pending.map((row) => row.shareId)).toEqual(["share-live"]);

    const revived = await reserveAndPullSharedChannel({
      serverUrl: "HTTPS://ACCOUNTS.TEST:443/",
      relay: { baseUrl: "http://relay.test", token: "token" },
      shareId: "share-live",
      workspaceId: "workspace-b",
      rootPath: "/b",
      recipientUserId: "user-b",
      relayUrl: "http://relay.test",
      updateSharedChannels: workspacesUpdater(workspaces),
      fetchInfo: async () => ({
        shareId: "share-live",
        granterUserId: "granter",
        granterEmail: "x@example.com",
        channelWireId: "wire-live",
        access: "read-write",
        kind: "chat" as const,
        createdAtMs: 1,
      }),
      pull: async () => ({ applied: 0 }),
      serialize: async (_workspaceId, run) => await run(),
    });
    expect(revived).toMatchObject({ shareId: "share-live", channelWireId: "wire-live" });
    expect(isShareAcceptedInWorkspace(workspaces[1]!.sharedChannels, "share-live")).toBe(true);
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
    ).rejects.toThrow(/can't be shared as a group/u);

    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "channel-1", name: "Project room", kind: "channel", nowMs: 2 },
    });
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "channel-1", store }),
    ).resolves.toMatchObject({ id: "channel-1" });

    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "agent-1", name: "My agent", kind: "agent", nowMs: 3 },
    });
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "agent-1", store }),
    ).rejects.toThrow(/Only groups can be shared/u);
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
    await seed({
      method: CHATS_METHOD.channelCreate,
      params: { channelId: "dm-aborted", name: "aborted@x.com", kind: "dm", nowMs: 1 },
    });
    expect(await listDmRecords({ workspaceId: WS, store, sharedChannels: [] })).toHaveLength(0);

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
            kind: "chat",
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

    const ended = await listDmRecords({
      workspaceId: WS,
      store,
      sharedChannels: [
        joined({ shareId: "share-1", channelWireId: "owner-channel-1", ended: true }),
      ],
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

  it("leaves the owner-revoked tombstone case alone: no request and no other live holder", () => {
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
      requestShareIds: new Set(),
      holdersByShareId,
      holdersByWireId,
      workspaceId: "workspace-a",
    });
    expect(result).toEqual([]);
  });

  it("does not withhold a live holder held by the same workspace (not 'other')", () => {
    const liveHere = joined({ shareId: "share-y", channelWireId: "wire-y" });
    const workspaces = [{ workspaceId: "workspace-a", rootPath: "/a", sharedChannels: [liveHere] }];
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

  // A re-grant mints a new shareId for the same
  // channelWireId — end in A under share A1, then accept
  // the same conversation elsewhere under a re-granted share B1. A1 itself
  // is never held live by anyone (B holds B1, a different shareId, and A1's
  // grant is revoked so it never re-enters the request lanes either) — the
  // shareId-only checks would both miss this and A's ended A1 row would
  // reappear. Only the wire id, the conversation's real stable identity
  // across the re-grant, catches it.
  it("withholds an ended row via wire identity when a re-grant gave the live holder a different shareId", () => {
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

describe("createLastKnownDmRequestLanesCache / classifyDmRequestsWithFallback", () => {
  const laneA = { pending: [{ shareId: "share-a", granterEmail: "a@x.com" }], declined: [] };
  const laneB = { pending: [{ shareId: "share-b", granterEmail: "b@x.com" }], declined: [] };

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

  it("overwrites the cache on a successful classify, so the next failure falls back to the new value", async () => {
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

    // The session transitions to account B while classify is still in
    // flight — main.ts's clearCachedCredentials() would run exactly this:
    // bump the generation (a new credential snapshot) and clear the cache.
    generation = 2;
    cache.clear();

    resolveClassify(laneA);
    const result = await resultPromise;

    // The stale result is still returned (the caller's own session
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

  it("REAL FLOW: leave -> relay rejects on the next poll -> the fallback lanes list the conversation as pending", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", { pending: [], declined: [] });

    markLeftInLastKnownLanes(cache, "workspace-a", {
      shareId: "share-left",
      granterEmail: "alice@example.com",
    });

    const result = await classifyDmRequestsWithFallback({
      workspaceId: "workspace-a",
      cache,
      credentialGeneration: () => 1,
      classify: async () => {
        throw new Error("relay unreachable");
      },
    });

    expect(result.pending).toEqual([{ shareId: "share-left", granterEmail: "alice@example.com" }]);
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
