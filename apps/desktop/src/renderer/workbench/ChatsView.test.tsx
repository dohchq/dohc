// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelThreadRecord,
  ChatChannelRecord,
  ChatMessageRecord,
  FileChatThreadRecord,
} from "../../ipc/bridgeContract";
import { ChatsView } from "./ChatsView";

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

const fileThread: FileChatThreadRecord = {
  id: "thread-file-1",
  title: "Naming discussion",
  createdAtMs: NOW,
  updatedAtMs: NOW,
  path: "notes/topic.md",
};

const bridgeMock = {
  listChatChannels: vi.fn(),
  createChatChannel: vi.fn(),
  listChannelThreads: vi.fn(),
  startChannelThread: vi.fn(),
  listChatMessages: vi.fn(),
  sendChatMessage: vi.fn(),
  markChatThreadRead: vi.fn(),
};

Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listChatChannels.mockResolvedValue({
    channels: [channel()],
    fileThreads: [],
  });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
  bridgeMock.markChatThreadRead.mockResolvedValue({
    lastReadSequence: 1,
    revision: 1,
  });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderView(onOpenFileChat = vi.fn(), onError = vi.fn()) {
  render(
    <ChatsView
      workspaceId="workspace-a"
      onOpenFileChat={onOpenFileChat}
      onError={onError}
    />,
  );
  return { onOpenFileChat, onError };
}

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
});
