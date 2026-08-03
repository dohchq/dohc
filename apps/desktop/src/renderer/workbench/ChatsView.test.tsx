// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelThreadRecord,
  ChatBookmarkRecord,
  ChatChannelRecord,
  ChatMessageRecord,
  DmRecord,
  FileChatThreadRecord,
} from "../../ipc/bridgeContract";
import { ChatsView, reconcileResolvedChatDecision } from "./ChatsView";

// Chats view (PR 13, WS-E): fast, natural chat — the channel composer sends
// on Enter with NO title prompt, unread badges derive from the store's read
// cursors, and the Files grouping cross-links to the file rail.

const NOW = 1_700_000_000_000;

function channel(overrides: Partial<ChatChannelRecord> = {}): ChatChannelRecord {
  return {
    id: "channel-1",
    name: "general",
    slug: "general",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    ...overrides,
  };
}

function thread(overrides: Partial<ChannelThreadRecord> = {}): ChannelThreadRecord {
  return {
    id: "thread-1",
    title: "Should we ship on Friday?",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    channelId: "channel-1",
    messageCount: 1,
    lastReadSequence: 1,
    unreadCount: 0,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: "message-1",
    threadId: "thread-1",
    authorKind: "human",
    authorDisplayName: "You",
    body: "Should we ship on Friday?",
    createdAtMs: NOW,
    ...overrides,
  };
}

function openingPreview(
  overrides: Partial<NonNullable<ChannelThreadRecord["openingMessage"]>> = {},
): NonNullable<ChannelThreadRecord["openingMessage"]> {
  return {
    id: "message-1",
    authorKind: "human",
    authorDisplayName: "You",
    bodySnippet: "Should we ship on Friday?",
    createdAtMs: NOW,
    reactions: [],
    ...overrides,
  };
}

function personalFeedItem(body: string, id: string) {
  return {
    message: message({ id, body }),
    thread: thread(),
    channel: {
      id: "channel-1",
      name: "general",
      slug: "general",
      kind: "channel" as const,
    },
    reactions: [],
    matchedBy: ["channel" as const],
  };
}

const fileThread: FileChatThreadRecord = {
  id: "thread-file-1",
  title: "Naming discussion",
  createdAtMs: NOW,
  updatedAtMs: NOW,
  path: "notes/topic.md",
};

function dm(overrides: Partial<DmRecord> = {}): DmRecord {
  return {
    channelId: "channel-dm-1",
    channelWireId: "wire-dm-1",
    name: "bob@example.com",
    peerLabel: "bob@example.com",
    role: "owner",
    shareId: null,
    threadId: "thread-dm-1",
    unreadCount: 0,
    connected: true,
    ...overrides,
  };
}

const bridgeMock = {
  listChatChannels: vi.fn(),
  listChatChannelShares: vi.fn(),
  listJoinedSharedChannels: vi.fn(),
  shareChatChannel: vi.fn(),
  joinSharedChannel: vi.fn(),
  leaveSharedChannel: vi.fn(),
  revokeRelayShare: vi.fn(),
  createChatChannel: vi.fn(),
  listChannelThreads: vi.fn(),
  startChannelThread: vi.fn(),
  listChatMessages: vi.fn(),
  listChatThreadDecisions: vi.fn(),
  resolveChatDecision: vi.fn(),
  listChatThreadAttachments: vi.fn(),
  chatRunRecordsForThread: vi.fn(),
  sendChatMessage: vi.fn(),
  markChatThreadRead: vi.fn(),
  listChatReactions: vi.fn(),
  setChatReaction: vi.fn(),
  syncDms: vi.fn(),
  startDm: vi.fn(),
  chatDispatchStateForThread: vi.fn(),
  stopAgentRun: vi.fn(),
  resumeThreadDispatch: vi.fn(),
  writeClipboardText: vi.fn(),
  listChatBookmarks: vi.fn(),
  saveChatBookmark: vi.fn(),
  archiveChatBookmark: vi.fn(),
  listChatFollows: vi.fn(),
  setChatFollow: vi.fn(),
  listPersonalChatFeed: vi.fn(),
  markPersonalChatFeedSeen: vi.fn(),
  onWorkspaceActivity: vi.fn(),
};

Element.prototype.scrollIntoView = vi.fn();

const workspaceActivityCallbacks = new Set<() => void>();

function emitWorkspaceActivity() {
  for (const callback of [...workspaceActivityCallbacks]) callback();
}

beforeEach(() => {
  workspaceActivityCallbacks.clear();
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.onWorkspaceActivity.mockImplementation((callback: () => void) => {
    workspaceActivityCallbacks.add(callback);
    return () => {
      workspaceActivityCallbacks.delete(callback);
    };
  });
  bridgeMock.listChatChannels.mockResolvedValue({
    channels: [channel()],
    fileThreads: [],
  });
  bridgeMock.listChatChannelShares.mockResolvedValue({
    granted: [],
    received: [],
    joined: [],
  });
  bridgeMock.listJoinedSharedChannels.mockResolvedValue({ joined: [] });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
  bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [] });
  bridgeMock.listChatThreadAttachments.mockResolvedValue({ attachments: [] });
  bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: {} });
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
  bridgeMock.listChatBookmarks.mockResolvedValue({ bookmarks: [] });
  bridgeMock.saveChatBookmark.mockResolvedValue({
    bookmark: {
      bookmarkId: "bookmark-1",
      targetKind: "thread",
      targetId: "thread-1",
      threadId: "thread-1",
      mode: "live",
      destinationPath: "Bookmarks/Chats/Friday--thread-1.md",
      state: "active",
      projectionState: "ready",
      generation: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
  });
  bridgeMock.archiveChatBookmark.mockResolvedValue({
    bookmark: {
      bookmarkId: "bookmark-1",
      targetKind: "thread",
      targetId: "thread-1",
      threadId: "thread-1",
      mode: "live",
      destinationPath: "Bookmarks/Chats/Friday--thread-1.md",
      state: "archived",
      projectionState: "ready",
      generation: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
  });
  bridgeMock.listChatFollows.mockResolvedValue({ follows: [] });
  bridgeMock.setChatFollow.mockImplementation(
    (input: {
      target:
        | { kind: "channel"; channelId: string }
        | { kind: "thread"; threadId: string }
        | { kind: "author"; threadId: string; messageId: string };
      state: "following" | "unfollowed";
    }) =>
      Promise.resolve({
        follow: {
          targetKind:
            input.target.kind === "channel"
              ? "channel"
              : input.target.kind === "thread"
                ? "thread"
                : "person",
          targetId:
            input.target.kind === "channel"
              ? "wire-1"
              : input.target.kind === "thread"
                ? input.target.threadId
                : "user-alice",
          state: input.state,
          updatedAtMs: NOW,
        },
      }),
  );
  bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [] });
  bridgeMock.markPersonalChatFeedSeen.mockResolvedValue({
    readState: {
      lastSeenCreatedAtMs: NOW,
      lastSeenMessageId: "message-1",
      updatedAtMs: NOW,
    },
  });
  bridgeMock.chatDispatchStateForThread.mockResolvedValue({
    liveRun: false,
    pendingCount: 0,
    paused: false,
  });
  bridgeMock.stopAgentRun.mockResolvedValue(undefined);
  bridgeMock.resumeThreadDispatch.mockResolvedValue(undefined);
  bridgeMock.markChatThreadRead.mockResolvedValue({
    lastReadSequence: 1,
    revision: 1,
  });
  bridgeMock.listChatReactions.mockResolvedValue({
    reactions: [],
    viewerAuthorId: "you@example.com",
  });
  bridgeMock.setChatReaction.mockResolvedValue({
    reaction: {
      reactionId: "r1",
      messageId: "message-1",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "you@example.com",
      authorKind: "human",
      authorDisplayName: "you@example.com",
      state: "added",
    },
    viewerAuthorId: "you@example.com",
  });
  // Solo default (collaboration off): the DM surface stays invisible.
  bridgeMock.syncDms.mockResolvedValue({ available: false, dms: [] });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  workspaceActivityCallbacks.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type ExtraProps = Partial<Parameters<typeof ChatsView>[0]>;

function renderView(onOpenFileChat = vi.fn(), onError = vi.fn(), extra: ExtraProps = {}) {
  render(
    <ChatsView
      workspaceId="workspace-a"
      onOpenFileChat={onOpenFileChat}
      onError={onError}
      {...extra}
    />,
  );
  return { onOpenFileChat, onError };
}

const mentionRoster = [
  { id: "agent:default", kind: "agent" as const, handle: "agent", label: "Your agent", description: "your agent" },
  { id: "user:you", kind: "user" as const, handle: "you", label: "You", description: "you" },
];

describe("ChatsView channels", () => {
  it("lists channels with unread badges and thread counts", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({ id: "channel-2", name: "product", slug: "product", threadCount: 3, unreadCount: 2 }),
      ],
      fileThreads: [],
    });
    renderView();

    const names = await screen.findAllByTestId("chats-channel-name");
    expect(names.map((el) => el.textContent)).toEqual(["general", "product"]);
    // Only the channel with unread messages shows a badge.
    const badges = screen.getAllByTestId("chats-channel-unread");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("2");
    expect(screen.getByText("3 chats")).toBeTruthy();
  });

  it("creates a channel inline and opens it", async () => {
    const user = userEvent.setup();
    bridgeMock.createChatChannel.mockResolvedValue({
      channel: channel({ id: "channel-9", name: "launch", slug: "launch" }),
    });
    renderView();

    await user.click(await screen.findByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");

    await waitFor(() =>
      expect(bridgeMock.createChatChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        name: "launch",
      }),
    );
    // Straight into the new channel — no extra click.
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );
  });

  it("lists file-linked Chats under Files and cross-links to the rail", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [fileThread],
    });
    const user = userEvent.setup();
    const { onOpenFileChat } = renderView();

    const row = await screen.findByTestId("chats-file-chat");
    expect(row.textContent).toContain("Naming discussion");
    expect(row.textContent).toContain("notes/topic.md");
    await user.click(row);
    expect(onOpenFileChat).toHaveBeenCalledWith(fileThread);
    // Read-only cross-link: clicking never loads messages here.
    expect(bridgeMock.listChatMessages).not.toHaveBeenCalled();
  });
});

// Journey 3 (#337): the navigator kept an unread badge more than 30s after
// the thread was read. It hands every conversation to the editor, so it never
// reaches its own mark-read and had no reason to refetch the counts it loaded
// at mount. The shell reports each landed read through readRevision.
describe("ChatsView panel navigator unread badges", () => {
  function navigator(readRevision: number) {
    return (
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        onOpenInTab={vi.fn()}
        readRevision={readRevision}
      />
    );
  }

  it("refetches the counts once the shell reports a landed read", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The editor read the thread: the durable count is zero now.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    view.rerender(navigator(1));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
  });

  // Clearing a badge must never cost the user the navigator itself.
  it("keeps a working navigator when the badge refresh fails, and retries on the next read", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The refresh the read triggers fails.
    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    // The channel list is still there — a stale badge beats an error card.
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
    expect(screen.getByTestId("chats-channel-unread").textContent).toBe("2");

    // The signal was not spent on that failure: the next read still refetches
    // and the badge catches up.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    view.rerender(navigator(2));
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
  });

  // liveToken means "everything in flight is now stale", and the mutations
  // capture it to decide whether their own completion still counts. A badge
  // refresh is not that: it must not throw away a channel the user just made.
  it("does not discard a channel creation that a badge refresh lands on top of", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    let finishCreate!: (result: { channel: ChatChannelRecord }) => void;
    bridgeMock.createChatChannel.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    const user = userEvent.setup();
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-unread");

    // Start creating a channel and leave the IPC in flight.
    await user.click(screen.getByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");
    await waitFor(() => expect(bridgeMock.createChatChannel).toHaveBeenCalled());

    // A read lands, so the navigator refreshes its badges underneath.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    view.rerender(navigator(1));
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });

    // The creation now answers. Its result must still count.
    await act(async () => {
      finishCreate({
        channel: channel({ id: "channel-9", name: "launch", slug: "launch" }),
      });
      await Promise.resolve();
    });
    // Straight into the new channel, and the create form is gone — neither
    // happens if the refresh invalidated the creation.
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );
    expect(screen.queryByTestId("chats-new-channel-name")).toBeNull();
  });

  // The share lookup is optional, so a failure returns "unknown" — which is
  // not the same as "there are none". A badge refresh must not spend a
  // teammate's pending invitation on a transient signed-out blip.
  it("keeps cached share metadata when the badge refresh cannot reach it", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [
        {
          shareId: "share-received",
          channelWireId: "wire-received",
          granterEmail: "owner@example.com",
          access: "read-write",
          ended: false,
        },
      ],
      joined: [],
    });
    const view = render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The read lands. Channels answer; the optional share lookup does not.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    view.rerender(navigator(1));

    // The badge catches up, and the invitation is still on offer.
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // refreshOverview and refreshShares both write channelShares. Without one
  // order over both, a share lookup issued FIRST can resolve LAST and put the
  // pre-mutation snapshot back — the person you just invited disappearing.
  it("does not let a slow background lookup undo a share the user just made", async () => {
    const teamChannel = channel({
      id: "channel-team",
      name: "team",
      slug: "team",
      wireId: "wire-team",
    });
    const grant = (recipientEmail: string, shareId: string) => ({
      shareId,
      channelWireId: "wire-team",
      access: "read-write" as const,
      recipientEmail,
      revokedAtMs: null,
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel],
      fileThreads: [],
    });
    bridgeMock.shareChatChannel.mockResolvedValue({ shareId: "share-2" });
    // Every share lookup is answered by hand, so the order is the test.
    const answerShares: Array<(value: unknown) => void> = [];
    bridgeMock.listChatChannelShares.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerShares.push(resolve);
        }),
    );
    const user = userEvent.setup();
    const view = render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        readRevision={0}
      />,
    );

    // Mount: one person has the channel.
    await waitFor(() => expect(answerShares).toHaveLength(1));
    await act(async () => {
      answerShares[0]({ granted: [grant("ana@example.com", "share-1")], received: [], joined: [] });
      await Promise.resolve();
    });
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-share-channel"));
    expect((await screen.findByTestId("chats-share-member")).textContent).toContain(
      "ana@example.com",
    );

    // A read lands: the badge refresh issues its share lookup and stalls.
    view.rerender(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        readRevision={1}
      />,
    );
    await waitFor(() => expect(answerShares).toHaveLength(2));

    // Meanwhile the user shares the channel with someone else, and THAT
    // lookup answers first.
    await user.type(screen.getByTestId("chats-share-email"), "bo@example.com");
    await user.click(screen.getByTestId("chats-share-submit"));
    await waitFor(() => expect(answerShares).toHaveLength(3));
    await act(async () => {
      answerShares[2]({
        granted: [grant("ana@example.com", "share-1"), grant("bo@example.com", "share-2")],
        received: [],
        joined: [],
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("chats-share-member")).toHaveLength(2),
    );

    // Now the stalled background lookup answers with its older snapshot.
    await act(async () => {
      answerShares[1]({ granted: [grant("ana@example.com", "share-1")], received: [], joined: [] });
      await Promise.resolve();
    });

    // Bo is still there.
    const members = screen.getAllByTestId("chats-share-member");
    expect(members).toHaveLength(2);
    expect(members.map((el) => el.textContent).join(" ")).toContain("bo@example.com");
  });

  it("does not refetch while the revision stands still", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-unread");
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(1);

    view.rerender(navigator(0));
    await waitFor(() => {
      expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ChatsView shared-workspace read-only boundary", () => {
  it("keeps the panel navigator readable while removing every overview/channel mutation", async () => {
    const sharedChannel = channel({ wireId: "wire-1", threadCount: 1 });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [sharedChannel],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [
        {
          shareId: "share-received",
          channelWireId: "wire-received",
          granterEmail: "owner@example.com",
          access: "read-write",
          ended: false,
        },
      ],
      joined: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
    });

    renderView(vi.fn(), vi.fn(), { readOnly: true });

    expect(await screen.findByTestId("chats-channel")).toBeTruthy();
    expect(screen.queryByTestId("chats-channel-follow")).toBeNull();
    expect(screen.queryByTestId("chats-new-channel")).toBeNull();
    expect(screen.queryByTestId("chats-new-dm")).toBeNull();
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    expect(screen.getByTestId("chats-workspace-readonly-note")).toBeTruthy();
    expect(bridgeMock.syncDms).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-post-card")).toBeTruthy();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
    expect(screen.queryByTestId("chats-post-bookmark")).toBeNull();
    expect(screen.queryByTestId("chats-post-add-reaction")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note")).toBeTruthy();

    expect(bridgeMock.setChatFollow).not.toHaveBeenCalled();
    expect(bridgeMock.saveChatBookmark).not.toHaveBeenCalled();
    expect(bridgeMock.setChatReaction).not.toHaveBeenCalled();
    expect(bridgeMock.startChannelThread).not.toHaveBeenCalled();
    expect(bridgeMock.shareChatChannel).not.toHaveBeenCalled();
  });

  it("keeps the page thread readable without reply, decision, bookmark, or cursor writes", async () => {
    const sharedChannel = channel({ wireId: "wire-1" });
    const sharedThread = thread();
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message(),
        message({
          id: "message-2",
          parentMessageId: "message-1",
          body: "A decision",
        }),
      ],
    });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({
      decisions: [
        {
          threadId: "thread-1",
          messageId: "message-2",
          state: "open",
          createdAtMs: NOW,
          resolvedAtMs: null,
          resolvedByMessageId: null,
        },
      ],
    });
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [
        {
          reactionId: "reaction-1",
          messageId: "message-2",
          threadId: "thread-1",
          emoji: "👍",
          authorId: "someone@example.com",
          authorKind: "human",
          authorDisplayName: "Someone",
          state: "added",
        },
      ],
      viewerAuthorId: "you@example.com",
    });

    renderView(vi.fn(), vi.fn(), {
      readOnly: true,
      variant: "page",
      initialNav: {
        level: "thread",
        channel: sharedChannel,
        thread: sharedThread,
      },
    });

    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    expect(await screen.findByText("A decision")).toBeTruthy();
    expect(
      (screen.getByTestId("chats-reaction-pill") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("chats-add-reaction")).toBeNull();
    expect(screen.queryByTestId("chats-comment-reply")).toBeNull();
    expect(screen.queryByTestId("chats-message-bookmark")).toBeNull();
    expect(screen.queryByTestId("chats-composer")).toBeNull();
    expect(screen.queryByRole("button", { name: /resolve/i })).toBeNull();
    expect(screen.getByTestId("chats-readonly-note")).toBeTruthy();

    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();
    expect(bridgeMock.sendChatMessage).not.toHaveBeenCalled();
    expect(bridgeMock.resolveChatDecision).not.toHaveBeenCalled();
    expect(bridgeMock.archiveChatBookmark).not.toHaveBeenCalled();
  });

  it("keeps existing opening-message and comment bookmarks openable without mutation", async () => {
    const onOpenPath = vi.fn();
    const sharedChannel = channel({ wireId: "wire-1" });
    bridgeMock.listChatBookmarks.mockResolvedValue({
      bookmarks: [
        {
          bookmarkId: "bookmark-opening",
          targetKind: "message",
          targetId: "message-1",
          threadId: "thread-1",
          messageId: "message-1",
          mode: "live",
          destinationPath: "Bookmarks/Chats/opening.md",
          state: "active",
          projectionState: "ready",
          generation: 1,
          createdAtMs: NOW,
          updatedAtMs: NOW,
        },
        {
          bookmarkId: "bookmark-comment",
          targetKind: "message",
          targetId: "message-2",
          threadId: "thread-1",
          messageId: "message-2",
          mode: "snapshot",
          destinationPath: "Bookmarks/Chats/comment.md",
          state: "active",
          projectionState: "ready",
          generation: 1,
          createdAtMs: NOW,
          updatedAtMs: NOW,
        },
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message(),
        message({
          id: "message-2",
          parentMessageId: "message-1",
          body: "A bookmarked comment",
        }),
      ],
    });

    renderView(vi.fn(), vi.fn(), {
      readOnly: true,
      variant: "page",
      onOpenPath,
      initialNav: {
        level: "thread",
        channel: sharedChannel,
        thread: thread(),
      },
    });

    const opening = await screen.findByTitle("Bookmarks/Chats/opening.md");
    const comment = await screen.findByTitle("Bookmarks/Chats/comment.md");
    await userEvent.click(opening);
    await userEvent.click(comment);

    expect(onOpenPath).toHaveBeenNthCalledWith(1, "Bookmarks/Chats/opening.md");
    expect(onOpenPath).toHaveBeenNthCalledWith(2, "Bookmarks/Chats/comment.md");
    expect(screen.queryByTestId("chats-message-bookmark")).toBeNull();
    expect(bridgeMock.archiveChatBookmark).not.toHaveBeenCalled();
    expect(bridgeMock.saveChatBookmark).not.toHaveBeenCalled();
  });
});

describe("ChatsView hybrid feed", () => {
  it("consumes a rejected best-effort Feed seen cursor", async () => {
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [],
      headCursor: "1700000000000:message-1",
    });
    bridgeMock.markPersonalChatFeedSeen.mockRejectedValue(
      new Error("cursor storage unavailable"),
    );
    renderView(vi.fn(), onError);

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByTestId("chats-personal-feed");
    await waitFor(() =>
      expect(bridgeMock.markPersonalChatFeedSeen).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        headCursor: "1700000000000:message-1",
      }),
    );
    await act(async () => Promise.resolve());
    expect(onError).not.toHaveBeenCalled();
  });

  it("focuses the selected non-opening message when a feed item opens its thread", async () => {
    const onNavChange = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message({
            id: "message-comment",
            body: "Selected comment",
          }),
          thread: thread(),
          channel: {
            id: "channel-1",
            name: "general",
            slug: "general",
            kind: "channel",
          },
          reactions: [],
          matchedBy: ["thread"],
        },
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message(),
        message({
          id: "message-comment",
          parentMessageId: "message-1",
          body: "Selected comment",
        }),
      ],
    });
    renderView(vi.fn(), vi.fn(), { variant: "page", onNavChange });

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const selected = await screen.findByText("Selected comment");
    await userEvent.click(selected.closest("button")!);

    await waitFor(() =>
      expect(onNavChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          level: "thread",
          focusMessageId: "message-comment",
        }),
      ),
    );
  });

  it("opens a channel-less file Chat in its file panel at the feed message", async () => {
    const onOpenFileChat = vi.fn();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [fileThread],
    });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message({
            id: "message-file-update",
            threadId: fileThread.id,
            body: "Updated the linked document",
          }),
          thread: {
            id: fileThread.id,
            title: fileThread.title,
            createdAtMs: fileThread.createdAtMs,
            updatedAtMs: fileThread.updatedAtMs,
          },
          reactions: [],
          matchedBy: ["thread"],
        },
      ],
    });
    renderView(onOpenFileChat);

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const update = await screen.findByText("Updated the linked document");
    const openButton = update.closest("button") as HTMLButtonElement;
    expect(openButton.disabled).toBe(false);
    await userEvent.click(openButton);

    expect(onOpenFileChat).toHaveBeenCalledWith(
      fileThread,
      "message-file-update",
    );
  });

  it("bookmarks a post into a live workspace Markdown projection", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
      viewerAuthorId: "you@example.com",
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-post-bookmark"));

    await waitFor(() =>
      expect(bridgeMock.saveChatBookmark).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        target: { kind: "thread", threadId: "thread-1" },
        mode: "live",
      }),
    );
    expect(screen.getByTestId("chats-post-bookmark").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("offers a keyboard and touch accessible snapshot bookmark action", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
      viewerAuthorId: "you@example.com",
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    const snapshot = await screen.findByRole("button", {
      name: "Bookmark chat as snapshot",
    });
    await user.click(snapshot);

    expect(bridgeMock.saveChatBookmark).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      target: { kind: "thread", threadId: "thread-1" },
      mode: "snapshot",
    });
  });

  it("renders post cards with excerpts, reactions, decisions, comments, and agent treatment", async () => {
    const user = userEvent.setup();
    const reaction = {
      reactionId: "reaction-1",
      messageId: "message-1",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "you@example.com",
      authorKind: "human" as const,
      authorDisplayName: "You",
    };
    const humanThread = thread({
      messageCount: 3,
      openDecisionCount: 1,
      openingMessage: openingPreview({
        bodySnippet: "Should we ship on Friday? The launch checklist is ready.",
        reactions: [reaction],
      }),
    });
    const agentThread = thread({
      id: "thread-agent",
      title: "Pipeline review complete",
      messageCount: 1,
      openingMessage: openingPreview({
        id: "message-agent",
        authorKind: "agent",
        authorDisplayName: "You",
        bodySnippet: "The release pipeline is green across all checks.",
      }),
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [humanThread, agentThread],
      viewerAuthorId: "you@example.com",
    });
    bridgeMock.listChatMessages.mockImplementation(
      ({ threadId }: { threadId: string }) =>
        Promise.resolve({
          messages: [
            threadId === "thread-agent"
              ? message({
                  id: "message-agent",
                  threadId,
                  authorKind: "agent",
                  authorDisplayName: "You",
                  body: "The release pipeline is green across all checks.",
                })
              : message({
                  threadId,
                  body: "Should we ship on Friday? The launch checklist is ready.",
                }),
          ],
        }),
    );
    bridgeMock.listChatReactions.mockImplementation(
      ({ threadId }: { threadId: string }) =>
        Promise.resolve({
          reactions: threadId === "thread-1" ? [reaction] : [],
          viewerAuthorId: "you@example.com",
        }),
    );
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    const cards = await screen.findAllByTestId("chats-post-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Should we ship on Friday? The launch checklist is ready.")).toBeTruthy();
    expect(screen.getAllByTestId("chats-post-comment-count")[0]?.textContent).toBe(
      "2 comments",
    );
    expect(screen.getByTestId("chats-post-decision-open").textContent).toBe(
      "needs decision",
    );
    expect(screen.getByTestId("chats-post-reaction-pill").textContent).toContain("1");
    expect(screen.getByTestId("chats-post-agent-badge").textContent).toBe("agent");
    expect(cards[1]?.className).toContain("border-l-2");
    expect(screen.getAllByTestId("chats-post-author")[1]?.textContent).toBe(
      "You's agent",
    );
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      channelId: "channel-1",
    });
    expect(bridgeMock.listChatMessages).not.toHaveBeenCalled();
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();

    await user.click(cards[0]!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
  });
});

describe("ChatsView My agent", () => {
  it("stays absent when the workspace has no agent channel", async () => {
    renderView();
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-my-agent-section")).toBeNull();
  });

  it("renders above Channels, stays out of the channel list, and uses the agent placeholder", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({
          id: "channel-agent",
          name: "agent-internal",
          slug: "agent",
          kind: "agent",
          unreadCount: 2,
        }),
      ],
      fileThreads: [],
    });
    renderView();

    const agentSection = await screen.findByTestId("chats-my-agent-section");
    expect(agentSection.compareDocumentPosition(screen.getByTestId("chats-channels-heading")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("chats-my-agent-unread").textContent).toBe("2");
    expect(screen.getAllByTestId("chats-channel-name").map((node) => node.textContent)).toEqual([
      "general",
    ]);

    await user.click(screen.getByTestId("chats-my-agent"));
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("My agent");
    expect(
      (screen.getByTestId("chats-new-thread-composer") as HTMLTextAreaElement).placeholder,
    ).toBe("Message your agent…");
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
  });

  it("shows setup guidance and a configured owner label in My agent", async () => {
    const user = userEvent.setup();
    const onSetupAgent = vi.fn();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel({
          id: "channel-agent",
          name: "agent-internal",
          slug: "agent",
          kind: "agent",
        }),
      ],
      fileThreads: [],
    });
    renderView(vi.fn(), vi.fn(), {
      agentSetup: {
        preferredName: "Ice",
        runnerConfigured: true,
        runnerEnabled: true,
        mcpEnabled: false,
      },
      onSetupAgent,
    });

    await user.click(await screen.findByTestId("chats-my-agent"));
    expect((await screen.findByTestId("chats-agent-setup-card")).dataset.state).toBe("ready");
    expect(screen.getByTestId("chats-agent-setup-name").textContent).toBe("Ice's agent");
    expect(screen.getByTestId("chats-agent-setup-action").textContent).toBe("Manage");
    await user.click(screen.getByTestId("chats-agent-setup-action"));
    expect(onSetupAgent).toHaveBeenCalledOnce();
  });

  it("does not present an enabled MCP server as a connected agent", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel({
          id: "channel-agent",
          name: "agent-internal",
          slug: "agent",
          kind: "agent",
        }),
      ],
      fileThreads: [],
    });
    renderView(vi.fn(), vi.fn(), {
      agentSetup: {
        preferredName: "Ice",
        runnerConfigured: false,
        runnerEnabled: false,
        mcpEnabled: true,
      },
      onSetupAgent: vi.fn(),
    });

    await user.click(await screen.findByTestId("chats-my-agent"));
    expect((await screen.findByTestId("chats-agent-setup-card")).dataset.state).toBe(
      "needs-setup",
    );
    expect(screen.getByTestId("chats-agent-setup-card").textContent).toContain(
      "Workspace MCP enabled · copy its config into your agent.",
    );
    expect(screen.getByTestId("chats-agent-setup-action").textContent).toBe("Set up");
  });
});

describe("ChatsView composer-first threads (anti-forum)", () => {
  it("starts a thread from the channel composer with Enter and NO title prompt", async () => {
    const user = userEvent.setup();
    const startedThread = thread();
    bridgeMock.startChannelThread.mockResolvedValue({
      thread: startedThread,
      message: message(),
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    // The channel view offers exactly one input: the composer. No title
    // field exists on this path.
    const composer = await screen.findByTestId("chats-new-thread-composer");
    expect(document.querySelectorAll("input")).toHaveLength(0);
    await user.type(composer, "Should we ship on Friday?{Enter}");

    await waitFor(() =>
      expect(bridgeMock.startChannelThread).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        channelId: "channel-1",
        body: "Should we ship on Friday?",
      }),
    );
    // Lands inside the new thread with the message rendered; the snippet is
    // the display title.
    expect((await screen.findByTestId("chats-thread-title")).textContent).toBe(
      "Should we ship on Friday?",
    );
    expect(screen.getByTestId("chats-message-body").textContent).toBe(
      "Should we ship on Friday?",
    );
  });

  it("sends a reply from the thread composer and renders agent authorship", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message(),
        message({
          id: "message-2",
          authorKind: "agent",
          authorDisplayName: "ice@dohc.ai",
          body: "I checked the pipeline.",
        }),
      ],
    });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "message-3", body: "Great, thanks!" }),
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    const authors = await screen.findAllByTestId("chats-message-author");
    expect(authors.map((el) => el.textContent)).toEqual([
      "You",
      "ice@dohc.ai's agent",
    ]);

    await user.type(screen.getByTestId("chats-composer"), "Great, thanks!{Enter}");
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        body: "Great, thanks!",
      }),
    );
    const bodies = await screen.findAllByTestId("chats-message-body");
    expect(bodies[bodies.length - 1].textContent).toBe("Great, thanks!");
  });
});

describe("ChatsView document thread", () => {
  it("renders replies beneath their parent comment", async () => {
    const user = userEvent.setup();
    const opening = message({ body: "The full opening post body." });
    const firstComment = message({
      id: "comment-1",
      parentMessageId: opening.id,
      authorDisplayName: "Ana",
      body: "First comment",
    });
    const adjacentReply = message({
      id: "comment-2",
      parentMessageId: firstComment.id,
      authorDisplayName: "Ben",
      body: "Immediately follows its parent",
    });
    const nonAdjacentReply = message({
      id: "comment-3",
      parentMessageId: opening.id,
      authorKind: "agent",
      authorDisplayName: "You",
      body: "Returning to the opening question",
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 4 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [opening, firstComment, adjacentReply, nonAdjacentReply],
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const title = await screen.findByTestId("chats-thread-post-title");
    expect(title.textContent).toBe("Should we ship on Friday?");
    expect(title.className).toContain("font-serif");
    expect(screen.getByTestId("chats-thread-eyebrow").textContent).toBe(
      "#general · thread",
    );
    expect(screen.getAllByTestId("chats-comment-bubble")).toHaveLength(3);
    const commentItems = screen
      .getAllByTestId("chats-message")
      .filter((element) => element.tagName === "LI");
    expect(commentItems.map((element) => element.dataset.threadDepth)).toEqual([
      "0",
      "1",
      "0",
    ]);
    expect(screen.getByTestId("chats-comments").children).toHaveLength(2);
    expect(screen.getByTestId("chats-replies").children).toHaveLength(1);
    expect(screen.getByTestId("chats-reply-count").textContent).toBe("1 reply");
    const contexts = screen.getAllByTestId("chats-reply-context");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.textContent).toBe("↳ replying to Ana");
    expect(screen.getByTestId("chats-comment-agent-badge").textContent).toBe("agent");
    expect(screen.getAllByTestId("chats-comment-bubble")[2]?.className).toContain(
      "border-l-2",
    );

    await user.click(contexts[0]!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("enters reply mode and sends the true parent message id", async () => {
    const user = userEvent.setup();
    const opening = message();
    const comment = message({
      id: "comment-parent",
      parentMessageId: opening.id,
      authorDisplayName: "Ana",
      body: "What about Monday?",
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 2 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening, comment] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({
        id: "comment-reply",
        parentMessageId: comment.id,
        body: "Monday works.",
      }),
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-comment-reply"));
    expect(screen.getByTestId("chats-replying-mode").textContent).toContain(
      "Replying to Ana",
    );
    await user.type(screen.getByTestId("chats-composer"), "Monday works.{Enter}");
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: "comment-parent",
        body: "Monday works.",
      }),
    );
    const postedReply = document.querySelector(
      '[data-testid="chats-message"][data-message-id="comment-reply"]',
    ) as HTMLElement | null;
    expect(postedReply?.dataset.threadDepth).toBe("1");
    expect(postedReply?.closest('[data-testid="chats-replies"]')).toBeTruthy();
  });
});

describe("ChatsView live activity refresh", () => {
  it("refreshes the open Feed with fresh workspace activity content", async () => {
    let refreshed = false;
    bridgeMock.listPersonalChatFeed.mockImplementation(() =>
      Promise.resolve({
        items: [
          personalFeedItem(
            refreshed ? "Fresh Feed update" : "Existing Feed update",
            refreshed ? "message-fresh" : "message-existing",
          ),
        ],
      }),
    );
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Existing Feed update");

    refreshed = true;
    act(() => emitWorkspaceActivity());

    expect(await screen.findByText("Fresh Feed update")).toBeTruthy();
    expect(screen.queryByText("Existing Feed update")).toBeNull();
    expect(bridgeMock.listPersonalChatFeed).toHaveBeenCalledTimes(2);
  });

  it("drops an older pagination page when activity starts a fresh Feed refresh", async () => {
    type FeedPage = {
      items: ReturnType<typeof personalFeedItem>[];
      nextCursor?: string;
    };
    let resolveOlder!: (value: FeedPage) => void;
    const olderPage = new Promise<FeedPage>((resolve) => {
      resolveOlder = resolve;
    });
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({
        items: [personalFeedItem("Initial Feed item", "message-initial")],
        nextCursor: "older-cursor",
      })
      .mockImplementationOnce(() => olderPage)
      .mockResolvedValueOnce({
        items: [personalFeedItem("Activity refresh item", "message-refresh")],
      });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Initial Feed item");
    await userEvent.click(await screen.findByTestId("chats-feed-more"));
    act(() => emitWorkspaceActivity());
    await screen.findByText("Activity refresh item");

    await act(async () => {
      resolveOlder({
        items: [personalFeedItem("Stale paginated item", "message-stale-page")],
      });
      await olderPage;
    });
    expect(screen.queryByText("Stale paginated item")).toBeNull();
    expect(screen.getByText("Activity refresh item")).toBeTruthy();
  });

  it("drops a delayed Feed activity response after switching workspaces", async () => {
    let resolveOldRefresh!: (value: {
      items: ReturnType<typeof personalFeedItem>[];
    }) => void;
    const oldRefresh = new Promise<{
      items: ReturnType<typeof personalFeedItem>[];
    }>((resolve) => {
      resolveOldRefresh = resolve;
    });
    let oldWorkspaceReads = 0;
    bridgeMock.listPersonalChatFeed.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === "workspace-new") {
          return Promise.resolve({
            items: [personalFeedItem("New workspace Feed", "message-new")],
          });
        }
        oldWorkspaceReads += 1;
        return oldWorkspaceReads === 1
          ? Promise.resolve({
              items: [personalFeedItem("Old workspace Feed", "message-old-initial")],
            })
          : oldRefresh;
      },
    );
    const { rerender } = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Old workspace Feed");
    act(() => emitWorkspaceActivity());

    rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("chats-personal-feed")).toBeNull());
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("New workspace Feed");

    await act(async () => {
      resolveOldRefresh({
        items: [personalFeedItem("Stale old workspace Feed", "message-old-stale")],
      });
      await oldRefresh;
    });
    expect(screen.queryByText("Stale old workspace Feed")).toBeNull();
    expect(screen.getByText("New workspace Feed")).toBeTruthy();
  });

  it("re-lists threads when workspace activity changes the open channel feed", async () => {
    const user = userEvent.setup();
    let refreshed = false;
    bridgeMock.listChannelThreads.mockImplementation(() =>
      Promise.resolve({
        threads: refreshed
          ? [thread(), thread({ id: "thread-2", title: "Posted from the CLI" })]
          : [thread()],
      }),
    );
    bridgeMock.listChatMessages.mockImplementation(
      ({ threadId }: { threadId: string }) =>
        Promise.resolve({
          messages: [
            message({
              id: `message-${threadId}`,
              threadId,
              body: threadId === "thread-2" ? "Posted from the CLI" : message().body,
            }),
          ],
        }),
    );
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByText(thread().title);
    expect(screen.queryByText("Posted from the CLI")).toBeNull();
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    refreshed = true;
    act(() => emitWorkspaceActivity());

    expect(await screen.findByText("Posted from the CLI")).toBeTruthy();
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(2);
  });

  it("reloads an open thread's messages, decisions, and run records in place", async () => {
    const user = userEvent.setup();
    const opening = message();
    const agentReport = message({
      id: "agent-live-report",
      parentMessageId: opening.id,
      authorKind: "agent",
      authorDisplayName: "You",
      body: "done: checked the exports",
      createdAtMs: NOW + 1,
    });
    const openDecision = {
      threadId: "thread-1",
      messageId: agentReport.id,
      state: "open" as const,
      atMs: NOW + 1,
    };
    const run = {
      runId: "run-live-123456",
      threadId: "thread-1",
      triggerMessageId: opening.id,
      command: "node fakeChatRunner.mjs report",
      startedAtMs: NOW,
      exitCode: 0,
      logPath: "logs/run-live-123456.log",
    };
    let refreshed = false;
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 1 })],
    });
    bridgeMock.listChatMessages.mockImplementation(() =>
      Promise.resolve({ messages: refreshed ? [opening, agentReport] : [opening] }),
    );
    bridgeMock.listChatThreadDecisions.mockImplementation(() =>
      Promise.resolve({ decisions: refreshed ? [openDecision] : [] }),
    );
    bridgeMock.chatRunRecordsForThread.mockImplementation(() =>
      Promise.resolve({
        runs: refreshed ? { [agentReport.id]: run } : {},
      }),
    );
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    expect(screen.getByTestId("chats-message-body").textContent).toBe(opening.body);
    expect(screen.queryByText(agentReport.body)).toBeNull();
    expect(screen.queryByTestId("chats-comment-decision-open")).toBeNull();
    expect(screen.queryByTestId("chats-run-chip")).toBeNull();
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    const messageReadsBefore = bridgeMock.listChatMessages.mock.calls.length;
    const decisionReadsBefore = bridgeMock.listChatThreadDecisions.mock.calls.length;
    refreshed = true;
    act(() => {
      emitWorkspaceActivity();
    });

    expect(await screen.findByText(agentReport.body)).toBeTruthy();
    expect(await screen.findByTestId("chats-comment-decision-open")).toBeTruthy();
    expect((await screen.findByTestId("chats-run-chip")).textContent).toBe("run run-liv");
    // The same view stayed mounted; activity caused fresh reads rather than a
    // back/forward navigation or optimistic local append.
    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(bridgeMock.listChatMessages.mock.calls.length).toBeGreaterThan(
      messageReadsBefore,
    );
    expect(bridgeMock.listChatThreadDecisions.mock.calls.length).toBeGreaterThan(
      decisionReadsBefore,
    );
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
  });

  // The write lands in a chat the user does NOT have open, so the roll-up
  // badge on the channel list is the only place it shows. Without the list's
  // own subscription the count waits for a navigation or a relaunch.
  it("raises the channel list's roll-up badge while the list stays on screen", async () => {
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({ channels: [channel({ unreadCount })], fileThreads: [] }),
    );
    renderView();

    await screen.findByTestId("chats-channel-name");
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    // An agent posts into a thread nobody opened.
    unreadCount = 3;
    act(() => emitWorkspaceActivity());

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("3");
    // Nothing navigated: the badge appeared on the list itself.
    expect(screen.getByTestId("chats-channels-heading")).toBeTruthy();
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
  });

  // #545: the DM roll-up sits in the SAME list, but it refreshed only on the
  // 5-second poll — a DM badge lagging beside a live channel badge reads as
  // "no new DMs".
  it("raises the DM roll-up badge the moment a write arrives, not on the next poll", async () => {
    // Fake timers, never advanced: with the clock frozen the 5s poll cannot
    // fire, so it structurally cannot answer for the activity signal — a
    // slow machine cannot false-pass this by letting the poll tick land
    // inside a real-time wait.
    vi.useFakeTimers();
    try {
      let unreadCount = 0;
      bridgeMock.syncDms.mockImplementation(() =>
        Promise.resolve({ available: true, dms: [dm({ unreadCount })] }),
      );
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      screen.getByTestId("chats-dm-item");
      expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
      const syncsBefore = bridgeMock.syncDms.mock.calls.length;

      // An agent's DM write lands while the list is on screen.
      unreadCount = 2;
      act(() => emitWorkspaceActivity());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // MUTATION: remove `void refreshDms()` from the channels-level activity
      // branch. With the clock frozen, no other caller exists to sync.
      expect(bridgeMock.syncDms.mock.calls.length).toBeGreaterThan(syncsBefore);
      expect(screen.getByTestId("chats-dm-unread").textContent).toBe("2");
      // Nothing navigated: the badge appeared on the list itself.
      expect(screen.getByTestId("chats-channels-heading")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // The activity signal fires for every settled file batch and run update,
  // and syncDms is a relay sync, not a local read. The rule (badgeRead
  // precedent): one sync in flight, and a burst arriving mid-sync runs
  // exactly one trailing pass when it settles.
  it("coalesces an activity burst into one in-flight DM sync plus one trailing pass", async () => {
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [dm()] });
    renderView();
    await screen.findByTestId("chats-dm-item");
    const syncsBefore = bridgeMock.syncDms.mock.calls.length;

    let release!: () => void;
    const held = new Promise<{ available: boolean; dms: DmRecord[] }>(
      (resolve) => {
        release = () =>
          resolve({ available: true, dms: [dm({ unreadCount: 1 })] });
      },
    );
    bridgeMock.syncDms.mockImplementation(() => held);
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 1),
    );

    // The burst lands while that sync is in flight.
    // MUTATION: revert refreshDms to a plain un-coalesced sync. Each of these
    // starts its own relay sync and the count below reads syncsBefore + 4.
    act(() => {
      emitWorkspaceActivity();
      emitWorkspaceActivity();
      emitWorkspaceActivity();
    });
    expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 1);

    // One trailing pass when the held sync settles — not one per event.
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 2),
    );
    expect((await screen.findByTestId("chats-dm-unread")).textContent).toBe("1");
    expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 2);
  });

  // The renderer invariant (AGENTS.md): a slow response for workspace A must
  // never repaint workspace B. The drain made syncDms multi-pass, so the
  // per-pass token check is what stands between a stale relay answer and the
  // switched list (#582 review).
  it("drops a slow DM sync from the workspace the user left", async () => {
    type DmPage = { available: boolean; dms: DmRecord[] };
    let resolveStale!: (value: DmPage) => void;
    const stale = new Promise<DmPage>((resolve) => {
      resolveStale = resolve;
    });
    let oldReads = 0;
    bridgeMock.syncDms.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId !== "workspace-old") {
          return Promise.resolve({
            available: true,
            dms: [
              dm({
                channelId: "channel-dm-new",
                peerLabel: "carol@example.com",
                unreadCount: 0,
              }),
            ],
          });
        }
        oldReads += 1;
        return oldReads === 1
          ? Promise.resolve({ available: true, dms: [dm()] })
          : stale;
      },
    );
    const view = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await screen.findByTestId("chats-dm-item");
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(oldReads).toBe(2));

    view.rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-dm-name").textContent).toBe(
        "carol@example.com",
      ),
    );

    // MUTATION: delete the per-pass `if (token !== liveToken.current) return;`
    // inside the drain. This stale answer then repaints the new workspace's
    // list with the old one's DM and a badge of 9.
    await act(async () => {
      resolveStale({ available: true, dms: [dm({ unreadCount: 9 })] });
      await stale;
    });
    expect(screen.getByTestId("chats-dm-name").textContent).toBe(
      "carol@example.com",
    );
    expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
  });

  // The dead-era yield: a workspace switch during a stalled old-workspace
  // sync must steal the drain's slot, not queue onto it — a queued pass on a
  // sync that never settles would leave the new workspace's DM list empty
  // forever (#582 review).
  it("never queues the new workspace's DM sync onto the stalled one it left", async () => {
    type DmPage = { available: boolean; dms: DmRecord[] };
    const leftBehind = new Promise<DmPage>(() => {
      // never settles: the drain the switch must not wait on
    });
    let oldReads = 0;
    let newReads = 0;
    bridgeMock.syncDms.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId !== "workspace-old") {
          newReads += 1;
          return Promise.resolve({
            available: true,
            dms: [
              dm({
                channelId: "channel-dm-new",
                peerLabel: "carol@example.com",
              }),
            ],
          });
        }
        oldReads += 1;
        return oldReads === 1
          ? Promise.resolve({ available: true, dms: [dm()] })
          : leftBehind;
      },
    );
    const view = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await screen.findByTestId("chats-dm-item");
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(oldReads).toBe(2));

    // MUTATION: weaken the drain's entry guard to `if (active !== null)`.
    // The switch's own refreshDms then queues onto the dead drain and no
    // workspace-new sync ever starts — not even the poll can get past it.
    view.rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() => expect(newReads).toBeGreaterThan(0), { timeout: 2_000 });
    expect((await screen.findByTestId("chats-dm-name")).textContent).toBe(
      "carol@example.com",
    );
  });

  it("drops a slow list refresh from the workspace the user left", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let resolveStale!: (value: ChannelListPage) => void;
    const staleRefresh = new Promise<ChannelListPage>((resolve) => {
      resolveStale = resolve;
    });
    let oldWorkspaceReads = 0;
    bridgeMock.listChatChannels.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId !== "workspace-old") {
          return Promise.resolve({
            channels: [channel({ id: "channel-new", name: "planning", slug: "planning" })],
            fileThreads: [],
          });
        }
        oldWorkspaceReads += 1;
        return oldWorkspaceReads === 1
          ? Promise.resolve({ channels: [channel()], fileThreads: [] })
          : staleRefresh;
      },
    );
    const view = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("general"),
    );
    act(() => emitWorkspaceActivity());

    view.rerender(
      <ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );

    await act(async () => {
      resolveStale({
        channels: [channel({ unreadCount: 9 })],
        fileThreads: [],
      });
      await staleRefresh;
    });
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning");
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
  });

  // The switch happens while a badge read for the old workspace is still in
  // flight. Activity in the NEW workspace must not queue a pass onto it: that
  // pass carries the old workspace's id and the new workspace's liveToken, and
  // the guard would pass while the wrong workspace's channels repaint.
  it("never repaints one workspace's list with the one the user left", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let resolveLeftBehind!: (value: ChannelListPage) => void;
    const leftBehindRead = new Promise<ChannelListPage>((resolve) => {
      resolveLeftBehind = resolve;
    });
    let oldWorkspaceReads = 0;
    let newWorkspaceReads = 0;
    bridgeMock.listChatChannels.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId !== "workspace-old") {
          newWorkspaceReads += 1;
          return Promise.resolve({
            channels: [channel({ id: "channel-new", name: "planning", slug: "planning" })],
            fileThreads: [],
          });
        }
        oldWorkspaceReads += 1;
        if (oldWorkspaceReads === 1) {
          return Promise.resolve({ channels: [channel()], fileThreads: [] });
        }
        if (oldWorkspaceReads === 2) return leftBehindRead;
        // Any later read for the workspace the user left is the drain this
        // test exists to prevent; make what it would paint unmistakable.
        return Promise.resolve({
          channels: [
            channel({ id: "channel-left", name: "left-behind", slug: "left-behind" }),
          ],
          fileThreads: [],
        });
      },
    );
    const view = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("general"),
    );
    // A badge read for the old workspace is now in flight.
    act(() => emitWorkspaceActivity());
    expect(oldWorkspaceReads).toBe(2);

    view.rerender(
      <ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );
    // A write lands in the workspace the user switched TO. It is not swallowed
    // by the read still in flight for the workspace the user left: the new
    // workspace gets its own badge read (its mount read, then this one).
    act(() => emitWorkspaceActivity());
    expect(newWorkspaceReads).toBe(2);

    await act(async () => {
      resolveLeftBehind({ channels: [channel()], fileThreads: [] });
      await leftBehindRead;
    });

    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );
    expect(screen.queryByText("left-behind")).toBeNull();
    expect(oldWorkspaceReads).toBe(2);
  });

  // The share listing is relay-backed for the granted and received rows, and
  // answers "none" when the relay is unreachable — the main handler catches the
  // failure and returns empty rows. A badge refresh that replaced them would
  // let an unrelated file save erase a pending invitation that is still true.
  it("leaves the relay-backed share listing alone while it updates a badge", async () => {
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({ channels: [channel({ unreadCount })], fileThreads: [] }),
    );
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [
        {
          shareId: "share-received",
          channelWireId: "wire-received",
          granterEmail: "owner@example.com",
          access: "read-write",
          ended: false,
        },
      ],
      joined: [],
    });
    renderView();
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    // The relay goes away: the handler answers with empty rows, not an error.
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [],
    });
    unreadCount = 3;
    act(() => emitWorkspaceActivity());

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("3");
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
    // The badge pass asked the local registry, and the relay-backed lookup not
    // at all — its rows are not this reader's to answer.
    expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listJoinedSharedChannels).toHaveBeenCalled();
  });

  // The editor marks a thread read and the shell bumps readRevision, whose
  // refresh does not change liveToken. A badge read issued before it must not
  // put the count it already cleared back on screen.
  it("cannot restore an unread count the editor already cleared", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let resolveStaleBadge!: (value: ChannelListPage) => void;
    const staleBadge = new Promise<ChannelListPage>((resolve) => {
      resolveStaleBadge = resolve;
    });
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      }
      if (reads === 2) return staleBadge;
      // The read the editor's mark-read triggers: the count is gone.
      return Promise.resolve({ channels: [channel({ unreadCount: 0 })], fileThreads: [] });
    });
    const navigator = (readRevision: number) => (
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        onOpenInTab={vi.fn()}
        readRevision={readRevision}
      />
    );
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // A badge read is in flight when the read lands.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);
    view.rerender(navigator(1));
    await waitFor(() => expect(screen.queryByTestId("chats-channel-unread")).toBeNull());

    // The older badge read answers with the count as it was.
    await act(async () => {
      resolveStaleBadge({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      await staleBadge;
    });
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
  });

  // A joined-only correction answers one question. It must not take the other
  // one's place: a full share read still in flight carries the invitations and
  // member rows nothing else in this refresh can produce.
  it("does not let a joined-only correction swallow a full share read", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    const invitation = {
      shareId: "share-invite",
      channelWireId: "wire-invite",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-joined" })],
      fileThreads: [],
    });
    let answerFullRead!: (value: {
      granted: unknown[];
      received: unknown[];
      joined: unknown[];
    }) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve({ granted: [], received: [], joined: [joinedRow] });
      }
      // The readRevision refresh's full lookup: it stalls.
      return new Promise((resolve) => {
        answerFullRead = resolve;
      });
    });
    // The badge pass's local read, issued later: the sync recorded the revoke.
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    const navigator = (readRevision: number) => (
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        onOpenInTab={vi.fn()}
        readRevision={readRevision}
      />
    );
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-shared");
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();

    // The full lookup is in flight when a write starts a badge pass.
    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "no longer shared",
      ),
    );

    // The full lookup answers, carrying an invitation only it can report.
    await act(async () => {
      answerFullRead({ granted: [], received: [invitation], joined: [joinedRow] });
      await Promise.resolve();
    });

    // Both answers stand: the invitation lands, and the newer joined row is
    // not undone by the older listing that carried it.
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
      "no longer shared",
    );
  });

  // The initial load holds the surface at "loading" until its share lookup
  // answers. A badge read that lands during that wait is NEWER than the
  // snapshot that load is carrying, and dropping it leaves the stale counts on
  // screen until the next event.
  it("keeps a badge result that lands while the first load is still waiting", async () => {
    let answerFirstShares!: (value: {
      granted: unknown[];
      received: unknown[];
      joined: unknown[];
    }) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerFirstShares = resolve;
        });
      }
      return Promise.resolve({ granted: [], received: [], joined: [] });
    });
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      // The first load's snapshot is already old by the time it is displayed.
      return Promise.resolve({
        channels: [channel({ unreadCount: reads === 1 ? 2 : 5 })],
        fileThreads: [],
      });
    });
    renderView();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();

    // A write lands while the first load still waits on its share lookup.
    act(() => emitWorkspaceActivity());
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("5");

    // The first load finally answers. Its channels are older; its shares are
    // still the only answer to a question the badge read never asked.
    await act(async () => {
      answerFirstShares({ granted: [], received: [], joined: [] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("chats-channel-unread").textContent).toBe("5");
  });

  // The badge drain must not be held by a request that may never return. The
  // grant side lives on the relay behind an unbounded fetch; what this reader
  // needs — which channels THIS machine joined — is local.
  it("keeps refreshing badges while the relay-backed share lookup hangs", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve({ granted: [], received: [], joined: [joinedRow] });
      }
      // The relay stopped answering, and nothing bounds that wait.
      return new Promise(() => {});
    });
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({
        channels: [channel({ wireId: "wire-joined", unreadCount })],
        fileThreads: [],
      }),
    );
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({ joined: [joinedRow] });
    renderView();
    await screen.findByTestId("chats-channel-shared");

    unreadCount = 1;
    act(() => emitWorkspaceActivity());
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("1");

    // The second write still gets through: no request is holding the drain.
    unreadCount = 4;
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-unread").textContent).toBe("4"),
    );
    expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1);
  });

  // Another mounted Chats view joins this workspace's FIRST shared channel.
  // The listing then carries a channel this view has no grant row for, and a
  // channel with no grant row reads as this workspace's own: sharing offered
  // on someone else's channel, and a composer on a read-only grant.
  it("resolves the first shared channel a view learns about from a write", async () => {
    const sharedChannel = channel({
      id: "channel-shared",
      name: "shared-one",
      slug: "shared-one",
      wireId: "wire-shared",
    });
    let channelsIncludeShared = false;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({
        channels: channelsIncludeShared ? [channel(), sharedChannel] : [channel()],
        fileThreads: [],
      }),
    );
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-name");

    // The other view joins, so the registry now has a read-only grant and the
    // channel is pulled locally. This view hears about it as workspace activity.
    channelsIncludeShared = true;
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [
        {
          shareId: "share-joined",
          channelWireId: "wire-shared",
          granterEmail: "owner@example.com",
          access: "read-only" as const,
          ended: false,
        },
      ],
    });
    act(() => emitWorkspaceActivity());

    await waitFor(() =>
      expect(screen.getAllByTestId("chats-channel")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "Shared by owner@example.com — read-only",
      ),
    );

    // Opening it is honest: read-only, and no composer to post with.
    await user.click(screen.getAllByTestId("chats-channel")[1]);
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  // The other side of that rule. While the share metadata is unresolved there
  // is nothing to correct, and a badge pass that claimed the joined lane
  // anyway would starve the listing that owns BOTH lanes — leaving "unknown"
  // on screen, which locks every channel including this workspace's own.
  it("lets the first share listing settle even when a badge pass ran first", async () => {
    let answerShares!: (value: {
      granted: unknown[];
      received: unknown[];
      joined: unknown[];
    }) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerShares = resolve;
        });
      }
      return Promise.resolve({ granted: [], received: [], joined: [] });
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(shareReads).toBe(1));

    // A write lands before the share metadata has resolved.
    act(() => emitWorkspaceActivity());
    await screen.findByTestId("chats-channel-name");

    await act(async () => {
      answerShares({ granted: [], received: [], joined: [] });
      await Promise.resolve();
    });

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // A refresh nobody asked for must not take the surface down to a spinner
  // before it knows anything: it commits nothing on failure, so the error card
  // and its Try again would never come back.
  it("leaves the retry on screen when a background refresh fails over an error", async () => {
    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    const navigator = (readRevision: number) => (
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        onOpenInTab={vi.fn()}
        readRevision={readRevision}
      />
    );
    const view = render(navigator(0));
    // The mount refresh is the user's, so it reports its failure.
    expect(await screen.findByText("Try again")).toBeTruthy();

    // A read lands; that background refresh fails too, and says nothing.
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    // The way out is still on screen, and it still works.
    expect(screen.getByText("Try again")).toBeTruthy();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    await userEvent.click(screen.getByText("Try again"));
    expect((await screen.findByTestId("chats-channel-name")).textContent).toBe("general");
  });

  // The same rule on the share lanes. A background lookup that REJECTS holds
  // no answer about the grants either, and committing "unknown" for it locks
  // every channel — including this workspace's own.
  it("does not lock every channel when a background share lookup rejects", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let shareReads = 0;
    let answerMount!: (value: {
      granted: unknown[];
      received: unknown[];
      joined: unknown[];
    }) => void;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerMount = resolve;
        });
      }
      return Promise.reject(new Error("signed out"));
    });
    // No onOpenInTab: this instance navigates in place, so the channel view is
    // reachable. With it, clicking a channel hands off to the shell instead.
    const navigator = (readRevision: number) => (
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        readRevision={readRevision}
      />
    );
    const user = userEvent.setup();
    const view = render(navigator(0));
    await waitFor(() => expect(shareReads).toBe(1));

    // A read lands while the mount's lookup is still out. That background
    // refresh's lookup rejects.
    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));

    // The request the surface was waiting on answers, and it is believed.
    await act(async () => {
      answerMount({ granted: [], received: [], joined: [] });
      await Promise.resolve();
    });

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // ONE listing in flight is what keeps an activity storm off the relay, and
  // the slot is the whole mechanism. A drain that has been superseded must not
  // hand it back when it finally gives up, or the next write opens a second
  // listing beside the one already running.
  it("does not open a second listing when a superseded drain finishes", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let answerAbandoned!: (value: ChannelListPage) => void;
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      // 2 is the drain the navigation abandons; it answers late. 4 is the
      // drain that owns the slot afterwards, and it stays in flight.
      if (reads === 2) {
        return new Promise<ChannelListPage>((resolve) => {
          answerAbandoned = resolve;
        });
      }
      if (reads >= 4) return new Promise<ChannelListPage>(() => {});
      return Promise.resolve({ channels: [channel()], fileThreads: [] });
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-name");

    // A write starts a drain, then a navigation leaves it behind.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(reads).toBe(3));

    // The next write starts the drain that now owns the slot.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(4);

    // The abandoned drain answers and gives up. The slot is not its to release.
    await act(async () => {
      answerAbandoned({ channels: [channel()], fileThreads: [] });
      await Promise.resolve();
    });
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(4);
  });

  // A pass queued before a navigation belongs to the era it was queued in.
  // Running it afterwards would put another listing on the relay for a write
  // the navigation's own refresh has already accounted for.
  it("drops a queued pass that a navigation has moved past", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [joinedRow],
    });
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({
        channels: [channel({ wireId: "wire-joined" })],
        fileThreads: [],
      }),
    );
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let answerCorrection!: (value: { joined: unknown[] }) => void;
    bridgeMock.listJoinedSharedChannels.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerCorrection = resolve;
        }),
    );
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-shared");

    // A write starts a pass; it is inside its joined-grant read.
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listJoinedSharedChannels).toHaveBeenCalled());
    // A second write queues one more pass onto it.
    act(() => emitWorkspaceActivity());
    const readsBeforeNavigation = bridgeMock.listChatChannels.mock.calls.length;

    // The user navigates, which refreshes the list on its own account.
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() =>
      expect(bridgeMock.listChatChannels.mock.calls.length).toBe(
        readsBeforeNavigation + 1,
      ),
    );

    // The pass finishes. Its queued successor belongs to the era before the
    // navigation, so it does not run.
    await act(async () => {
      answerCorrection({ joined: [joinedRow] });
      await Promise.resolve();
    });
    expect(bridgeMock.listChatChannels.mock.calls.length).toBe(
      readsBeforeNavigation + 1,
    );
  });

  // A background failure is fast when the relay is refusing, and the load it
  // lands on top of is slow. The failure holds no answer for the list, so it
  // must not take the lane away from the request that does.
  it("does not strand the first load behind a background failure", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let answerFirstLoad!: (value: ChannelListPage) => void;
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return new Promise<ChannelListPage>((resolve) => {
          answerFirstLoad = resolve;
        });
      }
      return Promise.reject(new Error("offline"));
    });
    const navigator = (readRevision: number) => (
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        onOpenInTab={vi.fn()}
        readRevision={readRevision}
      />
    );
    const view = render(navigator(0));
    await waitFor(() => expect(reads).toBe(1));

    // The editor reports a read; that background refresh fails immediately.
    view.rerender(navigator(1));
    await waitFor(() => expect(reads).toBe(2));

    // The first load answers. It is the request the surface was waiting on.
    await act(async () => {
      answerFirstLoad({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      await Promise.resolve();
    });

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");
    expect(screen.queryByText("Try again")).toBeNull();
  });

  // The channel listing itself syncs shared channels over the relay before it
  // reads, so it can stall too. Once a navigation has moved past that read it
  // can commit nothing, and a later write must not queue behind it.
  it("frees the badge drain once a navigation leaves its read behind", async () => {
    let reads = 0;
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 2) return new Promise(() => {});
      return Promise.resolve({
        channels: [channel({ unreadCount })],
        fileThreads: [],
      });
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-name");

    // A write starts a badge read that never comes back.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);

    // The user opens a channel and comes back. That read can commit nothing now.
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(reads).toBe(3));

    // The next write is not stranded behind the abandoned read.
    unreadCount = 9;
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(4);
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("9");
  });

  // A failed lookup learned nothing. "Unknown" is a state of the whole share
  // listing, so a response that no longer owns both lanes must not write it:
  // doing so throws away a newer joined-grant answer and locks every channel.
  it("does not let a failed share lookup undo a newer joined correction", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    const joinedChannel = channel({
      id: "channel-joined",
      name: "joined-one",
      slug: "joined-one",
      wireId: "wire-joined",
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), joinedChannel],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let failFullRead!: () => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve({ granted: [], received: [], joined: [joinedRow] });
      }
      // The refresh the user's back-navigation owns. It stalls, then fails.
      return new Promise((_resolve, reject) => {
        failFullRead = () => reject(new Error("signed out"));
      });
    });
    // The badge pass's local read, issued later: the sync recorded the revoke.
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    const user = userEvent.setup();
    renderView();

    // Back out of a channel: goBack owns a foreground overview refresh, whose
    // share lookup is the one that will fail.
    await waitFor(() => expect(screen.getAllByTestId("chats-channel")).toHaveLength(2));
    await user.click(screen.getAllByTestId("chats-channel")[0]);
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(shareReads).toBe(2));

    // A write lands, and the badge pass corrects the joined grant.
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "no longer shared",
      ),
    );

    // Now the older lookup fails.
    await act(async () => {
      failFullRead();
      await Promise.resolve();
    });

    // The correction stands, and nothing locked behind a response that
    // learned nothing: the owned channel still has its composer.
    expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
      "no longer shared",
    );
    await user.click(screen.getAllByTestId("chats-channel")[0]);
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // The other half of the same rule: a failed lookup that DOES own both lanes
  // must still settle the state, or the share controls wait forever. Unknown
  // fails closed.
  it("commits unknown when the share lookup fails with nothing newer to keep", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();

    // The mount resolved the share metadata: the owned channel is writable.
    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();

    // Back out: that refresh owns both lanes, and its lookup fails.
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2),
    );

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-readonly-note")).toBeTruthy();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  // The channel listing syncs joined shared channels BEFORE it reads, and that
  // sync records a revoked or downgraded grant. Those joined rows are local, so
  // they are answered even while the relay is down — and until they land, the
  // composer stays enabled on a channel main will refuse to accept posts for.
  it("corrects a joined grant the listing's sync revoked, and keeps the cached invitation", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    const invitation = {
      shareId: "share-invite",
      channelWireId: "wire-invite",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-joined" })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [invitation],
      joined: [joinedRow],
    });
    renderView();
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared by owner@example.com",
    );
    expect(screen.getByTestId("chats-channel-shared").textContent).not.toContain(
      "no longer shared",
    );

    // The sync finds the grant revoked and records it in the registry, which
    // is what the local read reports.
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    act(() => emitWorkspaceActivity());

    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "no longer shared",
      ),
    );
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // Activity fires for every settled file batch and run update, and the
  // channel listing syncs shared channels over the relay before it reads.
  it("keeps one channel listing in flight through an activity storm, then catches up once", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    const deferred: Array<(value: ChannelListPage) => void> = [];
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({ channels: [channel()], fileThreads: [] });
      }
      return new Promise<ChannelListPage>((resolve) => deferred.push(resolve));
    });
    renderView();
    await screen.findByTestId("chats-channel-name");

    act(() => {
      emitWorkspaceActivity();
      emitWorkspaceActivity();
      emitWorkspaceActivity();
    });
    // Three unrelated writes, one relay-backed listing.
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2);

    await act(async () => {
      deferred[0]({ channels: [channel({ unreadCount: 1 })], fileThreads: [] });
      await Promise.resolve();
    });
    // The events that arrived mid-read are not lost — they cost ONE catch-up.
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3));
    await act(async () => {
      deferred[1]({ channels: [channel({ unreadCount: 5 })], fileThreads: [] });
      await Promise.resolve();
    });

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("5");
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3);
  });

  // A refresh nobody asked for must not spend the answer to one the user did:
  // back-navigation, Join, Leave and the retry button all own an overview
  // request, and losing one leaves a completed action invisible.
  it("does not discard a user-owned overview refresh that activity lands on top of", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    const deferred: Array<(value: ChannelListPage) => void> = [];
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({ channels: [channel()], fileThreads: [] });
      }
      return new Promise<ChannelListPage>((resolve) => deferred.push(resolve));
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();

    // Back out of a channel: goBack owns an explicit overview refresh.
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(deferred.length).toBe(1));

    // A file save lands while that refresh is still in flight, and the badge
    // read it starts fails.
    bridgeMock.listChatChannels.mockRejectedValueOnce(new Error("offline"));
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3));

    // The user's refresh answers, and its answer is still the one that counts.
    await act(async () => {
      deferred[0]({
        channels: [
          channel(),
          channel({ id: "channel-launch", name: "launch", slug: "launch" }),
        ],
        fileThreads: [],
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getAllByTestId("chats-channel-name").map((node) => node.textContent),
      ).toContain("launch"),
    );
  });
});

describe("ChatsView decisions", () => {
  it("resolves from composer mode and uses the literal fallback for an empty reply", async () => {
    const user = userEvent.setup();
    const opening = message();
    const openDecision = {
      threadId: "thread-1",
      messageId: opening.id,
      state: "open" as const,
      atMs: NOW,
    };
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openDecisionCount: 1 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [openDecision] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({
        id: "resolution-message",
        parentMessageId: opening.id,
        body: "Resolved ✓",
      }),
    });
    bridgeMock.resolveChatDecision.mockResolvedValue({
      decision: {
        ...openDecision,
        state: "resolved",
        resolvedByMessageId: "resolution-message",
        atMs: NOW + 1,
      },
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    expect(await screen.findByTestId("chats-message-decision-open")).toBeTruthy();
    await user.click(screen.getByTestId("chats-message-decision-resolve"));
    expect(screen.getByTestId("chats-resolving-mode").textContent).toContain(
      "Resolving decision — your reply records it",
    );
    expect(screen.getByTestId("chats-replying-mode").textContent).toContain(
      "Replying to You",
    );
    await user.click(screen.getByTestId("chats-send"));

    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: "message-1",
        body: "Resolved ✓",
      }),
    );
    await waitFor(() =>
      expect(bridgeMock.resolveChatDecision).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        messageId: "message-1",
        resolvedByMessageId: "resolution-message",
      }),
    );
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(screen.queryByTestId("chats-resolving-mode")).toBeNull();
  });

  it("does not decrement again when a refreshed decision is already resolved", async () => {
    const user = userEvent.setup();
    const opening = message({ body: "Resolve this" });
    const otherMessage = message({
      id: "message-other-decision",
      parentMessageId: opening.id,
      body: "Keep this decision open",
    });
    const targetOpen = {
      threadId: "thread-1",
      messageId: opening.id,
      state: "open" as const,
      atMs: NOW,
    };
    const targetResolved = {
      ...targetOpen,
      state: "resolved" as const,
      resolvedByMessageId: "resolution-message",
      atMs: NOW + 1,
    };
    const otherOpen = {
      threadId: "thread-1",
      messageId: otherMessage.id,
      state: "open" as const,
      atMs: NOW,
    };
    const resolutionMessage = message({
      id: "resolution-message",
      parentMessageId: opening.id,
      body: "Resolved ✓",
    });
    let refreshed = false;
    bridgeMock.listChannelThreads.mockImplementation(() =>
      Promise.resolve({
        threads: [thread({ openDecisionCount: refreshed ? 1 : 2 })],
      }),
    );
    bridgeMock.listChatMessages.mockImplementation(() =>
      Promise.resolve({
        messages: refreshed
          ? [opening, otherMessage, resolutionMessage]
          : [opening, otherMessage],
      }),
    );
    bridgeMock.listChatThreadDecisions.mockImplementation(() =>
      Promise.resolve({
        decisions: refreshed
          ? [targetResolved, otherOpen]
          : [targetOpen, otherOpen],
      }),
    );
    bridgeMock.sendChatMessage.mockResolvedValue({ message: resolutionMessage });
    let resolveDecision!: (value: { decision: typeof targetResolved }) => void;
    const pendingResolution = new Promise<{ decision: typeof targetResolved }>(
      (resolve) => {
        resolveDecision = resolve;
      },
    );
    bridgeMock.resolveChatDecision.mockImplementation(() => pendingResolution);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-message-decision-resolve"));
    await user.click(screen.getByTestId("chats-send"));
    await waitFor(() => expect(bridgeMock.resolveChatDecision).toHaveBeenCalledTimes(1));

    refreshed = true;
    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(await screen.findByTestId("chats-comment-decision-open")).toBeTruthy();

    await act(async () => {
      resolveDecision({ decision: targetResolved });
      await pendingResolution;
    });

    expect(screen.getAllByTestId("chats-comment-decision-open")).toHaveLength(1);
    expect(screen.getByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(screen.getByTestId("chats-thread-view").dataset.openDecisionCount).toBe(
      "1",
    );
    expect(
      reconcileResolvedChatDecision(
        [targetResolved, otherOpen],
        targetResolved,
      ).wasOpen,
    ).toBe(false);
  });

  it("appends a resolved decision that was absent from the current snapshot", () => {
    const resolved = {
      threadId: "thread-1",
      messageId: "message-late-resolution",
      state: "resolved" as const,
      resolvedByMessageId: "message-resolution",
      atMs: NOW,
    };

    const reconciliation = reconcileResolvedChatDecision([], resolved);

    expect(reconciliation.wasOpen).toBe(false);
    expect(reconciliation.decisions).toEqual([resolved]);
  });
});

describe("ChatsView work and run links", () => {
  it("renders a redacted shared attachment as an opaque attachment chip", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.listChatThreadAttachments.mockResolvedValue({
      attachments: [
        {
          attachmentId: "attachment-redacted",
          threadId: "thread-1",
          messageId: "message-1",
          targetKind: "file",
          createdAtMs: NOW,
        },
      ],
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const chip = await screen.findByTestId("chats-attachment-chip");
    expect(chip.textContent).toBe("attachment");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("title")).toBeNull();
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("opens attachment paths and shows linked agent-run details", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    const opening = message();
    const agentComment = message({
      id: "agent-report",
      parentMessageId: opening.id,
      authorKind: "agent",
      authorDisplayName: "You",
      body: "I finished the review.",
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 2 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening, agentComment] });
    bridgeMock.listChatThreadAttachments.mockResolvedValue({
      attachments: [
        {
          attachmentId: "attachment-1",
          threadId: "thread-1",
          messageId: opening.id,
          targetKind: "file",
          objectId: "object-1",
          pathHint: "projects/launch/brief.md",
          createdAtMs: NOW,
        },
      ],
    });
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({
      runs: {
        [agentComment.id]: {
          runId: "run-123456789",
          threadId: "thread-1",
          triggerMessageId: opening.id,
          command: "dohc agent run review",
          startedAtMs: NOW,
          exitCode: 0,
          logPath: "logs/run-123456789.log",
        },
      },
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const attachment = await screen.findByTestId("chats-attachment-chip");
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledTimes(1);
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
    expect(attachment.textContent).toContain("brief.md");
    expect(attachment.getAttribute("title")).toBe("projects/launch/brief.md");
    await user.click(attachment);
    expect(onOpenPath).toHaveBeenCalledWith("projects/launch/brief.md");

    const runChip = screen.getByTestId("chats-run-chip");
    expect(runChip.textContent).toBe("run run-123");
    await user.click(runChip);
    expect(screen.getByTestId("chats-run-command").textContent).toBe(
      "dohc agent run review",
    );
    expect(screen.getByTestId("chats-run-exit-code").textContent).toBe("0");
    expect(screen.getByTestId("chats-run-log-path").textContent).toBe(
      "logs/run-123456789.log",
    );
    await user.click(screen.getByTestId("chats-run-copy-log"));
    expect(bridgeMock.writeClipboardText).toHaveBeenCalledWith({
      text: "logs/run-123456789.log",
    });
  });
});

describe("ChatsView dispatch state", () => {
  it("shows working and queued state for this thread and stops its live run", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread
      .mockResolvedValueOnce({ liveRun: true, pendingCount: 2, paused: false })
      .mockResolvedValue({ liveRun: false, pendingCount: 0, paused: false });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "agent working · 2 queued",
    );
    await user.click(screen.getByTestId("chats-stop-agent-run"));
    expect(bridgeMock.stopAgentRun).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("chats-dispatch-status")).toBeNull(),
    );
  });

  it("shows a paused status and resumes the open thread in place", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread
      .mockResolvedValueOnce({
        liveRun: false,
        pendingCount: 3,
        paused: true,
        pausedReason: "budget",
      })
      .mockResolvedValue({ liveRun: false, pendingCount: 3, paused: false });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    const status = await screen.findByTestId("chats-dispatch-status");
    expect(status.textContent).toBe("dispatch paused — Resume");
    expect(status.getAttribute("title")).toBe("budget");
    await user.click(screen.getByTestId("chats-resume-dispatch"));
    expect(bridgeMock.resumeThreadDispatch).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "3 queued",
    );
  });
});

describe("ChatsView mentions", () => {
  it("renders @-mention chips in message bodies", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({
          id: "m-ask",
          authorKind: "agent",
          authorDisplayName: "ice@dohc.ai",
          body: "@you which draft should I keep?",
        }),
      ],
    });
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const chip = await screen.findByTestId("chats-message-body-mention");
    expect(chip.textContent).toBe("@you");
    expect(chip.getAttribute("data-mention-kind")).toBe("user");
  });

  it("does not render a mention chip for an @handle inside inline code", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({
          id: "m-code",
          authorKind: "agent",
          authorDisplayName: "ice@dohc.ai",
          body: "set `@you = owner` in the config",
        }),
      ],
    });
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-message-body");
    // No chip is rendered for the backticked handle.
    expect(screen.queryByTestId("chats-message-body-mention")).toBeNull();
  });

  it("fires a single send for a synchronous double-Enter", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    let resolveSend!: (value: { message: ChatMessageRecord }) => void;
    bridgeMock.sendChatMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await user.type(composer, "@agent look");

    // Two Enter keydowns in the SAME tick (no await between): the synchronous
    // in-flight ref must swallow the second so only ONE send goes out.
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter" });
    resolveSend({ message: message({ id: "m-new", body: "@agent look" }) });

    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));
  });

  it("shows an 'Addressed to me' inbox for agent asks and opens them", async () => {
    const user = userEvent.setup();
    const onOpenAddressed = vi.fn();
    const notice = {
      id: "workspace-a::run-1::asked",
      kind: "asked" as const,
      workspaceId: "workspace-a",
      workspaceName: "Personal",
      agentName: "You's agent",
      runId: "run-1",
      title: "Your agent has a question",
      body: "Which draft should I keep?",
      createdAtMs: NOW,
    };
    renderView(vi.fn(), vi.fn(), { addressedToMe: [notice], onOpenAddressed });

    const item = await screen.findByTestId("chats-addressed-item");
    expect(item.textContent).toContain("Which draft should I keep?");
    await user.click(item);
    expect(onOpenAddressed).toHaveBeenCalledWith(notice);
  });
});

describe("ChatsView read cursors", () => {
  it("opening an unread thread marks it read and clears the badge", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [
        thread({ messageCount: 3, lastReadSequence: 1, unreadCount: 2 }),
        thread({ id: "thread-2", title: "Untouched", unreadCount: 1 }),
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message(), message({ id: "m2" }), message({ id: "m3" })],
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findAllByTestId("chats-thread-unread")).toHaveLength(2);

    await user.click(screen.getAllByTestId("chats-thread")[0]);
    await waitFor(() =>
      expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        upToSequence: 3,
      }),
    );

    // Back in the channel, the opened thread's badge is gone; the untouched
    // thread keeps its badge (goBack refetches — keep the mock stable).
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [
        thread({ messageCount: 3, lastReadSequence: 3, unreadCount: 0 }),
        thread({ id: "thread-2", title: "Untouched", unreadCount: 1 }),
      ],
    });
    await user.click(screen.getByTestId("chats-thread-back"));
    await waitFor(() =>
      expect(screen.getAllByTestId("chats-thread-unread")).toHaveLength(1),
    );
  });

  it("keeps an unread thread unread when the workspace is read-only", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 3, lastReadSequence: 1, unreadCount: 2 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message(), message({ id: "m2" }), message({ id: "m3" })],
    });
    renderView(vi.fn(), vi.fn(), { readOnly: true });

    await userEvent.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-thread-unread")).textContent).toBe("2");
    await userEvent.click(screen.getByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("chats-thread-back"));
    expect((await screen.findByTestId("chats-thread-unread")).textContent).toBe("2");
  });
});

describe("ChatsView liveness", () => {
  it("drops a stale channel-thread response after navigating back", async () => {
    const user = userEvent.setup();
    let resolveThreads!: (value: { threads: ChannelThreadRecord[] }) => void;
    bridgeMock.listChannelThreads.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveThreads = resolve;
        }),
    );
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    // Navigate back BEFORE the thread list resolves.
    await user.click(screen.getByTestId("chats-channel-back"));
    resolveThreads({ threads: [thread({ title: "Stale thread" })] });

    await screen.findAllByTestId("chats-channel-name");
    expect(screen.queryByText("Stale thread")).toBeNull();
  });

  it("keeps a newer send busy when an abandoned thread send settles", async () => {
    const user = userEvent.setup();
    const firstThread = thread({ id: "thread-1", title: "First thread" });
    const secondThread = thread({ id: "thread-2", title: "Second thread" });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [firstThread, secondThread],
    });

    let resolveFirstSend!: (value: { message: ChatMessageRecord }) => void;
    let resolveSecondSend!: (value: { message: ChatMessageRecord }) => void;
    const firstSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const secondSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveSecondSend = resolve;
    });
    bridgeMock.sendChatMessage
      .mockImplementationOnce(() => firstSend)
      .mockImplementationOnce(() => secondSend);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click((await screen.findAllByTestId("chats-thread"))[0]!);
    await user.type(screen.getByTestId("chats-composer"), "First send{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click((await screen.findAllByTestId("chats-thread"))[1]!);
    const nextComposer = await screen.findByTestId("chats-composer");
    await user.clear(nextComposer);
    await user.type(nextComposer, "Second send{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      resolveFirstSend({
        message: message({
          id: "message-from-first-thread",
          threadId: firstThread.id,
          body: "First send",
        }),
      });
      await firstSend;
    });

    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText("First send")).toBeNull();

    await act(async () => {
      resolveSecondSend({
        message: message({
          id: "message-from-second-thread",
          threadId: secondThread.id,
          body: "Second send",
        }),
      });
      await secondSend;
    });

    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Second send")).toBeTruthy();
  });

  it("keeps a preserved draft locked when returning to its in-flight thread", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });

    let resolveSend!: (value: { message: ChatMessageRecord }) => void;
    const pendingSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveSend = resolve;
    });
    bridgeMock.sendChatMessage.mockImplementation(() => pendingSend);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Still sending{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    const restoredComposer = await screen.findByTestId("chats-composer");
    expect((restoredComposer as HTMLTextAreaElement).value).toBe("Still sending");
    expect((restoredComposer as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.submit(restoredComposer.closest("form")!);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend({
        message: message({
          id: "message-original-send",
          body: "Still sending",
        }),
      });
      await pendingSend;
    });

    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("");
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Still sending")).toBeTruthy();
  });

  it("clears sent reply text after leave and return resets reply mode", async () => {
    const user = userEvent.setup();
    const opening = message();
    const parentComment = message({
      id: "comment-reply-parent",
      parentMessageId: opening.id,
      authorDisplayName: "Ana",
      body: "Can you confirm?",
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [opening, parentComment],
    });

    let resolveSend!: (value: { message: ChatMessageRecord }) => void;
    const pendingSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveSend = resolve;
    });
    bridgeMock.sendChatMessage.mockImplementation(() => pendingSend);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-comment-reply"));
    await user.type(screen.getByTestId("chats-composer"), "Confirmed{Enter}");
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: parentComment.id,
        body: "Confirmed",
      }),
    );

    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe(
      "Confirmed",
    );

    await act(async () => {
      resolveSend({
        message: message({
          id: "comment-sent-reply",
          parentMessageId: parentComment.id,
          body: "Confirmed",
        }),
      });
      await pendingSend;
    });

    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(screen.getByText("Confirmed")).toBeTruthy();
    fireEvent.submit(screen.getByTestId("chats-composer").closest("form")!);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});

// --- Shared channels (MU-C4) -----------------------------------------------

describe("ChatsView shared channels (MU-C4)", () => {
  const teamChannel = () =>
    channel({ id: "channel-team", name: "team", slug: "team", wireId: "wire-team" });

  it("fails closed when sharing metadata is unavailable", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    renderView();
    await screen.findByTestId("chats-channel-name");
    expect(screen.queryByTestId("chats-shared-with-you")).toBeNull();
    expect(screen.queryByTestId("chats-channel-shared")).toBeNull();
    // Entering the channel offers no share button either.
    await userEvent.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
  });

  it("keeps an owned local channel writable after authoritative empty share metadata", async () => {
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [],
    });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  it("uses the last authoritative joined row when duplicate wire rows exist", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-old",
          channelWireId: "wire-team",
          access: "read-only",
          granterEmail: "owner@example.com",
          ended: false,
        },
        {
          shareId: "share-current",
          channelWireId: "wire-team",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: false,
        },
      ],
    });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  it("marks a granted channel as shared and manages members through the share panel", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [
        {
          shareId: "share-1",
          channelWireId: "wire-team",
          access: "read-write",
          recipientEmail: "ana@example.com",
          revokedAtMs: null,
        },
      ],
      received: [],
      joined: [],
    });
    bridgeMock.shareChatChannel.mockResolvedValue({ shareId: "share-2" });
    bridgeMock.revokeRelayShare.mockResolvedValue(undefined);
    renderView();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared with 1",
    );

    await userEvent.click(screen.getByTestId("chats-channel"));
    const shareButton = await screen.findByTestId("chats-share-channel");
    expect(shareButton.textContent).toContain("Shared · 1");
    await userEvent.click(shareButton);

    // The member list shows who has it, and Remove revokes their grant.
    const member = await screen.findByTestId("chats-share-member");
    expect(member.textContent).toContain("ana@example.com");
    await userEvent.click(screen.getByTestId("chats-share-revoke"));
    await waitFor(() =>
      expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" }),
    );

    // Sharing to a new address, read-only via the checkbox.
    await userEvent.type(screen.getByTestId("chats-share-email"), "bo@example.com");
    await userEvent.click(screen.getByTestId("chats-share-readonly"));
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    await waitFor(() =>
      expect(bridgeMock.shareChatChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        channelId: "channel-team",
        recipientEmail: "bo@example.com",
        access: "read-only",
      }),
    );
  });

  it("lists invitations under Shared with you, joins one, and re-enables the other Join buttons", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [
        {
          shareId: "share-in",
          channelWireId: "wire-in",
          access: "read-write",
          granterEmail: "owner@example.com",
        },
        {
          shareId: "share-in-2",
          channelWireId: "wire-in-2",
          access: "read-write",
          granterEmail: "other@example.com",
        },
      ],
      joined: [],
    });
    bridgeMock.joinSharedChannel.mockResolvedValue({
      joined: {
        shareId: "share-in",
        channelWireId: "wire-in",
        access: "read-write",
        granterEmail: "owner@example.com",
        ended: false,
      },
    });
    renderView();
    const section = await screen.findByTestId("chats-shared-with-you");
    expect(section.textContent).toContain("owner@example.com");
    expect(section.textContent).toContain("other@example.com");
    await userEvent.click(screen.getAllByTestId("chats-join-shared")[0]!);
    await waitFor(() =>
      expect(bridgeMock.joinSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-in",
      }),
    );
    // The overview reloads after joining (channel + shares re-fetch).
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));
    // Regression (CodeRabbit critical): the join-in-flight flag must reset
    // after a successful join even though refreshOverview bumps the liveness
    // token — the OTHER invitation's Join button re-enables instead of
    // staying dead for the rest of the session.
    await waitFor(() => {
      const buttons = screen.getAllByTestId("chats-join-shared");
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      }
    });
  });

  it("offers an explicit rejoin action for an ended leave tombstone", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [
        {
          shareId: "share-return",
          channelWireId: "wire-return",
          access: "read-write",
          granterEmail: "owner@example.com",
        },
      ],
      joined: [
        {
          shareId: "share-return",
          channelWireId: "wire-return",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: true,
        },
      ],
    });
    bridgeMock.joinSharedChannel.mockResolvedValue({
      joined: {
        shareId: "share-return",
        channelWireId: "wire-return",
        access: "read-write",
        granterEmail: "owner@example.com",
        ended: false,
      },
    });

    renderView();

    const section = await screen.findByTestId("chats-shared-with-you");
    expect(section.textContent).toContain("owner@example.com");
    await userEvent.click(screen.getByTestId("chats-join-shared"));
    await waitFor(() =>
      expect(bridgeMock.joinSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-return",
      }),
    );
  });

  it("shows a joined channel's provenance, disables composers when read-only, and can leave", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-in",
          channelWireId: "wire-team",
          access: "read-only",
          granterEmail: "owner@example.com",
          ended: false,
        },
      ],
    });
    bridgeMock.leaveSharedChannel.mockResolvedValue(undefined);
    renderView();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared by owner@example.com — read-only",
    );

    await userEvent.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-joined-banner");
    // Read-only: the thread composer is replaced by an honest notice, and a
    // joined channel is never re-shareable from here.
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();

    await userEvent.click(screen.getByTestId("chats-leave-shared"));
    await waitFor(() =>
      expect(bridgeMock.leaveSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-in",
      }),
    );
  });

  it("keeps a feed deep link into a joined channel read-only", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-in",
          channelWireId: "wire-team",
          access: "read-only",
          granterEmail: "owner@example.com",
          ended: false,
        },
      ],
    });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message({ body: "Shared update", threadId: "thread-1" }),
          thread: thread({
            channelId: "channel-team",
            messageCount: 1,
            lastReadSequence: 0,
            unreadCount: 1,
          }),
          channel: {
            id: "channel-team",
            wireId: "wire-team",
            name: "team",
            slug: "team",
            kind: "channel",
          },
          reactions: [],
          matchedBy: ["channel"],
        },
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ body: "Shared update", threadId: "thread-1" })],
    });

    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const update = await screen.findByText("Shared update");
    await userEvent.click(update.closest("button")!);

    await screen.findByTestId("chats-thread-view");
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-composer")).toBeNull();
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();
  });

  it("does not mark a thread read after its joined channel has ended", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-in",
          channelWireId: "wire-team",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: true,
        },
      ],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [
        thread({
          channelId: "channel-team",
          messageCount: 1,
          lastReadSequence: 0,
          unreadCount: 1,
        }),
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");

    expect(screen.queryByTestId("chats-composer")).toBeNull();
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();
  });

  it("keeps a read-write joined channel's composer and blocks it once the share ends", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-in",
          channelWireId: "wire-team",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: false,
        },
      ],
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-joined-banner");
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    cleanup();

    // The same channel after revocation (ended): still readable, no posting.
    bridgeMock.listChatChannelShares.mockResolvedValue({
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-in",
          channelWireId: "wire-team",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: true,
        },
      ],
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    const note = await screen.findByTestId("chats-readonly-note");
    expect(note.textContent).toContain("no longer shared");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });
});

// Direct messages (WS-MU-C3): participants-only conversations behind the
// collaboration gate. Solo (available:false, no DMs) renders NOTHING — the
// zero-bloat rule — and the DM conversation is one running thread whose
// composer sends on Enter (anti-forum).
describe("ChatsView direct messages", () => {
  it("shows no DM surface at all for a solo user", async () => {
    // Even a stray dm-kind channel row never leaks into the channel list.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({ id: "channel-dm-1", name: "bob@example.com", slug: "bob-example-com", kind: "dm" }),
      ],
      fileThreads: [],
    });
    renderView();
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-dms-section")).toBeNull();
    expect(screen.queryByTestId("chats-new-dm")).toBeNull();
    const names = screen.getAllByTestId("chats-channel-name").map((el) => el.textContent);
    expect(names).toEqual(["general"]);
  });

  it("lists DMs by peer label with unread badges when collaboration is on", async () => {
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [
        dm({ peerLabel: "bob@example.com", unreadCount: 2 }),
        dm({
          channelId: "channel-dm-2",
          channelWireId: "wire-dm-2",
          role: "participant",
          peerLabel: "carol@example.com",
          connected: false,
        }),
      ],
    });
    renderView();
    await screen.findByTestId("chats-dms-section");
    const names = screen.getAllByTestId("chats-dm-name").map((el) => el.textContent);
    expect(names).toEqual(["bob@example.com", "carol@example.com"]);
    expect(screen.getByTestId("chats-dm-unread").textContent).toBe("2");
    expect(screen.getByTestId("chats-new-dm")).toBeTruthy();
  });

  it("scrolls and highlights a canonical DM backlink's focused message", async () => {
    const focused = message({
      id: "message-focus",
      threadId: "thread-dm-1",
      body: "Focused DM mention",
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [focused] });
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: {
        level: "dm",
        dm: dm(),
        focusMessageId: focused.id,
      },
    });

    expect(await screen.findByText("Focused DM mention")).toBeTruthy();
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    });
    expect(screen.getByTestId("chats-dm-message").className).toContain("ring-2");
  });

  it("clears focused-message state and refs when a DM is opened normally", async () => {
    const user = userEvent.setup();
    const focused = message({
      id: "message-focus",
      threadId: "thread-dm-1",
      body: "Same id, different navigation",
    });
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm()] })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [focused] });

    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: {
        level: "dm",
        dm: dm(),
        focusMessageId: focused.id,
      },
    });

    const initiallyFocused = await screen.findByTestId("chats-dm-message");
    await waitFor(() => expect(initiallyFocused.className).toContain("ring-2"));

    await user.click(screen.getByTestId("chats-dm-back"));
    await user.click(await screen.findByTestId("chats-dm-item"));
    const normallyOpened = await screen.findByTestId("chats-dm-message");
    expect(normallyOpened.className).not.toContain("ring-2");
  });

  it("opens a DM into its single running conversation and sends on Enter", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm({ unreadCount: 2 })] })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({ id: "m-1", threadId: "thread-dm-1", authorDisplayName: "bob@example.com", body: "hey" }),
      ],
    });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "m-2", threadId: "thread-dm-1", body: "hi bob" }),
    });
    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    expect(screen.getByTestId("chats-dm-title").textContent).toBe("bob@example.com");
    const bodies = await screen.findAllByTestId("chats-dm-message-body");
    expect(bodies.map((el) => el.textContent)).toEqual(["hey"]);
    // On-screen == read: the cursor advances like the thread view.
    await waitFor(() =>
      expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
        upToSequence: 1,
      }),
    );
    await user.type(screen.getByTestId("chats-dm-composer"), "hi bob{Enter}");
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
        body: "hi bob",
      }),
    );
    const updated = await screen.findAllByTestId("chats-dm-message-body");
    expect(updated[updated.length - 1].textContent).toBe("hi bob");

    await user.click(screen.getByTestId("chats-dm-back"));
    await screen.findByTestId("chats-dm-item");
    expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
  });

  it("keeps syncing an open pending DM until its thread arrives", async () => {
    const user = userEvent.setup();
    const pendingDm = dm({ threadId: null });
    const hydratedDm = dm();
    let resolveOpenSync!: (result: {
      available: boolean;
      dms: DmRecord[];
    }) => void;
    const openSync = new Promise<{ available: boolean; dms: DmRecord[] }>(
      (resolve) => {
        resolveOpenSync = resolve;
      },
    );
    const laterRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [pendingDm] })
      .mockImplementationOnce(() => openSync)
      .mockImplementation(() => laterRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({
          id: "message-dm-arrived",
          threadId: "thread-dm-1",
          body: "The conversation arrived",
        }),
      ],
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByTestId("chats-dm-waiting")).toBeTruthy();
    await waitFor(() => expect(bridgeMock.syncDms).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveOpenSync({ available: true, dms: [hydratedDm] });
      await openSync;
    });

    expect(await screen.findByText("The conversation arrived")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-waiting")).toBeNull();
    expect(bridgeMock.syncDms).toHaveBeenCalledTimes(2);
  });

  it("toggles reactions against the open DM thread", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm()] })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({
          id: "message-dm-reaction",
          threadId: "thread-dm-1",
          body: "React here",
        }),
      ],
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByText("React here")).toBeTruthy();
    await user.click(screen.getByTestId("chats-dm-add-reaction"));
    const thumbsUp = screen
      .getAllByTestId("chats-dm-reaction-choice")
      .find((button) => button.getAttribute("data-emoji") === "👍");
    expect(thumbsUp).toBeTruthy();
    await user.click(thumbsUp!);

    await waitFor(() =>
      expect(bridgeMock.setChatReaction).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
        messageId: "message-dm-reaction",
        emoji: "👍",
        state: "added",
      }),
    );
  });

  it("drops older DM refreshes after a newer snapshot and local send", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm()] })
      .mockImplementation(() => pendingRefresh);

    let resolveOlder!: (result: { messages: ChatMessageRecord[] }) => void;
    let resolveNewer!: (result: { messages: ChatMessageRecord[] }) => void;
    const older = new Promise<{ messages: ChatMessageRecord[] }>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<{ messages: ChatMessageRecord[] }>((resolve) => {
      resolveNewer = resolve;
    });
    bridgeMock.listChatMessages
      .mockResolvedValueOnce({
        messages: [
          message({
            id: "message-dm-baseline",
            threadId: "thread-dm-1",
            body: "Baseline",
          }),
        ],
      })
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({
        id: "message-dm-local",
        threadId: "thread-dm-1",
        body: "Local send",
      }),
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByText("Baseline")).toBeTruthy();

    act(() => emitWorkspaceActivity());
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(3),
    );
    await act(async () => {
      resolveNewer({
        messages: [
          message({
            id: "message-dm-newer",
            threadId: "thread-dm-1",
            body: "Newer snapshot",
          }),
        ],
      });
      await newer;
    });
    expect(await screen.findByText("Newer snapshot")).toBeTruthy();

    await user.type(screen.getByTestId("chats-dm-composer"), "Local send{Enter}");
    await waitFor(() => expect(screen.getByText("Local send")).toBeTruthy());

    await act(async () => {
      resolveOlder({
        messages: [
          message({
            id: "message-dm-stale",
            threadId: "thread-dm-1",
            body: "Stale snapshot",
          }),
        ],
      });
      await older;
    });

    expect(screen.queryByText("Stale snapshot")).toBeNull();
    expect(
      screen.getAllByTestId("chats-dm-message-body").map((node) => node.textContent),
    ).toEqual(["Newer snapshot", "Local send"]);
  });

  it("does not advance a DM read cursor in a read-only workspace", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ id: "m-1", threadId: "thread-dm-1", body: "shared DM" })],
    });
    renderView(vi.fn(), vi.fn(), {
      readOnly: true,
      variant: "page",
      initialNav: { level: "dm", dm: dm({ unreadCount: 2 }) },
    });

    expect(await screen.findByText("shared DM")).toBeTruthy();
    expect(screen.getByTestId("chats-workspace-readonly-note")).toBeTruthy();
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();
  });

  it("starts a new DM from the recipient step and opens the conversation", async () => {
    const user = userEvent.setup();
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [] });
    bridgeMock.startDm.mockResolvedValue({
      dm: dm(),
      message: message({ id: "m-1", threadId: "thread-dm-1", body: "hello there" }),
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ id: "m-1", threadId: "thread-dm-1", body: "hello there" })],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-new-dm"));
    await user.type(screen.getByTestId("chats-dm-recipients"), "bob@example.com");
    const composer = screen.getByTestId("chats-dm-new-composer");
    fireEvent.change(composer, {
      target: { value: "hello there @[docs/plan.md#scope]" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(bridgeMock.startDm).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        recipients: "bob@example.com",
        body: "hello there @[docs/plan.md#scope]",
        fileReferences: [{ path: "docs/plan.md", headingAnchor: "scope" }],
      }),
    );
    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    const bodies = await screen.findAllByTestId("chats-dm-message-body");
    expect(bodies.map((el) => el.textContent)).toEqual(["hello there"]);
  });

  it("clears a stale recipient/draft when backing out of New message and reopening it", async () => {
    // Backing out of compose without sending must NOT leave the old recipients
    // pre-filled — a user who reopens compose and types + sends could otherwise
    // misdirect their message to the wrong person.
    const user = userEvent.setup();
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [] });
    renderView();
    await user.click(await screen.findByTestId("chats-new-dm"));
    await user.type(screen.getByTestId("chats-dm-recipients"), "stale@example.com");
    expect((screen.getByTestId("chats-dm-recipients") as HTMLInputElement).value).toBe(
      "stale@example.com",
    );
    // Back out, then reopen: the "To:" field must be empty again.
    await user.click(screen.getByTestId("chats-dm-new-back"));
    await user.click(await screen.findByTestId("chats-new-dm"));
    expect((screen.getByTestId("chats-dm-recipients") as HTMLInputElement).value).toBe("");
  });

  it("closes the composer for an ended DM but keeps the conversation readable", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({
        available: true,
        dms: [
          dm({
            role: "participant",
            peerLabel: "alice@example.com",
            connected: false,
            unreadCount: 2,
          }),
        ],
      })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ id: "m-1", threadId: "thread-dm-1", body: "old message" })],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByTestId("chats-dm-ended")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-composer")).toBeNull();
    const bodies = await screen.findAllByTestId("chats-dm-message-body");
    expect(bodies.map((el) => el.textContent)).toEqual(["old message"]);
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("chats-dm-back"));
    expect((await screen.findByTestId("chats-dm-unread")).textContent).toBe("2");
  });
});

// Expand-to-tab (chats/expand-to-tab): the panel reports where it is via
// onNavChange, and a freshly expanded tab (variant "page") starts at that
// conversation via initialNav — consumed once, loaded through the same
// openChannel/openThread path a click would take.
describe("ChatsView expand-to-tab", () => {
  it("marks the page variant on the root so the tab surface is testable", async () => {
    renderView(vi.fn(), vi.fn(), { variant: "page" });
    const view = await screen.findByTestId("chats-view");
    expect(view.dataset.variant).toBe("page");
  });

  it("defaults to the panel variant", async () => {
    renderView();
    const view = await screen.findByTestId("chats-view");
    expect(view.dataset.variant).toBe("panel");
  });

  it("hands a channel selection from the panel to the editor", async () => {
    const user = userEvent.setup();
    const onOpenInTab = vi.fn();
    renderView(vi.fn(), vi.fn(), { onOpenInTab });

    await user.click(await screen.findByTestId("chats-channel"));

    expect(onOpenInTab).toHaveBeenCalledWith({
      level: "channel",
      channel: expect.objectContaining({ id: "channel-1" }),
    });
    expect(screen.queryByTestId("chats-channel-view")).toBeNull();
    expect(bridgeMock.listChannelThreads).not.toHaveBeenCalled();
  });

  it("hands a chat selection from the panel to the editor", async () => {
    const user = userEvent.setup();
    const onOpenInTab = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
      viewerAuthorId: "you@example.com",
    });
    renderView(vi.fn(), vi.fn(), {
      initialNav: { level: "channel", channel: channel() },
      onOpenInTab,
    });

    await user.click(await screen.findByTestId("chats-post-card"));

    expect(onOpenInTab).toHaveBeenCalledWith({
      level: "thread",
      channel: expect.objectContaining({ id: "channel-1" }),
      thread: expect.objectContaining({ id: "thread-1" }),
    });
    expect(screen.queryByTestId("chats-thread-view")).toBeNull();
  });

  it("hands a DM selection from the panel to the editor", async () => {
    const user = userEvent.setup();
    const onOpenInTab = vi.fn();
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [dm()] });
    renderView(vi.fn(), vi.fn(), { onOpenInTab });

    await user.click(await screen.findByTestId("chats-dm-item"));

    expect(onOpenInTab).toHaveBeenCalledWith({
      level: "dm",
      dm: expect.objectContaining({ channelId: "channel-dm-1" }),
    });
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    expect(bridgeMock.listChatMessages).not.toHaveBeenCalled();
  });

  it("keeps page navigation inside the editor", async () => {
    const user = userEvent.setup();
    const onOpenInTab = vi.fn();
    renderView(vi.fn(), vi.fn(), { variant: "page", onOpenInTab });

    await user.click(await screen.findByTestId("chats-channel"));

    expect(await screen.findByTestId("chats-channel-view")).toBeTruthy();
    expect(onOpenInTab).not.toHaveBeenCalled();
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      channelId: "channel-1",
    });
  });

  it("reports every navigation through onNavChange", async () => {
    const user = userEvent.setup();
    const onNavChange = vi.fn();
    renderView(vi.fn(), vi.fn(), { onNavChange });

    await screen.findByTestId("chats-view");
    expect(onNavChange).toHaveBeenCalledWith({ level: "channels" });

    await user.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(onNavChange).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "channel",
        channel: expect.objectContaining({ id: "channel-1" }),
      }),
    );
  });

  it("seeds an expanded tab at the panel's thread once the overview is ready", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "thread", channel: channel(), thread: thread() },
    });

    const view = await screen.findByTestId("chats-thread-view");
    expect(view.dataset.variant).toBe("page");
    expect((await screen.findByTestId("chats-thread-post-title")).textContent).toBe(
      "Should we ship on Friday?",
    );
    await waitFor(() =>
      expect(bridgeMock.listChatMessages).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
      }),
    );
  });

  it("seeds an expanded tab at the panel's channel", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
      viewerAuthorId: "you@example.com",
    });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "channel", channel: channel() },
    });

    const view = await screen.findByTestId("chats-channel-view");
    expect(view.dataset.variant).toBe("page");
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "general",
    );
  });

  it("never reports the default overview position while a seed is pending", async () => {
    // The shell's nav ref holds the conversation being restored; reporting
    // the pre-seed default would overwrite it, so closing the tab mid-load
    // would lose the conversation the expand was supposed to preserve.
    const onNavChange = vi.fn();
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "thread", channel: channel(), thread: thread() },
      onNavChange,
    });

    await screen.findByTestId("chats-thread-view");
    await waitFor(() =>
      expect(onNavChange).toHaveBeenCalledWith(
        expect.objectContaining({ level: "thread" }),
      ),
    );
    expect(onNavChange).not.toHaveBeenCalledWith({ level: "channels" });
    expect(onNavChange.mock.calls[0]?.[0]).toMatchObject({ level: "thread" });
  });

  it("seeds an expanded tab at the panel's DM conversation", async () => {
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [dm()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "dm", dm: dm() },
    });

    const view = await screen.findByTestId("chats-dm-view");
    expect(view.dataset.variant).toBe("page");
    expect((await screen.findByTestId("chats-dm-title")).textContent).toBe(
      "bob@example.com",
    );
  });

  it("opens a Feed DM directly in the page and preserves its focused message", async () => {
    const user = userEvent.setup();
    const directDm = dm();
    const focused = message({
      id: "message-feed-dm-focus",
      threadId: directDm.threadId ?? "thread-dm-1",
      body: "Focused Feed DM",
    });
    const pendingSync = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [directDm] })
      .mockImplementation(() => pendingSync);
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: focused,
          thread: {
            id: directDm.threadId ?? "thread-dm-1",
            title: "DM conversation",
            createdAtMs: NOW,
            updatedAtMs: NOW,
          },
          channel: {
            id: directDm.channelId,
            wireId: directDm.channelWireId,
            name: directDm.name,
            slug: "bob-example-com",
            kind: "dm" as const,
          },
          reactions: [],
          matchedBy: ["person" as const],
        },
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [focused] });
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    renderView(vi.fn(), vi.fn(), { variant: "page" });
    await screen.findByTestId("chats-dm-item");
    await user.click(screen.getByTestId("chats-feed-link"));
    const feedMessage = await screen.findByText("Focused Feed DM");
    await user.click(feedMessage.closest("button")!);

    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("chats-dm-message").className).toContain("ring-2");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    });
  });

  it("seeds an expanded tab at the new-message compose screen", async () => {
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "dm-new" },
    });

    const view = await screen.findByTestId("chats-dm-new");
    expect(view.dataset.variant).toBe("page");
  });

  it("restores unsent drafts alongside the seeded conversation", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "thread", channel: channel(), thread: thread() },
      initialDrafts: {
        composer: "half-typed reply",
        newThreadBody: "",
        dmRecipients: "",
        dmDraft: "",
        replyTarget: null,
        resolveTargetMessageId: null,
      },
    });

    await screen.findByTestId("chats-thread-view");
    await waitFor(() =>
      expect(
        (screen.getByTestId("chats-composer") as HTMLTextAreaElement).value,
      ).toBe("half-typed reply"),
    );
  });

  it("restores the composer's reply/resolve mode, not just its text", async () => {
    // Without the mode, a reply (or decision resolution) drafted before the
    // handoff would post as a plain top-level comment after it.
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "thread", channel: channel(), thread: thread() },
      initialDrafts: {
        composer: "replying mid-expand",
        newThreadBody: "",
        dmRecipients: "",
        dmDraft: "",
        replyTarget: { messageId: "message-1", authorLabel: "You" },
        resolveTargetMessageId: "message-1",
      },
    });

    await screen.findByTestId("chats-thread-view");
    expect(await screen.findByTestId("chats-replying-mode")).toBeTruthy();
    expect(await screen.findByTestId("chats-resolving-mode")).toBeTruthy();
  });

  it("reports draft edits so the shell can hand them to the next mount", async () => {
    const user = userEvent.setup();
    const onDraftsChange = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [],
      viewerAuthorId: "you@example.com",
    });
    renderView(vi.fn(), vi.fn(), { onDraftsChange });

    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    await user.type(screen.getByTestId("chats-new-thread-composer"), "hi");

    await waitFor(() =>
      expect(onDraftsChange).toHaveBeenCalledWith(
        expect.objectContaining({ newThreadBody: "hi" }),
      ),
    );
  });

  it("hydrates durable author and channel follows and can unfollow both", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-1" })],
      fileThreads: [],
    });
    bridgeMock.listChatFollows.mockResolvedValue({
      follows: [
        {
          targetKind: "channel",
          targetId: "wire-1",
          state: "following",
          updatedAtMs: NOW,
        },
        {
          targetKind: "person",
          targetId: "user-alice",
          state: "following",
          updatedAtMs: NOW,
        },
      ],
    });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message({ authorDisplayName: "Alice" }),
          thread: thread(),
          channel: { id: "channel-1", name: "general", slug: "general", kind: "channel" },
          authorFollowTarget: { targetKind: "person", targetId: "user-alice" },
          reactions: [],
          matchedBy: ["person", "channel"],
        },
      ],
    });

    renderView();

    const channelFollow = await screen.findByTestId("chats-channel-follow");
    await waitFor(() => expect(channelFollow.getAttribute("aria-label")).toBe("Unfollow #general"));
    await user.click(channelFollow);
    expect(bridgeMock.setChatFollow).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      target: { kind: "channel", channelId: "channel-1" },
      state: "unfollowed",
    });

    await user.click(screen.getByTestId("chats-feed-link"));
    const authorFollow = await screen.findByTestId("chats-feed-follow-author");
    expect(authorFollow.textContent).toBe("Following author");
    await user.click(authorFollow);
    expect(bridgeMock.setChatFollow).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      target: { kind: "author", threadId: "thread-1", messageId: "message-1" },
      state: "unfollowed",
    });
  });

  it("does not let an older channel-follow refresh overwrite a newer mutation", async () => {
    const user = userEvent.setup();
    const persistedFollow = {
      targetKind: "channel" as const,
      targetId: "wire-1",
      state: "following" as const,
      updatedAtMs: NOW,
    };
    let resolveStaleRead!: (value: { follows: [typeof persistedFollow] }) => void;
    const staleRead = new Promise<{ follows: [typeof persistedFollow] }>((resolve) => {
      resolveStaleRead = resolve;
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-1" })],
      fileThreads: [],
    });
    bridgeMock.listChatFollows
      .mockResolvedValueOnce({ follows: [persistedFollow] })
      .mockImplementationOnce(() => staleRead);

    renderView();
    const follow = await screen.findByTestId("chats-channel-follow");
    await waitFor(() => expect(follow.getAttribute("aria-label")).toBe("Unfollow #general"));
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listChatFollows).toHaveBeenCalledTimes(2));

    await user.click(follow);
    await waitFor(() => expect(follow.getAttribute("aria-label")).toBe("Follow #general"));
    await act(async () => {
      resolveStaleRead({ follows: [persistedFollow] });
      await staleRead;
    });
    expect(follow.getAttribute("aria-label")).toBe("Follow #general");
  });

  it("drops stale Feed-follow mutation results and errors after a newer refresh", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const persistedFollow = {
      targetKind: "person" as const,
      targetId: "user-alice",
      state: "following" as const,
      updatedAtMs: NOW,
    };
    type UnfollowResult = {
      follow: {
        targetKind: "person";
        targetId: string;
        state: "unfollowed";
        updatedAtMs: number;
      };
    };
    let resolveOldMutation!: (value: UnfollowResult) => void;
    const oldMutation = new Promise<UnfollowResult>((resolve) => {
      resolveOldMutation = resolve;
    });
    let rejectOldMutation!: (reason: unknown) => void;
    const oldRejectedMutation = new Promise<never>((_resolve, reject) => {
      rejectOldMutation = reject;
    });
    bridgeMock.listChatFollows.mockResolvedValue({ follows: [persistedFollow] });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message({ authorDisplayName: "Alice" }),
          thread: thread(),
          channel: {
            id: "channel-1",
            name: "general",
            slug: "general",
            kind: "channel" as const,
          },
          authorFollowTarget: { targetKind: "person" as const, targetId: "user-alice" },
          reactions: [],
          matchedBy: ["person" as const],
        },
      ],
    });
    bridgeMock.setChatFollow
      .mockImplementationOnce(() => oldMutation)
      .mockImplementationOnce(() => oldRejectedMutation);

    renderView(vi.fn(), onError);
    await user.click(await screen.findByTestId("chats-feed-link"));
    const follow = await screen.findByTestId("chats-feed-follow-author");
    await waitFor(() => expect(follow.textContent).toBe("Following author"));

    await user.click(follow);
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.listChatFollows.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await act(async () => {
      resolveOldMutation({
        follow: { ...persistedFollow, state: "unfollowed", updatedAtMs: NOW + 1 },
      });
      await oldMutation;
    });
    expect(follow.textContent).toBe("Following author");

    await user.click(follow);
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.listChatFollows.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await act(async () => {
      rejectOldMutation(new Error("stale follow failure"));
      await oldRejectedMutation.catch(() => undefined);
    });
    expect(follow.textContent).toBe("Following author");
    expect(onError).not.toHaveBeenCalled();
  });

  it("synchronizes follows between simultaneous chat views after workspace activity", async () => {
    const user = userEvent.setup();
    let persistedFollows = [
      {
        targetKind: "channel" as const,
        targetId: "wire-1",
        state: "following" as const,
        updatedAtMs: NOW,
      },
    ];
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-1" })],
      fileThreads: [],
    });
    bridgeMock.listChatFollows.mockImplementation(() =>
      Promise.resolve({ follows: persistedFollows }),
    );
    bridgeMock.setChatFollow.mockImplementation(async (input) => {
      persistedFollows = [];
      return {
        follow: {
          targetKind: "channel" as const,
          targetId: "wire-1",
          state: input.state,
          updatedAtMs: NOW + 1,
        },
      };
    });

    render(
      <>
        <ChatsView workspaceId="workspace-a" onOpenFileChat={vi.fn()} onError={vi.fn()} />
        <ChatsView workspaceId="workspace-a" onOpenFileChat={vi.fn()} onError={vi.fn()} />
      </>,
    );

    const followButtons = await screen.findAllByTestId("chats-channel-follow");
    await waitFor(() => {
      expect(followButtons).toHaveLength(2);
      expect(followButtons.every((button) => button.getAttribute("aria-label") === "Unfollow #general")).toBe(true);
      expect(workspaceActivityCallbacks.size).toBe(2);
    });

    await user.click(followButtons[0]);
    act(() => emitWorkspaceActivity());

    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("chats-channel-follow")
          .every((button) => button.getAttribute("aria-label") === "Follow #general"),
      ).toBe(true);
      expect(bridgeMock.listChatFollows.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("drops a stale follow response after switching workspaces", async () => {
    let resolveOld!: (value: { follows: Array<{
      targetKind: "channel";
      targetId: string;
      state: "following";
      updatedAtMs: number;
    }> }) => void;
    const oldFollows = new Promise<{
      follows: Array<{
        targetKind: "channel";
        targetId: string;
        state: "following";
        updatedAtMs: number;
      }>;
    }>((resolve) => {
      resolveOld = resolve;
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-1" })],
      fileThreads: [],
    });
    bridgeMock.listChatFollows
      .mockImplementationOnce(() => oldFollows)
      .mockResolvedValueOnce({ follows: [] });

    const { rerender } = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    rerender(
      <ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );

    const follow = await screen.findByTestId("chats-channel-follow");
    await waitFor(() => expect(follow.getAttribute("aria-label")).toBe("Follow #general"));
    await act(async () => {
      resolveOld({
        follows: [
          {
            targetKind: "channel",
            targetId: "wire-1",
            state: "following",
            updatedAtMs: NOW,
          },
        ],
      });
      await oldFollows;
    });
    expect(follow.getAttribute("aria-label")).toBe("Follow #general");
  });

  it("drops an awaited follow toggle result and error after switching workspaces", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-1" })],
      fileThreads: [],
    });
    let resolveToggle!: (value: {
      follow: {
        targetKind: "channel";
        targetId: string;
        state: "following";
        updatedAtMs: number;
      };
    }) => void;
    const toggle = new Promise<{
      follow: {
        targetKind: "channel";
        targetId: string;
        state: "following";
        updatedAtMs: number;
      };
    }>((resolve) => {
      resolveToggle = resolve;
    });
    bridgeMock.setChatFollow.mockImplementationOnce(() => toggle);

    const { rerender } = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={onError}
      />,
    );
    const oldFollow = await screen.findByTestId("chats-channel-follow");
    await user.click(oldFollow);
    rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={onError}
      />,
    );

    await act(async () => {
      resolveToggle({
        follow: {
          targetKind: "channel",
          targetId: "wire-1",
          state: "following",
          updatedAtMs: NOW,
        },
      });
      await toggle;
    });
    expect((await screen.findByTestId("chats-channel-follow")).getAttribute("aria-label"))
      .toBe("Follow #general");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not surface a rejected follow toggle from the previous workspace", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-1" })],
      fileThreads: [],
    });
    let rejectToggle!: (reason: unknown) => void;
    const toggle = new Promise<never>((_resolve, reject) => {
      rejectToggle = reject;
    });
    bridgeMock.setChatFollow.mockImplementationOnce(() => toggle);

    const { rerender } = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={onError}
      />,
    );
    await user.click(await screen.findByTestId("chats-channel-follow"));
    rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={onError}
      />,
    );

    await act(async () => {
      rejectToggle(new Error("old workspace is offline"));
      await toggle.catch(() => undefined);
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a delayed bookmark response after immediate navigation", async () => {
    let resolveBookmarks!: (value: { bookmarks: ChatBookmarkRecord[] }) => void;
    const delayedBookmarks = new Promise<{ bookmarks: ChatBookmarkRecord[] }>((resolve) => {
      resolveBookmarks = resolve;
    });
    bridgeMock.listChatBookmarks.mockImplementationOnce(() => delayedBookmarks);
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message(),
          thread: thread(),
          channel: { id: "channel-1", name: "general", slug: "general", kind: "channel" },
          reactions: [],
          matchedBy: ["channel"],
        },
      ],
    });

    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByTestId("chats-feed-bookmark");
    await act(async () => {
      resolveBookmarks({
        bookmarks: [
          {
            bookmarkId: "bookmark-message-1",
            targetKind: "message",
            targetId: "message-1",
            threadId: "thread-1",
            messageId: "message-1",
            mode: "live",
            destinationPath: "Bookmarks/Chats/Friday--message-1.md",
            state: "active",
            projectionState: "ready",
            generation: 1,
            createdAtMs: NOW,
            updatedAtMs: NOW,
          },
        ],
      });
      await delayedBookmarks;
    });

    await waitFor(() =>
      expect(screen.getByTestId("chats-feed-bookmark").getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("does not let an older bookmark list erase a completed mutation", async () => {
    let resolveBookmarks!: (value: { bookmarks: ChatBookmarkRecord[] }) => void;
    const delayedBookmarks = new Promise<{ bookmarks: ChatBookmarkRecord[] }>((resolve) => {
      resolveBookmarks = resolve;
    });
    bridgeMock.listChatBookmarks.mockImplementationOnce(() => delayedBookmarks);
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message(),
          thread: thread(),
          channel: { id: "channel-1", name: "general", slug: "general", kind: "channel" },
          reactions: [],
          matchedBy: ["channel"],
        },
      ],
    });
    bridgeMock.saveChatBookmark.mockResolvedValue({
      bookmark: {
        bookmarkId: "bookmark-message-1",
        targetKind: "message",
        targetId: "message-1",
        threadId: "thread-1",
        messageId: "message-1",
        mode: "live",
        destinationPath: "Bookmarks/Chats/Friday--message-1.md",
        state: "active",
        projectionState: "ready",
        generation: 1,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    });

    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const bookmarkButton = await screen.findByTestId("chats-feed-bookmark");
    await userEvent.click(bookmarkButton);
    await waitFor(() => expect(bookmarkButton.getAttribute("aria-pressed")).toBe("true"));

    await act(async () => {
      resolveBookmarks({ bookmarks: [] });
      await delayedBookmarks;
    });
    expect(bookmarkButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("drops a bookmark mutation result and busy cleanup from an old workspace", async () => {
    let resolveSave!: (value: { bookmark: ChatBookmarkRecord }) => void;
    const delayedSave = new Promise<{ bookmark: ChatBookmarkRecord }>((resolve) => {
      resolveSave = resolve;
    });
    bridgeMock.saveChatBookmark.mockImplementationOnce(() => delayedSave);
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message(),
          thread: thread(),
          channel: { id: "channel-1", name: "general", slug: "general", kind: "channel" },
          reactions: [],
          matchedBy: ["channel"],
        },
      ],
    });

    const { rerender } = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const oldButton = await screen.findByTestId("chats-feed-bookmark");
    await userEvent.click(oldButton);
    expect((oldButton as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const newButton = await screen.findByTestId("chats-feed-bookmark");
    expect((newButton as HTMLButtonElement).disabled).toBe(false);
    expect(newButton.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      resolveSave({
        bookmark: {
          bookmarkId: "bookmark-old-workspace",
          targetKind: "message",
          targetId: "message-1",
          threadId: "thread-1",
          messageId: "message-1",
          mode: "live",
          destinationPath: "Bookmarks/Chats/old.md",
          state: "active",
          projectionState: "ready",
          generation: 1,
          createdAtMs: NOW,
          updatedAtMs: NOW,
        },
      });
      await delayedSave;
    });
    expect(newButton.getAttribute("aria-pressed")).toBe("false");
    expect((newButton as HTMLButtonElement).disabled).toBe(false);
  });
});
