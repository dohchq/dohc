import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-contracts/relay";
import {
  createLinkedChatStore,
} from "@dohc/workspace-engine";
import {
  assertSharedChannelWritable,
  createKeyedSerializer,
  joinedSharedChannelForTarget,
  mergeJoinedChannel,
  relayFetchWithTimeout,
  syncJoinedSharedChannels,
} from "./sharedChannels";
import type { JoinedSharedChannel } from "./registryStore";

// MU-C4: the desktop's best-effort refresh pass over joined shared channels.
// The engine client is injected; these tests pin the pass's CONTAINMENT
// contract — one bad share never blocks the others, revocation reports ended,
// a read-only downgrade keeps reads flowing.

const RELAY = { baseUrl: "http://relay.test", token: "token" };

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
});

describe("assertSharedChannelWritable", () => {
  it("rejects writes into a READ-ONLY joined channel before any durable mutation, leaving other channels writable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-shared-channel-gate-"));
    const chats = createLinkedChatStore(root);
    try {
      const team = await chats.createChannel({ workspaceId: "ws-1", name: "team" });
      const teamWire = await chats.getChannelWireId({ workspaceId: "ws-1", channelId: team.id });
      expect(teamWire).not.toBeNull();
      const started = await chats.startChannelThread({
        workspaceId: "ws-1",
        channelId: team.id,
        author: { kind: "human", displayName: "Member" },
        body: "seeded",
      });
      const personal = await chats.createChannel({ workspaceId: "ws-1", name: "personal" });
      const personalThread = await chats.startChannelThread({
        workspaceId: "ws-1",
        channelId: personal.id,
        author: { kind: "human", displayName: "Member" },
        body: "mine",
      });

      const readOnlyRows = [joined({ channelWireId: teamWire!, access: "read-only" })];
      // All three write shapes gate: send/reaction target a THREAD, the
      // composer targets a CHANNEL.
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: started.thread.id },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { channelId: team.id },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // Nothing durable landed: the seeded message is still alone.
      const messages = await chats.listMessages({ workspaceId: "ws-1", threadId: started.thread.id });
      expect(messages).toHaveLength(1);

      // The SAME channel under a read-write grant stays writable…
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: [joined({ channelWireId: teamWire!, access: "read-write" })],
          store: chats,
          target: { threadId: started.thread.id },
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
          target: { threadId: started.thread.id },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // …a plain local channel is unaffected even while a read-only grant
      // exists elsewhere…
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { channelId: personal.id },
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: personalThread.thread.id },
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
          target: { threadId: started.thread.id },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: endedRows,
          store: chats,
          target: { channelId: team.id },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // Nothing durable landed for the ended channel either.
      const afterEnded = await chats.listMessages({
        workspaceId: "ws-1",
        threadId: started.thread.id,
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
    const root = await mkdtemp(join(tmpdir(), "dohc-shared-channel-target-"));
    const chats = createLinkedChatStore(root);
    try {
      const shared = await chats.createChannel({ workspaceId: "ws-1", name: "shared" });
      const sharedWire = await chats.getChannelWireId({
        workspaceId: "ws-1",
        channelId: shared.id,
      });
      expect(sharedWire).not.toBeNull();
      const thread = await chats.startChannelThread({
        workspaceId: "ws-1",
        channelId: shared.id,
        author: { kind: "human", displayName: "Member" },
        body: "seeded",
      });
      const local = await chats.createChannel({ workspaceId: "ws-1", name: "local" });
      const rows = [joined({ channelWireId: sharedWire!, relayUrl: "https://relay.one" })];

      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { channelId: shared.id },
        }),
      ).resolves.toEqual(rows[0]);
      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { threadId: thread.thread.id },
        }),
      ).resolves.toEqual(rows[0]);
      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { channelId: local.id },
        }),
      ).resolves.toBeNull();
    } finally {
      await chats.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
