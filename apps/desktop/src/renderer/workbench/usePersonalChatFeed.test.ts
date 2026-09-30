// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatReactionRecord } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { usePersonalChatFeed } from "./usePersonalChatFeed";

const bridgeMock = {
  listPersonalChatFeed: vi.fn(),
  markPersonalChatFeedSeen: vi.fn(),
  setChatReaction: vi.fn(),
  listChatReactions: vi.fn(),
};

function row(overrides: Partial<ChatReactionRecord> = {}): ChatReactionRecord {
  return {
    reactionId: "reaction-mine",
    messageId: "message-1",
    threadId: "thread-1",
    emoji: "👍",
    authorId: "author-you",
    authorKind: "human",
    authorDisplayName: "Ice",
    ...overrides,
  };
}

// The fields the hook reads. Main's items carry more; the hook passes them through.
function item(id: string, reactions: ChatReactionRecord[] = []) {
  return {
    message: { id, threadId: "thread-1", authorKind: "human", authorDisplayName: "You", body: id, createdAtMs: 1 },
    thread: { id: "thread-1", title: "Thread", createdAtMs: 1, updatedAtMs: 1 },
    reactions,
    viewerAuthorId: "author-you",
    matchedBy: ["channel"],
  };
}

const written = { reaction: { ...row(), state: "added" }, viewerAuthorId: "author-you" };
const listed = { reactions: [row()], viewerAuthorId: "author-you" };

// Every answer the hook waits on is a promise the test settles inside act,
// so each intermediate state is observed while it is still pending.
function answer<T>() {
  const pending = deferred<T>();
  return {
    promise: pending.promise,
    resolve: (value: T) => act(async () => { pending.resolve(value); await pending.promise; }),
    reject: (error: unknown) => act(async () => { pending.reject(error); await pending.promise.catch(() => undefined); }),
  };
}

function setup() {
  const liveToken = { current: 0 };
  const onError = vi.fn();
  const hook = renderHook(() =>
    usePersonalChatFeed({ workspaceId: "workspace-a", liveToken, onError }),
  );
  const toggle = (overrides: Partial<Parameters<typeof hook.result.current.toggleMessageReaction>[0]> = {}) =>
    act(() =>
      hook.result.current.toggleMessageReaction({
        threadId: "thread-1",
        messageId: "message-1",
        emoji: "👍",
        nextState: "added",
        viewerAuthorId: "author-you",
        viewerLabel: "Ice",
        ...overrides,
      }),
    );
  return { ...hook, liveToken, onError, toggle };
}

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.markPersonalChatFeedSeen.mockResolvedValue({});
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePersonalChatFeed reactions", () => {
  it("paints the viewer's row under the viewer's name, never the raw id", async () => {
    const write = answer<unknown>();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [item("message-1")] });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    const { result, toggle } = setup();
    await act(() => result.current.loadPersonalFeed());

    await toggle();
    expect(result.current.personalFeed[0]?.reactions).toEqual([
      expect.objectContaining({
        reactionId: "optimistic:message-1:👍:author-you",
        authorId: "author-you",
        authorDisplayName: "Ice",
      }),
    ]);
    expect(result.current.personalFeed[0]?.viewerAuthorId).toBe("author-you");
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
  });

  it("puts the exact prior rows back in place when the write fails, leaving peers and other emoji alone", async () => {
    const write = answer<unknown>();
    const peerFirst = row({ reactionId: "reaction-peer", authorId: "author-peer", authorDisplayName: "Peer" });
    const mine = row();
    const mineParty = row({ reactionId: "reaction-party", emoji: "🎉" });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [item("message-1", [peerFirst, mine, mineParty])] });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    const { result, toggle, onError } = setup();
    await act(() => result.current.loadPersonalFeed());

    await toggle({ nextState: "removed" });
    expect(result.current.personalFeed[0]?.reactions).toEqual([peerFirst, mineParty]);

    await write.reject(new Error("ECONNRESET"));
    const restored = result.current.personalFeed[0]?.reactions ?? [];
    expect(restored).toEqual([peerFirst, mine, mineParty]);
    expect(restored[1]).toBe(mine);
    expect(onError).toHaveBeenCalledWith("Could not update that reaction.", expect.any(Error));
    await waitFor(() => expect(result.current.pendingReactionMessageIds.size).toBe(0));
  });

  it("holds one pending write per message and rests only that message", async () => {
    const writeA = answer<unknown>();
    const writeB = answer<unknown>();
    const listingA = answer<unknown>();
    const listingB = answer<unknown>();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [item("message-1"), item("message-2")] });
    bridgeMock.setChatReaction
      .mockImplementationOnce(() => writeA.promise)
      .mockImplementationOnce(() => writeB.promise);
    bridgeMock.listChatReactions
      .mockImplementationOnce(() => listingB.promise)
      .mockImplementationOnce(() => listingA.promise);
    const { result, toggle } = setup();
    await act(() => result.current.loadPersonalFeed());

    await toggle();
    await toggle({ emoji: "🎉" });
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(1);
    expect([...result.current.pendingReactionMessageIds]).toEqual(["message-1"]);

    await toggle({ messageId: "message-2" });
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
    expect([...result.current.pendingReactionMessageIds]).toEqual(["message-1", "message-2"]);

    await writeB.resolve(written);
    await listingB.resolve({ reactions: [row({ messageId: "message-2" })], viewerAuthorId: "author-you" });
    await waitFor(() => expect([...result.current.pendingReactionMessageIds]).toEqual(["message-1"]));
    expect(result.current.personalFeed[1]?.reactions).toEqual([row({ messageId: "message-2" })]);
    expect(result.current.personalFeed[0]?.reactions).toEqual([
      expect.objectContaining({ reactionId: "optimistic:message-1:👍:author-you" }),
    ]);

    await writeA.resolve(written);
    await listingA.resolve(listed);
    await waitFor(() => expect(result.current.pendingReactionMessageIds.size).toBe(0));
    expect(result.current.personalFeed[0]?.reactions).toEqual([row()]);
  });

  it("reads an older page again when it began before the write was acknowledged", async () => {
    const olderRead = answer<unknown>();
    const restart = answer<unknown>();
    const write = answer<unknown>();
    const listing = answer<unknown>();
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({ items: [item("message-1")], nextCursor: "older" })
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => restart.promise);
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockImplementationOnce(() => listing.promise);
    const { result, toggle } = setup();
    await act(() => result.current.loadPersonalFeed());
    act(() => void result.current.loadPersonalFeed("older"));
    expect(result.current.personalFeedLoading).toBe(true);

    await toggle();
    await write.resolve(written);
    expect(bridgeMock.listPersonalChatFeed).toHaveBeenCalledTimes(3);
    expect(bridgeMock.listPersonalChatFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "older" }),
    );
    expect(result.current.personalFeedLoading).toBe(true);

    await restart.resolve({ items: [item("message-2")] });
    expect(result.current.personalFeed.map((entry) => entry.message.id)).toEqual(["message-1", "message-2"]);
    expect(result.current.personalFeedLoading).toBe(false);
    await listing.resolve(listed);
    expect(result.current.personalFeed[0]?.reactions).toEqual([row()]);

    // The pre-write page lands last and changes nothing.
    await olderRead.resolve({ items: [item("message-stale")] });
    expect(result.current.personalFeed.map((entry) => entry.message.id)).toEqual(["message-1", "message-2"]);
    expect(result.current.personalFeed[0]?.reactions).toEqual([row()]);
    expect(result.current.personalFeedLoading).toBe(false);
    await waitFor(() => expect(result.current.pendingReactionMessageIds.size).toBe(0));
  });

  it("keeps the pending cell on a page that lands mid-write, and clears claims on a fresh open", async () => {
    const write = answer<unknown>();
    const refresh = answer<unknown>();
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({ items: [item("message-1")] })
      .mockImplementationOnce(() => refresh.promise);
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    const { result, toggle, liveToken } = setup();
    await act(() => result.current.loadPersonalFeed());

    await toggle();
    act(() => void result.current.loadPersonalFeed());
    await refresh.resolve({ items: [item("message-1")] });
    expect(result.current.personalFeed[0]?.reactions).toEqual([
      expect.objectContaining({ reactionId: "optimistic:message-1:👍:author-you" }),
    ]);

    liveToken.current += 1;
    act(() => result.current.prepareOpen());
    expect(result.current.pendingReactionMessageIds.size).toBe(0);
    expect(result.current.personalFeed).toEqual([]);
  });

  it("writes without a paint when the item names no viewer, and lets the listing name them", async () => {
    const write = answer<unknown>();
    const listing = answer<unknown>();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [{ ...item("message-1"), viewerAuthorId: undefined }],
    });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockImplementationOnce(() => listing.promise);
    const { result, toggle } = setup();
    await act(() => result.current.loadPersonalFeed());

    await toggle({ viewerAuthorId: undefined });
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(1);
    expect(result.current.personalFeed[0]?.reactions).toEqual([]);
    expect(result.current.pendingReactionMessageIds.has("message-1")).toBe(true);

    await write.resolve(written);
    expect(result.current.personalFeed[0]?.reactions).toEqual([]);
    await listing.resolve(listed);
    expect(result.current.personalFeed[0]?.reactions).toEqual([row()]);
    expect(result.current.personalFeed[0]?.viewerAuthorId).toBe("author-you");
    await waitFor(() => expect(result.current.pendingReactionMessageIds.size).toBe(0));
  });
});
