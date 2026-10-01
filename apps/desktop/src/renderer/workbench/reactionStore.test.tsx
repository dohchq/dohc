// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChatReactionRecord } from "../../ipc/bridgeContract";
import { deferred, type Deferred } from "../../testing/deferred";
import {
  ReactionStoreProvider,
  createReactionStore,
  useReactions,
  type ReactionStore,
} from "./reactionStore";

// The workspace reaction store (WS-MU-C2): one ordered write chain per
// (message, emoji) cell for every surface, one confirmed state built from
// every surface's reads in ticket order, optimistic paint until the server
// answers, and rollback to the newest state the server is known to hold.

const bridgeMock = {
  setChatReaction: vi.fn(),
  listChatReactions: vi.fn(),
};

beforeEach(() => {
  bridgeMock.setChatReaction.mockReset();
  bridgeMock.listChatReactions.mockReset();
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const you = (overrides: Partial<ChatReactionRecord> = {}): ChatReactionRecord => ({
  reactionId: "r-you",
  messageId: "m1",
  threadId: "thread-1",
  emoji: "👍",
  authorId: "you@x",
  authorKind: "human",
  authorDisplayName: "You",
  ...overrides,
});
const peer = you({ reactionId: "r-peer", authorId: "peer@x", authorDisplayName: "Peer" });
const listing = (reactions: ChatReactionRecord[], viewerAuthorId = "you@x") => ({ reactions, viewerAuthorId });
type Listing = ReturnType<typeof listing>;

// One controlled promise per call of the bridge method, in call order.
function controlled<T>(method: Mock) {
  const calls: Deferred<T>[] = [];
  method.mockImplementation(() => {
    const next = deferred<T>();
    calls.push(next);
    return next.promise;
  });
  return calls;
}

// A surface's visit: where its errors go while it is still open.
function visit() {
  let open = true;
  const report = vi.fn();
  return {
    report,
    onError: (message: string, cause?: unknown) => {
      if (open) report(message, cause);
    },
    leave() {
      open = false;
    },
  };
}

// One store, read the way a surface reads thread-1, viewed live.
function setup(initial: ChatReactionRecord[] = [], workspaceId = "ws") {
  const store = createReactionStore(workspaceId);
  let current = visit();
  // A read starts now and lands when the returned function runs.
  const beginRead = (threadId = "thread-1") => {
    const ticket = store.ticket();
    return (reactions: ChatReactionRecord[], viewerAuthorId = "you@x") =>
      store.ingest([{ threadId, reactions, viewerAuthorId, ticket }]);
  };
  const read = (reactions: ChatReactionRecord[], viewerAuthorId = "you@x") =>
    beginRead()(reactions, viewerAuthorId);
  read(initial);
  return {
    store,
    beginRead,
    read,
    // Leave the thread and come back to it with a fresh read.
    reopen(reactions: ChatReactionRecord[], viewerAuthorId = "you@x") {
      current.leave();
      current = visit();
      read(reactions, viewerAuthorId);
    },
    get visit() {
      return current;
    },
    get onError() {
      return current.report;
    },
    get reactions() {
      return store.view("thread-1").reactions;
    },
    get viewerAuthorId() {
      return store.view("thread-1").viewerAuthorId;
    },
    toggle(
      nextState: "added" | "removed",
      cell: { messageId: string; emoji: string } = { messageId: "m1", emoji: "👍" },
      viewerAuthorId = "you@x",
      threadId = "thread-1",
    ) {
      store.toggle({ threadId, ...cell, nextState, viewerAuthorId, onError: current.onError });
    },
    mineOn(emoji: string, messageId = "m1") {
      return store.view("thread-1").reactions.some(
        (row) => row.messageId === messageId && row.emoji === emoji && row.authorId === "you@x",
      );
    },
  };
}

const settled = (store: ReactionStore, messageId = "m1", threadId = "thread-1") =>
  waitFor(() => expect(store.pending(threadId, messageId)).toBe(false));

describe("reaction store: one chain per cell", () => {
  it("rolls a rejected write back to the prior cell state and keeps peers", async () => {
    const h = setup([peer]);
    bridgeMock.setChatReaction.mockRejectedValue(new TypeError("offline"));
    h.toggle("added");
    expect(h.mineOn("👍")).toBe(true);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.onError).toHaveBeenCalledWith("Could not update that reaction.", expect.any(Error));
    expect(h.reactions).toEqual([peer]);
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged write and reports only the reload failure when the listing fails", async () => {
    const h = setup();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("wire"));
    h.toggle("added");
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.onError).toHaveBeenCalledWith(
      "Your reaction was saved, but dohc could not reload reactions.",
      expect.any(Error),
    );
    expect(h.mineOn("👍")).toBe(true);
  });

  it("always says the write saved when reload fails with words for a person", async () => {
    const h = setup();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    bridgeMock.listChatReactions.mockRejectedValue(new Error("The chat thread is no longer available."));
    h.toggle("added");
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.onError.mock.calls[0]![0]).toContain("Your reaction was saved");
    expect(h.mineOn("👍")).toBe(true);
  });

  it("restores the read rows, not the inverse of the last toggle, when repeated toggles fail", async () => {
    const h = setup([peer, you()]);
    bridgeMock.setChatReaction.mockRejectedValue(new TypeError("offline"));
    h.toggle("removed");
    h.toggle("added");
    expect(h.mineOn("👍")).toBe(true);
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.reactions).toEqual([peer, you()]);
  });

  it("rolls a rejected write back to the newest acknowledged intent", async () => {
    const h = setup();
    bridgeMock.setChatReaction
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError("offline"));
    bridgeMock.listChatReactions.mockReturnValue(deferred<never>().promise);
    h.toggle("added");
    h.toggle("removed");
    expect(h.mineOn("👍")).toBe(false);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    // The add reached the server and the remove did not, so the cell shows
    // the add, even though its own listing never answered.
    expect(h.mineOn("👍")).toBe(true);
  });

  it("shows an earlier accepted write, from the listing, when the write after it is rejected", async () => {
    const h = setup();
    const firstWrite = deferred<undefined>();
    bridgeMock.setChatReaction
      .mockReturnValueOnce(firstWrite.promise)
      .mockRejectedValueOnce(new TypeError("offline"));
    bridgeMock.listChatReactions.mockResolvedValue(listing([you()]));
    h.toggle("added");
    h.toggle("removed");
    firstWrite.resolve(undefined);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    await waitFor(() => expect(h.reactions).toEqual([you()]));
  });

  it("sends overlapping toggles on one cell in order and reconciles once", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(listing([peer]));
    h.toggle("added");
    h.toggle("removed");
    expect(h.mineOn("👍")).toBe(false);
    expect(bridgeMock.setChatReaction).toHaveBeenCalledOnce();
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2));
    expect(bridgeMock.setChatReaction).toHaveBeenLastCalledWith(expect.objectContaining({ state: "removed" }));
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
    writes[1]!.resolve(undefined);
    await waitFor(() => expect(h.reactions).toEqual([peer]));
    expect(bridgeMock.listChatReactions).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("sends only the newest waiting intent", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(listing([you()]));
    h.toggle("added");
    h.toggle("removed");
    h.toggle("added");
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.resolve(undefined);
    await settled(h.store);
    expect(bridgeMock.setChatReaction.mock.calls.map(([payload]) => payload.state)).toEqual(["added", "added"]);
    expect(h.mineOn("👍")).toBe(true);
  });

  it("lets a listing that lands after a newer toggle change nothing that toggle chose", async () => {
    const h = setup();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    const listings = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("added");
    await waitFor(() => expect(listings).toHaveLength(1));
    h.toggle("removed");
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(listings).toHaveLength(2));
    // The add's listing lands after the remove was accepted: no revival.
    listings[0]!.resolve(listing([you()]));
    await listings[0]!.promise;
    expect(h.reactions).toEqual([]);
    listings[1]!.resolve(listing([]));
    await settled(h.store);
    expect(h.reactions).toEqual([]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("does not let an older listing erase a newer listing's rows on another cell", async () => {
    const h = setup();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    const listings = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("added", { messageId: "m1", emoji: "👍" });
    h.toggle("added", { messageId: "m2", emoji: "🎉" });
    await waitFor(() => expect(listings).toHaveLength(2));
    const thumbs = you({ reactionId: "r-thumbs" });
    const party = you({ reactionId: "r-party", messageId: "m2", emoji: "🎉" });
    listings[1]!.resolve(listing([thumbs, party]));
    await waitFor(() => expect(h.reactions).toEqual([thumbs, party]));
    // The first cell's listing began earlier, before the party was accepted.
    listings[0]!.resolve(listing([thumbs]));
    await settled(h.store);
    expect(h.reactions).toEqual([thumbs, party]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("names the viewer from the canonical listing, never from the write result", async () => {
    const h = setup();
    bridgeMock.setChatReaction.mockResolvedValue({
      reaction: { ...you({ authorId: "legacy-alias" }), state: "added" },
      viewerAuthorId: "legacy-alias",
    });
    bridgeMock.listChatReactions.mockResolvedValue(listing([you({ authorId: "you@normalized" })], "you@normalized"));
    h.toggle("added");
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    expect(h.reactions).toEqual([you({ authorId: "you@normalized" })]);
  });

  it("keeps different cells, threads, and workspaces independent", async () => {
    const h = setup();
    const other = setup([], "ws-next");
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(listing([]));
    h.beginRead("thread-2")([peer]);
    const untouched = h.store.view("thread-2");
    h.toggle("added");
    h.toggle("added", { messageId: "m1", emoji: "🎉" });
    h.toggle("added", { messageId: "m2", emoji: "👍" });
    other.toggle("added");
    // None waits for another: the same ids in another workspace are another cell.
    expect(writes).toHaveLength(4);
    expect(bridgeMock.setChatReaction.mock.calls.map(([payload]) => payload.workspaceId))
      .toEqual(["ws", "ws", "ws", "ws-next"]);
    expect(h.store.view("thread-2")).toBe(untouched);
    expect(other.reactions.map((row) => row.emoji)).toEqual(["👍"]);
    for (const write of writes) write.resolve(undefined);
    await settled(h.store);
    await settled(other.store);
  });
});

describe("reaction store: one confirmed state from every read", () => {
  it("rolls back to the newest state another surface read, not the toggling surface's older read", async () => {
    // Surface A read the reaction present; surface B read later and found it gone.
    const h = setup([you()]);
    h.read([]);
    expect(h.reactions).toEqual([]);
    const write = deferred<undefined>();
    bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
    h.toggle("removed");
    expect(h.reactions).toEqual([]);
    write.reject(new Error("write refused"));
    await settled(h.store);
    expect(h.reactions).toEqual([]);
  });

  it("rolls a rejected add back to a newer read's presence", async () => {
    const h = setup();
    const write = deferred<undefined>();
    bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
    h.toggle("added");
    // Another surface's read shows the reaction on the server already.
    h.read([you()]);
    expect(h.reactions).toEqual([you()]);
    write.reject(new TypeError("offline"));
    await settled(h.store);
    expect(h.reactions).toEqual([you()]);
  });

  it("keeps a pending paint over a refresh, while peers and other cells refresh", () => {
    const h = setup();
    bridgeMock.setChatReaction.mockReturnValue(deferred<undefined>().promise);
    h.toggle("added");
    const other = you({ reactionId: "r-other", messageId: "m2", authorId: "peer@x" });
    h.read([peer, other]);
    expect(h.reactions.map((row) => row.authorId)).toEqual(["peer@x", "you@x", "peer@x"]);
    expect(h.mineOn("👍")).toBe(true);
  });

  it("does not let a read begun before a write erase it, before or after the write settles", async () => {
    const h = setup();
    const staleBeforeListing = h.beginRead();
    const staleAfterListing = h.beginRead();
    const write = deferred<undefined>();
    const list = deferred<Listing>();
    bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
    bridgeMock.listChatReactions.mockReturnValueOnce(list.promise);
    h.toggle("added");
    write.resolve(undefined);
    await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledOnce());
    staleBeforeListing([]);
    expect(h.mineOn("👍")).toBe(true);
    list.resolve(listing([you()]));
    await settled(h.store);
    staleAfterListing([]);
    expect(h.reactions).toEqual([you()]);
    // A read begun after the write is the newer truth.
    h.read([]);
    expect(h.reactions).toEqual([]);
  });

  it("does not let a read begun before a removal bring the row back", async () => {
    const h = setup([you()]);
    const staleRead = h.beginRead();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const listings = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("removed");
    staleRead([you(), peer]);
    expect(h.reactions).toEqual([peer]);
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(listings).toHaveLength(1));
    expect(h.reactions).toEqual([peer]);
    listings[0]!.resolve(listing([peer]));
    await settled(h.store);
    expect(h.reactions).toEqual([peer]);
  });

  it("lets a preview or Home item answer for its own message only", () => {
    const other = you({ reactionId: "r-other", messageId: "m2", authorId: "peer@x" });
    const h = setup([you(), other]);
    const staleThread = h.beginRead();
    // Home read message m1 and found nothing; it says nothing about m2.
    h.store.ingest([{ threadId: "thread-1", messageIds: ["m1"], reactions: [], ticket: h.store.ticket() }]);
    expect(h.reactions).toEqual([other]);
    expect(h.store.view("thread-1", "m1").reactions).toEqual([]);
    expect(h.store.view("thread-1", "m2").reactions).toEqual([other]);
    // A whole-thread read that began before it cannot undo that message.
    const fresher = you({ reactionId: "r-fresher", messageId: "m2", authorId: "peer@x" });
    staleThread([you(), fresher]);
    expect(h.reactions).toEqual([fresher]);
    // A preview with no opening message covers nothing.
    h.store.ingest([{ threadId: "thread-1", messageIds: [], reactions: [], ticket: h.store.ticket() }]);
    expect(h.reactions).toEqual([fresher]);
  });

  it("tells subscribers nothing for a read that changes nothing, yet still orders later reads by it", () => {
    const h = setup([peer]);
    const listener = vi.fn();
    h.store.subscribe(listener);
    const version = h.store.version();
    const stale = h.beginRead();
    h.read([peer]);
    expect(listener).not.toHaveBeenCalled();
    expect(h.store.version()).toBe(version);
    // The unchanged read is still newer than one that began before it.
    stale([]);
    expect(h.reactions).toEqual([peer]);
    expect(listener).not.toHaveBeenCalled();
    h.read([peer, you()]);
    expect(listener).toHaveBeenCalledOnce();
    h.read([peer, you()], "you@normalized");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns the same view until something in its thread changes", () => {
    const h = setup([peer]);
    bridgeMock.setChatReaction.mockReturnValue(deferred<undefined>().promise);
    const first = h.store.view("thread-1");
    h.read([peer]);
    expect(h.store.view("thread-1")).toBe(first);
    h.toggle("added", undefined, "you@x", "thread-2");
    expect(h.store.view("thread-1")).toBe(first);
    h.toggle("added");
    expect(h.store.view("thread-1")).not.toBe(first);
  });

  it("writes without a paint for an unknown viewer and lets the listing name them", async () => {
    const store = createReactionStore("ws");
    const write = deferred<undefined>();
    const list = deferred<Listing>();
    bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
    bridgeMock.listChatReactions.mockReturnValueOnce(list.promise);
    store.ingest([{ threadId: "thread-1", messageIds: ["m1"], reactions: [], ticket: store.ticket() }]);
    store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "added", viewerAuthorId: "", onError: vi.fn() });
    expect(bridgeMock.setChatReaction).toHaveBeenCalledOnce();
    expect(store.view("thread-1", "m1")).toEqual({ reactions: [], viewerAuthorId: "" });
    expect(store.pending("thread-1", "m1")).toBe(true);
    write.resolve(undefined);
    await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledOnce());
    expect(store.view("thread-1", "m1").reactions).toEqual([]);
    expect(store.pending("thread-1", "m1")).toBe(true);
    list.resolve(listing([you()]));
    await settled(store);
    expect(store.view("thread-1", "m1")).toEqual({ reactions: [you()], viewerAuthorId: "you@x" });
  });

  it("paints the viewer's row under the name the surface gives", () => {
    const store = createReactionStore("ws");
    bridgeMock.setChatReaction.mockReturnValue(deferred<undefined>().promise);
    store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "added", viewerAuthorId: "author-you", viewerLabel: "Ice", onError: vi.fn() });
    expect(store.view("thread-1", "m1").reactions).toEqual([
      expect.objectContaining({ reactionId: "optimistic:m1:👍:author-you", authorId: "author-you", authorDisplayName: "Ice" }),
    ]);
  });

  it("puts the exact read rows back in place when a write fails in the same turn as a refresh", async () => {
    const party = you({ reactionId: "r-party", emoji: "🎉" });
    const h = setup([peer, you(), party]);
    const write = deferred<undefined>();
    bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
    const refresh = h.beginRead();
    h.toggle("removed");
    expect(h.reactions).toEqual([peer, party]);
    write.reject(new Error("ECONNRESET"));
    refresh([peer, you(), party]);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.reactions).toEqual([peer, you(), party]);
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
  });
});

describe("reaction store: visits and accounts", () => {
  it("orders an old visit's queued writes before the newest visit's intent", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(listing([you()]));
    h.toggle("added");
    h.toggle("removed");
    h.reopen([]);
    h.toggle("added");
    expect(writes).toHaveLength(1);
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.resolve(undefined);
    await settled(h.store);
    expect(bridgeMock.setChatReaction.mock.calls.map(([payload]) => payload.state)).toEqual(["added", "added"]);
    expect(h.mineOn("👍")).toBe(true);
  });

  it("reports an old visit's rejection only to that visit, and shows the new visit's read", async () => {
    const h = setup([you()]);
    const oldWrite = deferred<undefined>();
    bridgeMock.setChatReaction
      .mockReturnValueOnce(oldWrite.promise)
      .mockRejectedValueOnce(new TypeError("offline"));
    h.toggle("removed");
    const left = h.visit;
    const reopened = you({ reactionId: "r-reopened" });
    h.reopen([reopened]);
    h.toggle("removed");
    oldWrite.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(left.report).not.toHaveBeenCalled();
    expect(h.reactions).toEqual([reopened]);
  });

  it("keeps untouched viewer reactions aligned when a listing normalizes identity", async () => {
    const other = you({ reactionId: "r-other", messageId: "m2" });
    const h = setup([other]);
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    bridgeMock.listChatReactions.mockResolvedValue(
      listing([you({ authorId: "you@normalized" }), { ...other, authorId: "you@normalized" }], "you@normalized"),
    );
    h.toggle("added");
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    expect(h.reactions).toContainEqual({ ...other, authorId: "you@normalized" });
  });

  it("renames a pending cell's rows and rollback with the viewer, without duplicates", async () => {
    const mine = you({ reactionId: "r-mine", messageId: "m2" });
    const h = setup([mine]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(
      listing([you({ authorId: "you@normalized" }), { ...mine, authorId: "you@normalized" }], "you@normalized"),
    );
    h.toggle("added", { messageId: "m1", emoji: "👍" });
    h.toggle("removed", { messageId: "m2", emoji: "👍" });
    // The first cell's listing renames the viewer while the remove is out.
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    expect(h.reactions).toEqual([you({ authorId: "you@normalized" })]);
    // The remove is rejected: the row comes back under the new name, once.
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.reactions).toEqual([you({ authorId: "you@normalized" }), { ...mine, authorId: "you@normalized" }]);
  });

  it("renames accepted rows on stable-id proof without duplicating a rejected cell", async () => {
    const evidence = you({ reactionId: "r-alias-evidence", messageId: "m3" });
    const h = setup([evidence]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("added");
    h.toggle("added", { messageId: "m2", emoji: "👍" });
    writes[1]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(1));
    h.toggle("removed", { messageId: "m2", emoji: "👍" });
    writes[2]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(2));
    lists[1]!.resolve(listing([
      you({ authorId: "you@normalized" }),
      you({ reactionId: "r-m2", messageId: "m2", authorId: "you@normalized" }),
      { ...evidence, authorId: "you@normalized" },
    ], "you@normalized"));
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    const second = () => h.reactions.filter((row) => row.messageId === "m2");
    expect(second()).toHaveLength(1);
    expect(second()[0]!.authorId).toBe("you@normalized");
    // The second cell's own listing began earlier and changes nothing.
    lists[0]!.resolve(listing([you({ reactionId: "r-m2", messageId: "m2" })]));
    await settled(h.store, "m2");
    expect(second()).toHaveLength(1);
    expect(second()[0]!.authorId).toBe("you@normalized");
  });

  // Main lists a local fallback's rows under the signed-in account, and under
  // the fallback again after sign-out, keeping each row's stable id.
  describe("a fallback name that signs in and back out", () => {
    const fallback = "local-person";
    const account = "alice@example.com";
    const stored = you({ reactionId: "same-stable-id", authorId: fallback });

    function signedOutAgain() {
      const store = createReactionStore("ws");
      const read = (reactions: ChatReactionRecord[], viewerAuthorId: string) =>
        store.ingest([{ threadId: "thread-1", reactions, viewerAuthorId, ticket: store.ticket() }]);
      read([stored], fallback);
      read([{ ...stored, authorId: account }], account);
      const onError = vi.fn();
      const write = deferred<undefined>();
      bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
      store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "removed", viewerAuthorId: account, onError });
      expect(store.view("thread-1").reactions).toEqual([]);
      read([stored], fallback);
      return { store, read, write, onError };
    }

    it("keeps a removal pending under the account off the fallback's row", () => {
      const { store } = signedOutAgain();
      expect(store.view("thread-1")).toEqual({ reactions: [], viewerAuthorId: fallback });
    });

    it("brings the row back under the fallback when the removal is refused", async () => {
      const { store, write, onError } = signedOutAgain();
      write.reject(new TypeError("offline"));
      await settled(store);
      expect(onError).toHaveBeenCalledOnce();
      expect(store.view("thread-1")).toEqual({ reactions: [stored], viewerAuthorId: fallback });
    });

    it("keeps the row off once the removal is accepted, before and after its listing", async () => {
      const { store, write } = signedOutAgain();
      const list = deferred<Listing>();
      bridgeMock.listChatReactions.mockReturnValueOnce(list.promise);
      write.resolve(undefined);
      await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledOnce());
      expect(store.view("thread-1").reactions).toEqual([]);
      list.resolve(listing([], fallback));
      await settled(store);
      expect(store.view("thread-1")).toEqual({ reactions: [], viewerAuthorId: fallback });
    });

    // A Home item for an unreacted message can name the new viewer before any
    // read carries the stable id that proves the rename.
    describe.each([
      { name: "signing in", from: fallback, to: account },
      { name: "signing out", from: account, to: fallback },
    ])("a removal pending across $name, proven only by a later read", ({ from, to }) => {
      const before = you({ reactionId: "same-stable-id", authorId: from });
      const after = { ...before, authorId: to };

      function pendingRemoval() {
        const store = createReactionStore("ws");
        store.ingest([{ threadId: "thread-1", reactions: [before], viewerAuthorId: from, ticket: store.ticket() }]);
        const write = deferred<undefined>();
        bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
        store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "removed", viewerAuthorId: from, onError: vi.fn() });
        return { store, write };
      }

      it("keeps the row off when the proving read comes after the naming one", async () => {
        const { store, write } = pendingRemoval();
        store.ingest([{ threadId: "thread-1", messageIds: ["m2"], reactions: [], viewerAuthorId: to, ticket: store.ticket() }]);
        expect(store.view("thread-1").reactions).toEqual([]);
        store.ingest([{ threadId: "thread-1", reactions: [after], viewerAuthorId: to, ticket: store.ticket() }]);
        expect(store.view("thread-1")).toEqual({ reactions: [], viewerAuthorId: to });
        write.reject(new TypeError("offline"));
        await settled(store);
        expect(store.view("thread-1").reactions).toEqual([after]);
      });

      it("keeps the row off when one page names the viewer before it proves the rename", () => {
        const { store } = pendingRemoval();
        const ticket = store.ticket();
        store.ingest([
          { threadId: "thread-1", messageIds: ["m2"], reactions: [], viewerAuthorId: to, ticket },
          { threadId: "thread-1", messageIds: ["m1"], reactions: [after], viewerAuthorId: to, ticket },
        ]);
        expect(store.view("thread-1")).toEqual({ reactions: [], viewerAuthorId: to });
      });
    });

    it("does not take a pending row as evidence that two names are one person", () => {
      const store = createReactionStore("ws");
      bridgeMock.setChatReaction.mockReturnValueOnce(deferred<undefined>().promise);
      store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "added", viewerAuthorId: fallback, onError: vi.fn() });
      store.ingest([{ threadId: "thread-1", reactions: [], viewerAuthorId: account, ticket: store.ticket() }]);
      expect(store.view("thread-1").reactions.map((row) => row.authorId)).toEqual([fallback]);
    });

    it("does not join another account whose read leaves the account's row where it was", () => {
      const store = createReactionStore("ws");
      const read = (reactions: ChatReactionRecord[], viewerAuthorId: string) =>
        store.ingest([{ threadId: "thread-1", reactions, viewerAuthorId, ticket: store.ticket() }]);
      read([stored], fallback);
      read([{ ...stored, authorId: account }], account);
      read([{ ...stored, authorId: account }], "bob@example.com");
      bridgeMock.setChatReaction.mockReturnValueOnce(deferred<undefined>().promise);
      store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "added", viewerAuthorId: "bob@example.com", onError: vi.fn() });
      expect(store.view("thread-1").reactions.map((row) => row.authorId)).toEqual([account, "bob@example.com"]);
    });

    // R is the fallback's row, listed under the account while signed in. S was
    // stored under the account, so main lists it there even after sign-out.
    describe("beside a row the account itself stored", () => {
      function signedOut(sameCell: boolean) {
        const store = createReactionStore("ws");
        const local = you({ reactionId: "local-id", authorId: fallback });
        const owned = you({ reactionId: "account-id", authorId: account, ...(sameCell ? {} : { messageId: "m2" }) });
        const read = (reactions: ChatReactionRecord[], viewerAuthorId: string) =>
          store.ingest([{ threadId: "thread-1", reactions, viewerAuthorId, ticket: store.ticket() }]);
        read([local], fallback);
        read([{ ...local, authorId: account }, owned], account);
        return { store, read, local, owned };
      }

      it("keeps the account's row under the account after sign-out, on its own cell", () => {
        const { store, read, local, owned } = signedOut(false);
        read([local, owned], fallback);
        expect(store.view("thread-1", "m2")).toEqual({ reactions: [owned], viewerAuthorId: fallback });
        // The fallback's like there is its own, beside the account's.
        bridgeMock.setChatReaction.mockReturnValueOnce(deferred<undefined>().promise);
        store.toggle({ threadId: "thread-1", messageId: "m2", emoji: "👍", nextState: "added", viewerAuthorId: fallback, onError: vi.fn() });
        expect(store.view("thread-1", "m2").reactions.map((row) => row.authorId)).toEqual([account, fallback]);
      });

      it.each(["refused", "accepted"] as const)("removes only the fallback's row when the signed-out removal is %s", async (outcome) => {
        const { store, read, local, owned } = signedOut(true);
        read([local, owned], fallback);
        const write = deferred<undefined>();
        bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
        bridgeMock.listChatReactions.mockResolvedValueOnce(listing([owned], fallback));
        store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "removed", viewerAuthorId: fallback, onError: vi.fn() });
        expect(store.view("thread-1").reactions).toEqual([owned]);
        if (outcome === "refused") write.reject(new TypeError("offline"));
        else write.resolve(undefined);
        await settled(store);
        expect(store.view("thread-1").reactions).toEqual(outcome === "refused" ? [local, owned] : [owned]);
      });

      it("rolls a removal chosen while signed in back to both rows after sign-out", async () => {
        const { store, read, local, owned } = signedOut(true);
        const write = deferred<undefined>();
        bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
        store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "removed", viewerAuthorId: account, onError: vi.fn() });
        read([local, owned], fallback);
        // The account's write covers its own row and the one listed under it.
        expect(store.view("thread-1").reactions).toEqual([]);
        write.reject(new TypeError("offline"));
        await settled(store);
        expect(store.view("thread-1")).toEqual({ reactions: [local, owned], viewerAuthorId: fallback });
      });
    });
  });

  it("keeps a rejected cell aligned when normalization lands before its rollback", async () => {
    const mine = you({ reactionId: "r-second", messageId: "m2" });
    const h = setup([mine]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("added");
    h.toggle("removed", { messageId: "m2", emoji: "👍" });
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(1));
    lists[0]!.resolve(listing([you({ authorId: "you@normalized" }), { ...mine, authorId: "you@normalized" }], "you@normalized"));
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.reactions).toContainEqual({ ...mine, authorId: "you@normalized" });
    expect(h.reactions.filter((row) => row.messageId === "m2")).toHaveLength(1);
  });

  it("keeps a different thread's rollback under its own viewer identity", async () => {
    const h = setup();
    h.beginRead("thread-2")([]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const onError = vi.fn();
    bridgeMock.listChatReactions.mockResolvedValue(listing([you({ authorId: "you@normalized" })], "you@normalized"));
    h.toggle("added");
    const second = (nextState: "added" | "removed") =>
      h.store.toggle({ threadId: "thread-2", messageId: "m2", emoji: "👍", nextState, viewerAuthorId: "you@x", onError });
    second("added");
    second("removed");
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    // The second thread's add lands, but its queued remove does not.
    bridgeMock.listChatReactions.mockReturnValue(deferred<Listing>().promise);
    writes[1]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(3));
    writes[2]!.reject(new TypeError("offline"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const thread2 = h.store.view("thread-2");
    expect(thread2.viewerAuthorId).toBe("you@x");
    expect(thread2.reactions).toHaveLength(1);
    expect(thread2.reactions[0]!.authorId).toBe("you@x");
  });

  it("does not rename a previous account's pending row when canonical rows retain that account", async () => {
    const oldRow = you({ reactionId: "r-old-account", messageId: "m3" });
    const h = setup([oldRow]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("added", { messageId: "m1", emoji: "👍" });
    h.toggle("added", { messageId: "m2", emoji: "👍" });
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(1));
    const second = you({ reactionId: "r-second", messageId: "m2" });
    lists[0]!.resolve(listing([you({ authorId: "next-account" }), second, oldRow], "next-account"));
    await waitFor(() => expect(h.viewerAuthorId).toBe("next-account"));
    expect(h.reactions.find((row) => row.messageId === "m2")?.authorId).toBe("you@x");
    expect(h.reactions).toContainEqual(oldRow);
    writes[1]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(2));
    lists[1]!.resolve(listing([second], "next-account"));
    await settled(h.store, "m2");
  });

  it("preserves a previous account's pending row when both accounts own the same canonical cell", async () => {
    const currentRow = you({ reactionId: "r-current", messageId: "m2", authorId: "next-account" });
    const h = setup([currentRow]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("added");
    h.toggle("added", { messageId: "m2", emoji: "👍" });
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(1));
    const second = you({ reactionId: "r-second", messageId: "m2" });
    lists[0]!.resolve(listing([you({ authorId: "next-account" }), second, currentRow], "next-account"));
    await waitFor(() => expect(h.viewerAuthorId).toBe("next-account"));
    expect(h.reactions.filter((row) => row.messageId === "m2").map((row) => row.authorId).sort())
      .toEqual(["next-account", "you@x"]);
    writes[1]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(2));
    lists[1]!.resolve(listing([second, currentRow], "next-account"));
    await settled(h.store, "m2");
  });

  it("does not infer an alias from an account having no canonical rows yet", async () => {
    const currentRow = you({ reactionId: "r-current", messageId: "m2", authorId: "next-account" });
    const h = setup([you(), currentRow]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("removed");
    h.toggle("added", { messageId: "m2", emoji: "👍" });
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(1));
    lists[0]!.resolve(listing([currentRow], "next-account"));
    await waitFor(() => expect(h.viewerAuthorId).toBe("next-account"));
    expect(h.reactions.filter((row) => row.messageId === "m2").map((row) => row.authorId).sort())
      .toEqual(["next-account", "you@x"]);
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.reactions.filter((row) => row.messageId === "m2")).toEqual([currentRow]);
  });

  it("does not use another account's same-cell row as evidence that an accepted writer is its alias", async () => {
    const currentRow = you({ reactionId: "r-current", messageId: "m2", authorId: "next-account" });
    const h = setup([you(), currentRow]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    h.toggle("removed");
    h.toggle("added", { messageId: "m2", emoji: "👍" });
    writes[1]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(1));
    // Before any read covers the accepted add, it paints under its own author.
    expect(h.reactions.filter((row) => row.messageId === "m2").map((row) => row.authorId).sort())
      .toEqual(["next-account", "you@x"]);
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(lists).toHaveLength(2));
    // A concurrent change removed the old account's add before this later
    // listing. The new account's row proves no alias, so nothing is renamed:
    // the read is simply newer than the add.
    lists[1]!.resolve(listing([currentRow], "next-account"));
    await waitFor(() => expect(h.viewerAuthorId).toBe("next-account"));
    expect(h.reactions).toEqual([currentRow]);
    lists[0]!.resolve(listing([currentRow, you({ messageId: "m2" })], "next-account"));
    await settled(h.store, "m2");
    expect(h.reactions).toEqual([currentRow]);
  });

  it("does not attribute an earlier account's accepted write to a returning account after its write fails", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("offline"));
    h.toggle("added");
    h.reopen([you()], "next-account");
    h.toggle("added", undefined, "next-account");
    expect(writes).toHaveLength(1);
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.reactions).toEqual([you()]);
    expect(h.onError.mock.calls[1]![0]).not.toContain("Your reaction was saved");
  });

  it("keeps accepted account attribution when the viewer changes without a new visit", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("offline"));
    h.toggle("added");
    h.toggle("added", undefined, "next-account");
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.reactions).toHaveLength(1);
    expect(h.reactions[0]!.authorId).toBe("you@x");
    expect(h.onError.mock.calls[1]![0]).not.toContain("Your reaction was saved");
  });

  it.each([false, true])("leaves another account's row alone when both accounts' writes fail, queued=%s", async (queued) => {
    const currentRow = you({ reactionId: "r-current", authorId: "next-account" });
    const h = setup([currentRow]);
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    h.toggle("added");
    if (!queued) {
      writes[0]!.reject(new TypeError("offline"));
      await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    }
    h.toggle("removed", undefined, "next-account");
    if (queued) writes[0]!.reject(new TypeError("offline"));
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.reactions).toEqual([currentRow]);
    await settled(h.store);
  });

  it("keeps an earlier accepted write when returning to the exact same account through another account", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("offline"));
    h.toggle("added");
    h.toggle("added", undefined, "next-account");
    // The returning account's fresh read predates the pending add.
    h.read([]);
    h.toggle("removed");
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.mineOn("👍")).toBe(true);
    expect(h.onError.mock.calls[1]![0]).toContain("Your reaction was saved");
  });

  it("does not take a failed optimistic row as confirmed when the same account returns without a reload", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    h.toggle("added");
    h.toggle("added", undefined, "next-account");
    h.toggle("removed");
    writes[0]!.reject(new TypeError("offline"));
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.reactions).toEqual([]);
    await settled(h.store);
  });

  it("remembers a noncurrent account's accepted write when that account later returns", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("offline"));
    h.toggle("added");
    h.toggle("added", undefined, "next-account");
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    // The add is accepted while the other account's write is out.
    h.toggle("removed");
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(writes).toHaveLength(3));
    writes[2]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(3));
    expect(h.reactions).toHaveLength(1);
    expect(h.mineOn("👍")).toBe(true);
    expect(h.onError.mock.calls[2]![0]).toContain("Your reaction was saved");
    await settled(h.store);
  });

  it("repaints a noncurrent account's accepted write after its queued intent was superseded", async () => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("offline"));
    h.toggle("added");
    h.toggle("removed");
    h.toggle("added", undefined, "next-account");
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    expect(h.reactions).toHaveLength(1);
    expect(h.reactions[0]!.authorId).toBe("you@x");
    expect(h.onError.mock.calls[1]![0]).not.toContain("Your reaction was saved");
    await settled(h.store);
  });

  it.each([
    { name: "only the returning account's rows", reopened: [you({ reactionId: "r-reopened" })], other: false },
    { name: "another account's fresh row too", reopened: [you({ reactionId: "r-reopened" }), you({ reactionId: "r-peer-reopened", authorId: "next-account" })], other: false },
    { name: "another account's later toggle", reopened: [you({ reactionId: "r-reopened" }), you({ reactionId: "r-peer-reopened", authorId: "next-account" })], other: true },
  ])("shows a returned visit's read once every old intent fails: $name", async ({ reopened, other }) => {
    const h = setup();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    h.toggle("added");
    h.toggle("added", undefined, "next-account");
    h.reopen(reopened);
    h.toggle("removed");
    if (other) h.toggle("removed", undefined, "next-account");
    writes[0]!.reject(new TypeError("offline"));
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.reject(new TypeError("offline"));
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.reactions).toEqual(reopened);
    await settled(h.store);
  });
});

// DesktopRoot keeps the owner outside the shell it remounts per workspace.
describe("reaction store: session owner", () => {
  function Consumer(props: { capture: (store: ReactionStore) => void }) {
    props.capture(useReactions());
    return null;
  }

  function mount() {
    let current: ReactionStore | null = null;
    const capture = (store: ReactionStore) => {
      current = store;
    };
    const shell = (workspaceId: string) => (
      <ReactionStoreProvider workspaceId={workspaceId}>
        <Consumer key={workspaceId} capture={capture} />
      </ReactionStoreProvider>
    );
    const view = render(shell("workspace-a"));
    return {
      open: (workspaceId: string) => view.rerender(shell(workspaceId)),
      get store(): ReactionStore {
        if (!current) throw new Error("No store mounted");
        return current;
      },
    };
  }

  const add = (store: ReactionStore, nextState: "added" | "removed", onError = vi.fn()) =>
    act(() =>
      store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState, viewerAuthorId: "you@x", onError }),
    );

  it("keeps a workspace's write order across a return through another workspace", async () => {
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(listing([]));
    const shell = mount();
    const a = shell.store;
    add(a, "added");
    expect(writes).toHaveLength(1);

    shell.open("workspace-b");
    const b = shell.store;
    expect(b).not.toBe(a);
    expect(b.view("thread-1").reactions).toEqual([]);
    expect(b.pending("thread-1", "m1")).toBe(false);

    shell.open("workspace-a");
    expect(shell.store).toBe(a);
    expect(a.view("thread-1").reactions.map((row) => row.authorId)).toEqual(["you@x"]);
    add(a, "removed");
    // The remove waits for the add that is still out.
    expect(writes).toHaveLength(1);
    await act(async () => {
      writes[0]!.resolve(undefined);
      await writes[0]!.promise;
    });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(bridgeMock.setChatReaction.mock.calls.map(([payload]) => [payload.workspaceId, payload.state]))
      .toEqual([["workspace-a", "added"], ["workspace-a", "removed"]]);
    await act(async () => {
      writes[1]!.resolve(undefined);
      await writes[1]!.promise;
    });
    await settled(a);
  });

  // Outside act, React commits a return to A, then runs passive effects in a
  // later task. A settlement in between must already see A as open.
  it("keeps the store it provides when its last write settles as a return to it commits", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    const write = deferred<undefined>();
    bridgeMock.setChatReaction.mockReturnValueOnce(write.promise);
    const committed: ReactionStore[] = [];
    function Shell(props: { onCommit?: () => void }) {
      const store = useReactions();
      useLayoutEffect(() => {
        committed.push(store);
        props.onCommit?.();
      });
      return null;
    }
    const shell = (workspaceId: string, onCommit?: () => void) => (
      <ReactionStoreProvider workspaceId={workspaceId}>
        <Shell key={workspaceId} onCommit={onCommit} />
      </ReactionStoreProvider>
    );
    const root = createRoot(document.createElement("div"));
    const settle = () => write.reject(new TypeError("offline"));
    try {
      root.render(shell("workspace-a"));
      await vi.waitFor(() => expect(committed).toHaveLength(1));
      const a = committed[0]!;
      a.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState: "added", viewerAuthorId: "you@x", onError: vi.fn() });
      root.render(shell("workspace-b"));
      await vi.waitFor(() => expect(committed.at(-1)).not.toBe(a));
      root.render(shell("workspace-a", settle));
      await vi.waitFor(() => expect(committed.at(-1)).toBe(a));
      await vi.waitFor(() => expect(a.pending("thread-1", "m1")).toBe(false));
      // A later root render still finds the same owner.
      const commits = committed.length;
      root.render(shell("workspace-a"));
      await vi.waitFor(() => expect(committed.length).toBeGreaterThan(commits));
      expect(committed.at(-1)).toBe(a);
    } finally {
      root.unmount();
    }
  });

  it("retires a left workspace's store once its work settles, and keeps the open one", async () => {
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    const lists = controlled<Listing>(bridgeMock.listChatReactions);
    const shell = mount();
    const a = shell.store;
    add(a, "added");
    shell.open("workspace-b");
    await act(async () => {
      writes[0]!.resolve(undefined);
      await writes[0]!.promise;
    });
    await waitFor(() => expect(lists).toHaveLength(1));
    // Its listing is still out, so a return finds the same store.
    shell.open("workspace-a");
    expect(shell.store).toBe(a);
    shell.open("workspace-b");
    await act(async () => {
      lists[0]!.resolve(listing([you()]));
      await lists[0]!.promise;
    });
    await settled(a);
    // Settled while away: the next visit starts a new store.
    shell.open("workspace-a");
    const next = shell.store;
    expect(next).not.toBe(a);
    expect(next.view("thread-1").reactions).toEqual([]);
    // The open workspace keeps its store while idle.
    shell.open("workspace-a");
    expect(shell.store).toBe(next);
  });
});
