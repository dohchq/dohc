// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ListChatReactionsResult } from "../../ipc/bridgeContract";
import {
  NOW,
  channel,
  thread,
  message,
  bridgeMock,
  renderView,
  mentionRoster,
} from "./ChatsView.testHarness";

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
    const onThreadStarted = vi.fn();
    const startedThread = thread();
    bridgeMock.startChannelThread.mockResolvedValue({
      thread: startedThread,
      message: message(),
      viewerAuthorId: "you@example.com",
    });
    renderView(vi.fn(), vi.fn(), { onThreadStarted });

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
    expect(onThreadStarted).toHaveBeenCalledTimes(1);
  });

  it("can react to a newly started thread before any reload", async () => {
    const user = userEvent.setup();
    const startedThread = thread();
    let resolveReactionList!: (result: ListChatReactionsResult) => void;
    const reactionList = new Promise<ListChatReactionsResult>((resolve) => {
      resolveReactionList = resolve;
    });
    // Keep refresh identity pending so this click depends on the start result.
    bridgeMock.listChatReactions.mockReturnValue(reactionList);
    bridgeMock.startChannelThread.mockResolvedValue({
      thread: startedThread,
      message: message(),
      viewerAuthorId: "you@example.com",
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(
      await screen.findByTestId("chats-new-thread-composer"),
      "Should we ship on Friday?{Enter}",
    );
    expect(await screen.findByTestId("chats-message-body")).toBeTruthy();

    await user.click(screen.getByTestId("chats-add-reaction"));
    const thumbsUp = screen
      .getAllByTestId("chats-reaction-choice")
      .find((button) => button.getAttribute("data-emoji") === "👍");
    expect(thumbsUp).toBeTruthy();
    await user.click(thumbsUp!);

    await waitFor(() =>
      expect(bridgeMock.setChatReaction).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        messageId: "message-1",
        emoji: "👍",
        state: "added",
      }),
    );
    await act(async () => {
      resolveReactionList({ reactions: [], viewerAuthorId: "you@example.com" });
      await reactionList;
    });
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

    // Two Enter keydowns in the same tick (no await between): the synchronous
    // in-flight ref must swallow the second so only one send goes out.
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter" });
    resolveSend({ message: message({ id: "m-new", body: "@agent look" }) });

    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));
  });

  // The rows report; they do not navigate. A notification names a workspace
  // and a run, never a conversation, so an interactive row could only lead
  // somewhere invented.
  it("shows an 'Addressed to me' inbox for agent asks and never makes a row clickable", async () => {
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
    renderView(vi.fn(), vi.fn(), { addressedToMe: [notice] });

    const item = await screen.findByTestId("chats-addressed-item");
    expect(item.textContent).toContain("Which draft should I keep?");
    expect(item.tagName).toBe("DIV");
    expect(item.closest("button")).toBeNull();
  });
});
