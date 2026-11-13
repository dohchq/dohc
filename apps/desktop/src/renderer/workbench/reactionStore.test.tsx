// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChatReactionRecord } from "../../ipc/bridgeContract";
import { deferred, type Deferred } from "../../testing/deferred";
import { ReactionStoreProvider, createReactionStore, useReactions, type ReactionStore } from "./reactionStore";

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
});

describe("reaction store: visits and accounts", () => {
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

    it("brings the row back under the fallback when the removal is refused", async () => {
      const { store, write, onError } = signedOutAgain();
      write.reject(new TypeError("offline"));
      await settled(store);
      expect(onError).toHaveBeenCalledOnce();
      expect(store.view("thread-1")).toEqual({ reactions: [stored], viewerAuthorId: fallback });
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
    });
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
