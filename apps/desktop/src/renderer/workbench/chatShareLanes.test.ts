import { describe, expect, it } from "vitest";
import type { JoinedChannelAnswer } from "../../ipc/bridgeContract";
import { answerLocally, emptyJoinedLaneOrder, planJoinedCommit } from "./chatShareLanes";

// The joined lane's cache, tested where its rules live. Two of them cannot be
// seen from the screen at all: what the cache still holds after a read, and
// how much of it a long session accumulates. That size must be a property of
// the view, so it is pinned here the same way the response size is pinned at
// the IPC handler.

function answer(channelWireId: string): JoinedChannelAnswer {
  return { channelWireId, joined: null };
}

function commit(
  order: ReturnType<typeof emptyJoinedLaneOrder>,
  cache: JoinedChannelAnswer[],
  ticket: number,
  wireIds: readonly string[],
  options: {
    newestForLane?: boolean;
    shown?: readonly string[] | null;
    workspaceId?: string;
  } = {},
): JoinedChannelAnswer[] {
  const write = planJoinedCommit(order, {
    workspaceId: options.workspaceId ?? "workspace-a",
    ticket,
    answers: wireIds.map(answer),
    newestForLane: options.newestForLane ?? true,
    shown: options.shown === undefined ? wireIds : options.shown,
  });
  return write === null ? cache : write.write(cache);
}

describe("planJoinedCommit", () => {
  it("holds one answer per shown channel, however many have ever been shown", () => {
    const order = emptyJoinedLaneOrder();
    let cache: JoinedChannelAnswer[] = [];
    // A long session: every pass shows three channels, and the channel that
    // leaves the view is never shown again — a revoked invitation, a channel
    // another workspace claimed. Without eviction the cache is the history.
    for (let pass = 0; pass < 500; pass += 1) {
      cache = commit(order, cache, pass + 1, [
        `wire-${pass}`,
        `wire-${pass + 1}`,
        `wire-${pass + 2}`,
      ]);
    }
    expect(cache.map((entry) => entry.channelWireId)).toEqual(["wire-499", "wire-500", "wire-501"]);
    expect(order.answeredAt.size).toBe(3);
  });

  it("keeps a channel the view shows that this read did not name", () => {
    const order = emptyJoinedLaneOrder();
    let cache = commit(order, [], 6, ["wire-team", "wire-imported"]);
    // A read issued from the older render names only wire-team, and it carries
    // the newer ticket. Its own scope is not the view: evicting to it takes
    // the answer away from a channel the user is looking at, which locks it.
    cache = commit(order, cache, 7, ["wire-team"], {
      shown: ["wire-team", "wire-imported"],
    });
    expect(cache.map((entry) => entry.channelWireId).sort()).toEqual([
      "wire-imported",
      "wire-team",
    ]);
  });

  it("evicts nothing while the surface cannot say what it shows", () => {
    const order = emptyJoinedLaneOrder();
    let cache = commit(order, [], 1, ["wire-a", "wire-b"]);
    cache = commit(order, cache, 2, ["wire-a"], { shown: null });
    expect(cache.map((entry) => entry.channelWireId).sort()).toEqual(["wire-a", "wire-b"]);
  });

  it("keeps a channel this surface answered itself until a read names it", () => {
    const order = emptyJoinedLaneOrder();
    let cache = commit(order, [], 1, ["wire-team"]);
    // The user creates a channel. Nothing has read it — this surface answered
    // it — and the read already in flight was issued before it existed.
    answerLocally(order, "workspace-a", "wire-new");
    cache = [...cache, answer("wire-new")];

    cache = commit(order, cache, 2, ["wire-team"]);
    expect(cache.map((entry) => entry.channelWireId).sort()).toEqual(["wire-new", "wire-team"]);

    cache = commit(order, cache, 3, ["wire-team", "wire-new"]);
    expect(order.local.size).toBe(0);
    cache = commit(order, cache, 4, ["wire-team"]);
    expect(cache.map((entry) => entry.channelWireId)).toEqual(["wire-team"]);
  });

  it("lets an older response answer a wire the newer claim never covered", () => {
    const order = emptyJoinedLaneOrder();
    let cache = commit(order, [], 7, ["wire-team"]);
    // The overview's own response is older, and it alone knows about the
    // channel a sync just imported. Barring it whole left that channel
    // unanswered, and unanswered locks.
    cache = commit(order, cache, 6, ["wire-team", "wire-imported"], {
      newestForLane: false,
    });
    expect(cache.map((entry) => entry.channelWireId).sort()).toEqual([
      "wire-imported",
      "wire-team",
    ]);
  });

  it("refuses an older response for a wire a newer read already answered", () => {
    const order = emptyJoinedLaneOrder();
    const write = planJoinedCommit(order, {
      workspaceId: "workspace-a",
      ticket: 7,
      answers: [answer("wire-team")],
      newestForLane: true,
      shown: ["wire-team"],
    });
    const cache = write === null ? [] : write.write([]);
    const stale = planJoinedCommit(order, {
      workspaceId: "workspace-a",
      ticket: 6,
      answers: [
        {
          channelWireId: "wire-team",
          joined: {
            shareId: "share-1",
            channelWireId: "wire-team",
            access: "read-only",
            granterEmail: "owner@example.com",
            ended: false,
          },
        },
      ],
      newestForLane: false,
      shown: ["wire-team"],
    });
    expect(stale).toBeNull();
    expect(cache).toEqual([answer("wire-team")]);
  });

  it("forgets what another workspace answered", () => {
    const order = emptyJoinedLaneOrder();
    let cache = commit(order, [], 1, ["wire-a"]);
    // A channel created here and abandoned before any read named it. Its entry
    // is eviction-immune until a read NAMES it, and no read in another
    // workspace ever will.
    answerLocally(order, "workspace-a", "wire-created");

    cache = commit(order, cache, 2, ["wire-b"], { workspaceId: "workspace-b" });
    expect([...order.local]).toEqual([]);
    expect([...order.answeredAt.keys()]).toEqual(["wire-b"]);
    expect(cache.map((entry) => entry.channelWireId)).toEqual(["wire-b"]);
  });

  it("evicts nothing for a response that is not the newest for the lane", () => {
    const order = emptyJoinedLaneOrder();
    let cache = commit(order, [], 5, ["wire-a", "wire-b"]);
    cache = commit(order, cache, 4, ["wire-c"], { newestForLane: false });
    expect(cache.map((entry) => entry.channelWireId).sort()).toEqual([
      "wire-a",
      "wire-b",
      "wire-c",
    ]);
  });
});
