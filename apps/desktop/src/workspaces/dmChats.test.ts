import { rm } from "node:fs/promises";
import { CHATS_METHOD, type Request } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  peekReceivedGrantKind,
  requireShareableChatChannel,
  resolveDmKinds,
  shareIdsToWithholdFromOrdinaryInvites,
  type ShareLogPage,
} from "./dmChats";
import {
  otherLiveSharedChannelHolderByWireId,
  reserveAndPullSharedChannel,
} from "./sharedChannelHolders";
import type { JoinedSharedChannel } from "./registryStore";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { createTestScratch } from "./testTemp";

// What is left of the workspace-channel DM: telling a received kind:"dm"
// grant apart from a Group, refusing to share one as a Group, and the
// reservation that gives one wire id a single live holder across workspaces.

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

    // First poll: the grant exists, but the owner has not pushed its
    // channel/thread/message bootstrap. Unknown must not enter the kind cache.
    await expect(peekReceivedGrantKind({ fetchPage })).resolves.toBe("unknown");
    ownerBootstrapVisible = true;
    // A later poll sees the immutable create.
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

describe("reserveAndPullSharedChannel", () => {
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
