// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  listChatChannelShares: vi.fn(),
  shareChatChannel: vi.fn(),
  joinSharedChannel: vi.fn(),
  leaveSharedChannel: vi.fn(),
  revokeRelayShare: vi.fn(),
  createChatChannel: vi.fn(),
  listChannelThreads: vi.fn(),
  startChannelThread: vi.fn(),
  listChatMessages: vi.fn(),
  sendChatMessage: vi.fn(),
  markChatThreadRead: vi.fn(),
  listChatReactions: vi.fn(),
  setChatReaction: vi.fn(),
};

Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listChatChannels.mockResolvedValue({
    channels: [channel()],
    fileThreads: [],
  });
  bridgeMock.listChatChannelShares.mockResolvedValue({
    granted: [],
    received: [],
    joined: [],
  });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
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
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
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

  it("invokes a mentioned agent after a message is sent", async () => {
    const user = userEvent.setup();
    const onAgentMentioned = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "m-new", body: "@agent can you check this?" }),
    });
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster, onAgentMentioned });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(
      screen.getByTestId("chats-composer"),
      "@agent can you check this?{Enter}",
    );

    await waitFor(() => expect(onAgentMentioned).toHaveBeenCalledTimes(1));
    const call = onAgentMentioned.mock.calls[0]![0];
    expect(call.threadId).toBe("thread-1");
    expect(call.mentioned.map((c: { id: string }) => c.id)).toEqual(["agent:default"]);
  });

  it("does not invoke the agent for an @agent typed inside inline code", async () => {
    const user = userEvent.setup();
    const onAgentMentioned = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "m-code", body: "run `npm i @agent/pkg` please" }),
    });
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster, onAgentMentioned });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    // The @agent sits inside backticks, so the invoke path must ignore it.
    await user.type(
      screen.getByTestId("chats-composer"),
      "run `npm i @agent/pkg` please{Enter}",
    );
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalled());
    expect(onAgentMentioned).not.toHaveBeenCalled();
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

  it("fires a single send (one agent invoke) for a synchronous double-Enter", async () => {
    const user = userEvent.setup();
    const onAgentMentioned = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    let resolveSend!: (value: { message: ChatMessageRecord }) => void;
    bridgeMock.sendChatMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster, onAgentMentioned });

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
    await waitFor(() => expect(onAgentMentioned).toHaveBeenCalledTimes(1));
  });

  it("does not invoke an agent when only the user is mentioned", async () => {
    const user = userEvent.setup();
    const onAgentMentioned = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "m-new", body: "note to @you" }),
    });
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster, onAgentMentioned });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    // Trailing space closes the mention menu so Enter sends (rather than
    // accepting the highlighted candidate).
    await user.type(screen.getByTestId("chats-composer"), "note to @you {Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalled());
    expect(onAgentMentioned).not.toHaveBeenCalled();
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

// --- Shared channels (MU-C4) -----------------------------------------------

describe("ChatsView shared channels (MU-C4)", () => {
  const teamChannel = () =>
    channel({ id: "channel-team", name: "team", slug: "team", wireId: "wire-team" });

  it("hides every sharing affordance when the sharing surface is unavailable (solo unchanged)", async () => {
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

  it("lists an invitation under Shared with you and joins it", async () => {
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
    await userEvent.click(screen.getByTestId("chats-join-shared"));
    await waitFor(() =>
      expect(bridgeMock.joinSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-in",
      }),
    );
    // The overview reloads after joining (channel + shares re-fetch).
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));
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
