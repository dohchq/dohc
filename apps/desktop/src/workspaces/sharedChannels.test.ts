import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-contracts/relay";
import { CHATS_METHOD, ChatsLoopbackEngine, type Request } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  assertSharedChannelWritable,
  createKeyedSerializer,
  endJoinedChannel,
  JoinedSharedChannelLimitError,
  joinedSharedChannelForTarget,
  joinedSharedChannelLimitRefusal,
  mergeJoinedChannel,
  relayFetchWithTimeout,
  syncJoinedSharedChannels,
} from "./sharedChannels";
import {
  ListChatChannelSharesResult,
  ListJoinedSharedChannelsResult,
  MAX_CHAT_CHANNEL_SHARE_ROWS,
} from "../ipc/bridgeContract";
import type { JoinedSharedChannel } from "./registryStore";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { nativeTmpdir } from "./testTemp";

// MU-C4: the desktop's best-effort refresh pass over joined shared channels.
// The engine client is injected; these tests pin the pass's CONTAINMENT
// contract — one bad share never blocks the others, revocation reports ended,
// a read-only downgrade keeps reads flowing.

const RELAY = { baseUrl: "http://relay.test", token: "token" };

async function makeChats(workspaceId: string): Promise<{
  store: ReturnType<typeof createLiveLinkedChatStore>;
  root: string;
  seed: (request: Omit<Request, "id" | "workspace">) => Promise<void>;
}> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-shared-channel-"));
  const loopback = new ChatsLoopbackEngine();
  const client = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request) {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
  const store = createLiveLinkedChatStore({ workspaceId, rootPath: root }, sessions);
  let nextRequestId = 1;
  return {
    store,
    root,
    seed: async (request) => {
      await loopback.sendRequest({ ...request, id: nextRequestId++, workspace: workspaceId });
    },
  };
}

function joined(overrides: Partial<JoinedSharedChannel> = {}): JoinedSharedChannel {
  return {
    shareId: "share-1",
    channelWireId: "wire-1",
    access: "read-write",
    granterEmail: "owner@example.com",
    relayUrl: "http://relay.test",
    ...overrides,
    recipientUserId: overrides.recipientUserId ?? "member-1",
  };
}

function pullResult(applied = 0) {
  return { fetched: applied, applied, skipped: 0, nextCursor: applied };
}

describe("syncJoinedSharedChannels", () => {
  it("pushes then pulls read-write channels and only pulls read-only ones", async () => {
    const calls: string[] = [];
    const push = vi.fn(async (input: { shareId: string }) => {
      calls.push(`push:${input.shareId}`);
      return { pushed: 1 };
    });
    const pull = vi.fn(async (input: { shareId: string }) => {
      calls.push(`pull:${input.shareId}`);
      return pullResult(1);
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined(), joined({ shareId: "share-ro", access: "read-only" })],
      pull,
      push,
    });
    // Push precedes pull per share (local sends land before echoes replay),
    // and the read-only share never attempts an append.
    expect(calls).toEqual(["push:share-1", "pull:share-1", "pull:share-ro"]);
    expect(result).toEqual({ endedShareIds: [], readOnlyShareIds: [], changed: true });
  });

  it("reports a revoked share as ended and keeps syncing the others", async () => {
    const push = vi.fn(async () => ({ pushed: 0 }));
    const pull = vi.fn(async (input: { shareId: string }) => {
      if (input.shareId === "share-revoked") throw new ShareUnavailableError();
      return pullResult(2);
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined({ shareId: "share-revoked" }), joined({ shareId: "share-live" })],
      pull,
      push,
    });
    expect(result.endedShareIds).toEqual(["share-revoked"]);
    expect(result.changed).toBe(true);
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it("treats a read-only refusal on push as a downgrade, not a failure — the pull still runs", async () => {
    const push = vi.fn(async () => {
      throw new SharedChannelReadOnlyError();
    });
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined()],
      pull,
      push,
    });
    expect(result.readOnlyShareIds).toEqual(["share-1"]);
    expect(result.endedShareIds).toEqual([]);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("logs transient failures and never throws (a flaky share can't block the pass)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const push = vi.fn(async (input: { shareId: string }) => {
      if (input.shareId === "share-flaky") throw new Error("ECONNREFUSED");
      return { pushed: 0 };
    });
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined({ shareId: "share-flaky" }), joined({ shareId: "share-ok" })],
      pull,
      push,
    });
    expect(result).toEqual({ endedShareIds: [], readOnlyShareIds: [], changed: false });
    // Only the healthy share pulled; the flaky one logged and moved on.
    expect(pull).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("skips shares already marked ended", async () => {
    const push = vi.fn(async () => ({ pushed: 0 }));
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined({ ended: true })],
      pull,
      push,
    });
    expect(push).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
  });
});

describe("createKeyedSerializer", () => {
  it("serializes runs for the SAME key (a second call waits for the first) and keeps keys independent", async () => {
    const serialize = createKeyedSerializer();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serialize("ws-a", async () => {
      events.push("a1:start");
      await firstGate;
      events.push("a1:end");
    });
    const second = serialize("ws-a", async () => {
      events.push("a2:start");
      events.push("a2:end");
    });
    const other = serialize("ws-b", async () => {
      events.push("b1:start");
      events.push("b1:end");
    });

    // A DIFFERENT key is not blocked by ws-a's in-flight pass.
    await other;
    expect(events).toEqual(["a1:start", "b1:start", "b1:end"]);

    releaseFirst();
    await first;
    await second;
    // The second ws-a pass ran ONLY after the first finished — it queued (so
    // ops journaled after the first pass started still get their own pass),
    // never overlapped.
    expect(events).toEqual(["a1:start", "b1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
  });

  it("keeps serving a key after a run rejects (a failed pass never wedges the queue)", async () => {
    const serialize = createKeyedSerializer();
    await expect(
      serialize("ws-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(serialize("ws-a", async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("relayFetchWithTimeout", () => {
  it("aborts a hung relay fetch after the timeout instead of blocking the caller forever", async () => {
    const hungFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    const fetchWithTimeout = relayFetchWithTimeout(25, hungFetch);
    await expect(fetchWithTimeout("http://relay.test/sync/shares")).rejects.toThrow();
  });

  it("passes fast responses through untouched", async () => {
    const fastFetch: typeof fetch = async () => Response.json({ ok: true });
    const fetchWithTimeout = relayFetchWithTimeout(1000, fastFetch);
    const response = await fetchWithTimeout("http://relay.test/sync/shares");
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("mergeJoinedChannel", () => {
  it("replaces an existing row matching by shareId OR channelWireId — re-joining under a new share never duplicates the channel", async () => {
    const existing = [
      joined({ shareId: "share-old", channelWireId: "wire-1" }),
      joined({ shareId: "share-other", channelWireId: "wire-other" }),
    ];
    // Same channel, NEW share id (revoked + re-granted): the stale row for
    // the wire id is replaced, not duplicated.
    const rejoined = mergeJoinedChannel(
      existing,
      joined({ shareId: "share-new", channelWireId: "wire-1" }),
    );
    expect(rejoined.map((row) => row.shareId)).toEqual(["share-other", "share-new"]);

    // Same share id (plain idempotent re-join) still replaces in place.
    const rejoinedSameShare = mergeJoinedChannel(
      existing,
      joined({ shareId: "share-old", channelWireId: "wire-1", access: "read-only" }),
    );
    expect(rejoinedSameShare.map((row) => row.shareId)).toEqual(["share-other", "share-old"]);
    expect(rejoinedSameShare[1]!.access).toBe("read-only");
  });

  // WHAT JUSTIFIES THE LIMIT.
  //
  // An earlier version of this block claimed to measure representative healthy
  // accounts. It did not: it declared invented account sizes and checked their
  // arithmetic, and its central assumption — one DM per correspondent — is not
  // even the product's shape, because a DM can have several recipients. Codex
  // was right to reject it, and a fabricated fixture is worse than none: it
  // reads as evidence.
  //
  // The live count has one real contract, and this is it. Every sync pass
  // walks the LIVE joined channels and does a pull for each, plus a push for
  // each read-write one — see syncJoinedSharedChannels. So the live count IS
  // the per-pass relay fan-out, which makes the cap a backpressure threshold
  // on that fan-out rather than a limit on user work. AGENTS.md exempts
  // backpressure from the measurement rule and asks it to be justified from
  // its actual contract instead. This pins the contract.
  //
  // The specific number is NOT yet justified by it, and this comment will not
  // pretend otherwise. Tracked with the total-retention gap; both resolve by
  // scoping the lane rather than by choosing a better constant.
  describe("the live count is the per-pass relay fan-out", () => {
    it("does one pull per live channel and none for a tombstone", async () => {
      const pulls: string[] = [];
      const pushes: string[] = [];
      const channels = [
        joined({ shareId: "live-rw-1", channelWireId: "wire-1" }),
        joined({ shareId: "live-rw-2", channelWireId: "wire-2" }),
        joined({ shareId: "live-ro", channelWireId: "wire-3", access: "read-only" }),
        joined({ shareId: "tombstone", channelWireId: "wire-4", ended: true }),
      ];
      await syncJoinedSharedChannels({
        rootDir: "/tmp/ws",
        workspaceId: "ws-1",
        relay: RELAY,
        channels,
        pull: async (input) => {
          pulls.push(input.shareId);
          return pullResult(0);
        },
        push: async (input) => {
          pushes.push(input.shareId);
          return { pushed: 0 };
        },
      });
      const live = channels.filter((channel) => channel.ended !== true);
      // One pull per live row — the relationship the cap throttles.
      expect(pulls).toHaveLength(live.length);
      expect(pulls).not.toContain("tombstone");
      // And a push for each live read-write row, so the fan-out is bounded by
      // the live count, never by the total.
      expect(pushes).toEqual(["live-rw-1", "live-rw-2"]);
      expect(pulls.length + pushes.length).toBeGreaterThan(live.length);
    });
  });

  function fullLane() {
    return Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS }, (_, index) =>
      joined({ shareId: `share-${index}`, channelWireId: `wire-${index}` }),
    );
  }
  const newcomer = { shareId: "share-new", channelWireId: "wire-new" };

  it("refuses a join that would grow the lane past the limit, naming the limit", () => {
    const full = fullLane();
    // At the limit, one more row is one too many.
    expect(() => mergeJoinedChannel(full, joined(newcomer))).toThrow(
      JoinedSharedChannelLimitError,
    );
    // The refusal names the constraint, the observed count, the configured
    // limit, its unit, and a recovery — nothing else reports it.
    const message = `This workspace has ${MAX_CHAT_CHANNEL_SHARE_ROWS} shared chat channels; the limit is ${MAX_CHAT_CHANNEL_SHARE_ROWS}. Leave a shared channel, then join this one.`;
    expect(joinedSharedChannelLimitRefusal(full, newcomer)).toBe(message);
    expect(() => mergeJoinedChannel(full, joined(newcomer))).toThrow(message);
  });

  // #617 codex P2: the refusal above prescribes leaving a channel, and
  // leaving only marks the row ended. If ended rows kept their place in the
  // budget the instruction would be false — the lane would stay full for
  // good. The recovery it names has to work.
  it("frees capacity when the user leaves a channel, which is what the refusal tells them to do", () => {
    const full = fullLane();
    expect(joinedSharedChannelLimitRefusal(full, newcomer)).not.toBeNull();

    const afterLeave = endJoinedChannel(full, "share-3");
    // Nothing was deleted — the tombstone still gates writes into share-3.
    expect(afterLeave).toHaveLength(MAX_CHAT_CHANNEL_SHARE_ROWS);
    expect(afterLeave.find((row) => row.shareId === "share-3")?.ended).toBe(true);
    // And the join it refused now fits.
    expect(joinedSharedChannelLimitRefusal(afterLeave, newcomer)).toBeNull();
    const merged = mergeJoinedChannel(afterLeave, joined(newcomer));
    expect(merged).toHaveLength(MAX_CHAT_CHANNEL_SHARE_ROWS + 1);
    expect(merged.filter((row) => row.ended !== true)).toHaveLength(
      MAX_CHAT_CHANNEL_SHARE_ROWS,
    );
  });

  // The pre-flight check exists so both join paths can refuse BEFORE they
  // pull the share's log and claim its DM home. It must answer from registry
  // rows alone, and it must agree with the merge in both directions.
  it("answers the same refusal the merge would raise, from the rows alone", () => {
    const full = fullLane();
    expect(joinedSharedChannelLimitRefusal(full, newcomer)).not.toBeNull();
    // A re-join replaces a row, so it never grows the live set.
    expect(
      joinedSharedChannelLimitRefusal(full, {
        shareId: "share-7",
        channelWireId: "wire-7",
      }),
    ).toBeNull();
    // A lane of pure tombstones consumes no budget at all.
    const tombstones = full.map((row) => ({ ...row, ended: true }));
    expect(joinedSharedChannelLimitRefusal(tombstones, newcomer)).toBeNull();
    expect(() => mergeJoinedChannel(tombstones, joined(newcomer))).not.toThrow();
  });

  // A lane an earlier build already grew past the limit must stay repairable:
  // a re-join replaces a row, so it never grows the lane, and refusing it
  // would strand the account with rows it can no longer correct.
  it("still repairs a row in an over-limit lane, because replacing one does not grow it", () => {
    const over = Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }, (_, index) =>
      joined({ shareId: `share-${index}`, channelWireId: `wire-${index}` }),
    );
    expect(
      joinedSharedChannelLimitRefusal(over, {
        shareId: "share-7",
        channelWireId: "wire-7",
      }),
    ).toBeNull();
    const repaired = mergeJoinedChannel(
      over,
      joined({ shareId: "share-7", channelWireId: "wire-7", access: "read-only" }),
    );
    expect(repaired).toHaveLength(MAX_CHAT_CHANNEL_SHARE_ROWS + 1);
    expect(repaired[repaired.length - 1]!.access).toBe("read-only");
    // And it still refuses to grow it further.
    expect(() =>
      mergeJoinedChannel(over, joined({ shareId: "share-new", channelWireId: "wire-new" })),
    ).toThrow(JoinedSharedChannelLimitError);
  });

  // The row cap the relay lanes enforce must never be able to reject the
  // JOINED lane: these rows decide channelIsLocked, so a listing that refuses
  // them locks every channel read-only, and the count only grows (#617).
  it("lists an over-limit joined lane instead of rejecting the whole listing", () => {
    const over = Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }, (_, index) => ({
      shareId: `share-${index}`,
      channelWireId: `wire-${index}`,
      access: "read-write" as const,
      granterEmail: null,
      ended: false,
    }));
    expect(() =>
      ListChatChannelSharesResult.parse({
        joined: over,
        sessionKey: "https://relay.example||user-1",
        relay: { state: "answered", granted: [], received: [] },
      }),
    ).not.toThrow();
    expect(() => ListJoinedSharedChannelsResult.parse({ joined: over })).not.toThrow();
  });
});

// #617 codex round 3: there is deliberately NO release helper. A pull is
// multi-page and durable, so a failure proves nothing about what landed, and a
// row removed under landed data is a channel that reads as locally owned. The
// reservation stays; syncJoinedSharedChannels finishes it or ends it.
describe("a failed join keeps its reservation", () => {
  it("leaves the row in place so the write gate still covers the channel", () => {
    const reserved = mergeJoinedChannel(
      [joined({ shareId: "share-old", channelWireId: "wire-old" })],
      joined({ shareId: "share-new", channelWireId: "wire-new", access: "read-only" }),
    );
    // The row a failed pull leaves behind is still a row: read-only, so
    // assertSharedChannelWritable refuses writes into it.
    const row = reserved.find((entry) => entry.shareId === "share-new");
    expect(row?.access).toBe("read-only");
    expect(row?.ended).toBeUndefined();
    // And it is live, so the next sync pass pulls it again rather than
    // stranding it.
    expect(reserved.filter((entry) => entry.ended !== true)).toHaveLength(2);
  });

  // The case codex named: a rejoin whose merge displaced an ended tombstone.
  // Removing the new row would erase that tombstone too and leave the wire
  // ungated — strictly worse than never having touched it.
  it("never leaves a wire that had a tombstone with no row at all", () => {
    const tombstone = joined({
      shareId: "share-revoked",
      channelWireId: "wire-1",
      ended: true,
    });
    const rejoined = mergeJoinedChannel(
      [tombstone],
      joined({ shareId: "share-regranted", channelWireId: "wire-1" }),
    );
    expect(rejoined).toHaveLength(1);
    // Whatever happens to the pull, SOME row still answers for wire-1.
    expect(rejoined.filter((entry) => entry.channelWireId === "wire-1")).toHaveLength(1);
  });
});

describe("endJoinedChannel", () => {
  it("keeps an ended provenance tombstone instead of deleting the joined row", () => {
    const existing = [
      joined({ shareId: "share-leave", channelWireId: "wire-leave" }),
      joined({ shareId: "share-other", channelWireId: "wire-other" }),
    ];

    const ended = endJoinedChannel(existing, "share-leave");

    expect(ended).toEqual([
      joined({ shareId: "share-leave", channelWireId: "wire-leave", ended: true }),
      joined({ shareId: "share-other", channelWireId: "wire-other" }),
    ]);
  });
});

describe("assertSharedChannelWritable", () => {
  it("rejects writes into a READ-ONLY joined channel before any durable mutation, leaving other channels writable", async () => {
    const { store: chats, root, seed } = await makeChats("ws-1");
    try {
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "team", name: "team", kind: "channel", nowMs: 1 },
      });
      const teamWire = await chats.getChannelWireId({ workspaceId: "ws-1", channelId: "team" });
      expect(teamWire).not.toBeNull();
      await seed({
        method: CHATS_METHOD.threadStart,
        idempotencyKey: "team-thread:team-message",
        params: {
          channelId: "team",
          threadId: "team-thread",
          messageId: "team-message",
          authorKind: "human",
          authorDisplayName: "Member",
          body: "seeded",
          nowMs: 2,
        },
      });
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "personal", name: "personal", kind: "channel", nowMs: 3 },
      });
      await seed({
        method: CHATS_METHOD.threadStart,
        idempotencyKey: "personal-thread:personal-message",
        params: {
          channelId: "personal",
          threadId: "personal-thread",
          messageId: "personal-message",
          authorKind: "human",
          authorDisplayName: "Member",
          body: "mine",
          nowMs: 4,
        },
      });

      const readOnlyRows = [joined({ channelWireId: teamWire!, access: "read-only" })];
      // All three write shapes gate: send/reaction target a THREAD, the
      // composer targets a CHANNEL.
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { channelId: "team" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // Nothing durable landed: the seeded message is still alone.
      const messages = await chats.listMessages({ workspaceId: "ws-1", threadId: "team-thread" });
      expect(messages).toHaveLength(1);

      // The SAME channel under a read-write grant stays writable…
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: [joined({ channelWireId: teamWire!, access: "read-write" })],
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: [
            joined({
              shareId: "share-active",
              channelWireId: teamWire!,
              access: "read-write",
            }),
            joined({
              shareId: "share-ended",
              channelWireId: teamWire!,
              access: "read-write",
              ended: true,
            }),
          ],
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // …a plain local channel is unaffected even while a read-only grant
      // exists elsewhere…
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { channelId: "personal" },
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: "personal-thread" },
        }),
      ).resolves.toBeUndefined();
      // …and an unknown thread is not this gate's problem (the store's own
      // write path fails it honestly).
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: "thread-missing" },
        }),
      ).resolves.toBeUndefined();

      // An ENDED grant rejects writes even when its recorded access is
      // read-write (revocation → "ended means read-only local copy"): the
      // renderer skipping ended composers is honesty, not authorization.
      const endedRows = [joined({ channelWireId: teamWire!, access: "read-write", ended: true })];
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: endedRows,
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: endedRows,
          store: chats,
          target: { channelId: "team" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // Nothing durable landed for the ended channel either.
      const afterEnded = await chats.listMessages({
        workspaceId: "ws-1",
        threadId: "team-thread",
      });
      expect(afterEnded).toHaveLength(1);
    } finally {
      await chats.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("joinedSharedChannelForTarget", () => {
  it("resolves a joined channel by channel or thread and ignores local channels", async () => {
    const { store: chats, root, seed } = await makeChats("ws-1");
    try {
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "shared", name: "shared", kind: "channel", nowMs: 1 },
      });
      const sharedWire = await chats.getChannelWireId({
        workspaceId: "ws-1",
        channelId: "shared",
      });
      expect(sharedWire).not.toBeNull();
      await seed({
        method: CHATS_METHOD.threadStart,
        idempotencyKey: "shared-thread:shared-message",
        params: {
          channelId: "shared",
          threadId: "shared-thread",
          messageId: "shared-message",
          authorKind: "human",
          authorDisplayName: "Member",
          body: "seeded",
          nowMs: 2,
        },
      });
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "local", name: "local", kind: "channel", nowMs: 3 },
      });
      const rows = [joined({ channelWireId: sharedWire!, relayUrl: "https://relay.one" })];

      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { channelId: "shared" },
        }),
      ).resolves.toEqual(rows[0]);
      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { threadId: "shared-thread" },
        }),
      ).resolves.toEqual(rows[0]);
      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { channelId: "local" },
        }),
      ).resolves.toBeNull();
    } finally {
      await chats.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
