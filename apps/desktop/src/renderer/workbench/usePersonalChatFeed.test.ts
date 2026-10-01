// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatReactionRecord } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { createReactionStore } from "./reactionStore";
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

// Home pages and the workspace's reaction store together, the way the
// Chats view renders an item: its page is ingested, its message is viewed.
function setup() {
  const store = createReactionStore("workspace-a");
  const liveToken = { current: 0 };
  const onError = vi.fn();
  const hook = renderHook(() =>
    usePersonalChatFeed({ workspaceId: "workspace-a", liveToken, reactions: store, onError }),
  );
  const shown = (index = 0) => {
    const entry = hook.result.current.personalFeed[index]!;
    return store.view(entry.thread.id, entry.message.id).reactions;
  };
  const like = () =>
    act(() =>
      store.toggle({
        threadId: "thread-1",
        messageId: "message-1",
        emoji: "👍",
        nextState: "added",
        viewerAuthorId: "author-you",
        viewerLabel: "Ice",
        onError,
      }),
    );
  return { ...hook, store, liveToken, onError, shown, like };
}

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.markPersonalChatFeedSeen.mockResolvedValue({});
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePersonalChatFeed with the reaction store", () => {
  it("keeps the pending like on a page that lands mid-write", async () => {
    const refresh = deferred<unknown>();
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({ items: [item("message-1")] })
      .mockImplementationOnce(() => refresh.promise);
    bridgeMock.setChatReaction.mockReturnValue(deferred<unknown>().promise);
    const { result, shown, like } = setup();
    await act(() => result.current.loadPersonalFeed());

    await like();
    act(() => void result.current.loadPersonalFeed());
    await act(async () => {
      refresh.resolve({ items: [item("message-1", [row({ reactionId: "reaction-peer", authorId: "author-peer" })])] });
      await refresh.promise;
    });
    expect(shown().map((reaction) => [reaction.reactionId, reaction.authorDisplayName])).toEqual([
      ["reaction-peer", "Ice"],
      ["optimistic:message-1:👍:author-you", "Ice"],
    ]);
  });

  it("does not let a page read before the write was acknowledged erase the like", async () => {
    const olderRead = deferred<unknown>();
    const write = deferred<unknown>();
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({ items: [item("message-1")] })
      .mockImplementationOnce(() => olderRead.promise);
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [row()], viewerAuthorId: "author-you" });
    const { result, store, shown, like } = setup();
    await act(() => result.current.loadPersonalFeed());
    act(() => void result.current.loadPersonalFeed());

    await like();
    await act(async () => {
      write.resolve({});
      await write.promise;
    });
    await waitFor(() => expect(store.pending("thread-1", "message-1")).toBe(false));
    expect(shown()).toEqual([row()]);

    // The page began before the write and lands last, without the like.
    await act(async () => {
      olderRead.resolve({ items: [item("message-1")] });
      await olderRead.promise;
    });
    expect(result.current.personalFeed).toHaveLength(1);
    expect(shown()).toEqual([row()]);
  });

  it("ingests a page the open Home no longer shows, and keeps each item to its own message", async () => {
    const page = deferred<unknown>();
    bridgeMock.listPersonalChatFeed.mockImplementationOnce(() => page.promise);
    const { result, store, liveToken } = setup();
    // A thread read that began before the page.
    const earlier = store.ticket();
    act(() => void result.current.loadPersonalFeed());
    // The person left Home; the answer still says what the server holds.
    liveToken.current += 1;
    store.ingest([{
      threadId: "thread-1",
      reactions: [row({ reactionId: "reaction-other", messageId: "message-2", authorId: "author-peer" })],
      viewerAuthorId: "author-you",
      ticket: earlier,
    }]);
    await act(async () => {
      page.resolve({ items: [item("message-1", [row()])] });
      await page.promise;
    });
    expect(result.current.personalFeed).toEqual([]);
    expect(store.view("thread-1", "message-1").reactions).toEqual([row()]);
    expect(store.view("thread-1", "message-2").reactions).toEqual([
      row({ reactionId: "reaction-other", messageId: "message-2", authorId: "author-peer" }),
    ]);
  });
});
