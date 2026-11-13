import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatDispatchStateForThreadResult, ListChatReactionsResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { channel, personalFeedItem, shareListing, thread, message, bridgeMock, renderView, navigatorView, mentionRoster } from "./ChatsView.testHarness";

describe("ChatsView agents' chats", () => {
  it("shows a new message in an agent DM's conversation", async () => {
    const agentDm = channel({ id: "channel-agent", name: "agent-internal", slug: "agent", kind: "agent", agentId: "default" });
    const conversation = thread({ id: "conversation", channelId: agentDm.id, title: "" });
    const sent = message({ id: "message-new", threadId: conversation.id, body: "Book the train" });
    let started = false;
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [agentDm], fileThreads: [] });
    bridgeMock.listChannelThreads.mockImplementation(async (input) => ({
      threads: input.lane === "chat" && started ? [conversation] : [],
    }));
    bridgeMock.listChatMessages.mockImplementation(async () => ({ messages: started ? [sent] : [] }));
    bridgeMock.startChannelThread.mockImplementation(async () => {
      started = true;
      return { thread: conversation, message: sent, viewerAuthorId: "author-me" };
    });
    renderView();
    fireEvent.click(await screen.findByTestId("chats-my-agent"));
    const composer = await screen.findByTestId("chats-lane-composer");
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(composer, { target: { value: "Book the train" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Book the train")).toBeTruthy();
    expect(bridgeMock.startChannelThread).toHaveBeenCalledWith(expect.objectContaining({
      channelId: agentDm.id, body: "Book the train", lane: "chat",
    }));
    expect(bridgeMock.startChannelThread.mock.lastCall?.[0]).not.toHaveProperty("title");
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

    const reactionTrigger = screen.getByTestId("chats-add-reaction");
    vi.spyOn(reactionTrigger, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 20, 20));
    await user.click(reactionTrigger);
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
});

describe("ChatsView document thread", () => {
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

describe("group details", () => {
  it("resets group purpose and type after a workspace switch", async () => {
    const view = render(navigatorView(0));
    fireEvent.click(await screen.findByTestId("chats-new-channel"));
    fireEvent.change(screen.getByTestId("chats-new-channel-purpose"), { target: { value: "Old purpose" } });
    fireEvent.click(screen.getByRole("radio", { name: "Both" }));
    view.rerender(navigatorView(0, { workspaceId: "workspace-b" }));
    fireEvent.click(await screen.findByTestId("chats-new-channel"));
    expect((screen.getByTestId("chats-new-channel-purpose") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("radio", { name: "Chat" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps agents distinct across shares with null emails and within one owner's share", async () => {
    const channels = [channel({ id: "c1", wireId: "w1" }), channel({ id: "c2", wireId: "w2" })];
    bridgeMock.listChatChannels.mockResolvedValue({ channels, fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing({ joined: channels.map((channel, index) => ({
      shareId: `share-${index}`, channelWireId: channel.wireId, granterEmail: null, access: "read-write", ended: false,
    })) }));
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [
      [0, "agent-a"], [0, "agent-b"], [1, "agent-a"],
    ].map(([channelIndex, targetId], index) => ({
      ...personalFeedItem("Update", `agent-message-${index}`),
      message: message({ id: `agent-message-${index}`, authorKind: "agent", authorDisplayName: "Same name" }),
      channel: channels[Number(channelIndex)], authorFollowTarget: { targetKind: "agent", targetId },
    })), nextCursor: null });
    renderView();
    fireEvent.click(await screen.findByTestId("chats-feed-link"));
    await waitFor(() => expect(bridgeMock.listPersonalChatFeed).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("chats-feed-back"));
    await waitFor(() => expect(screen.getAllByTestId("chats-other-agent")).toHaveLength(3));
    expect(screen.getByTestId("chats-other-agents").textContent).toContain("via someone else");
  });
});

describe("ChatsView agent offer", () => {
  const ready = {
    workspaceId: "workspace-a", agentName: "Nova", runnerConfigured: true, runnerEnabled: true, agentRunActive: false,
    agents: [{ id: "default", name: "Nova", enabled: true }],
  };
  const withAgent = (agentSetup = ready, onSetupAgent = vi.fn()) => ({
    mentionCandidates: mentionRoster, agentSetup, onSetupAgent, workspacePath: "C:\\people\\ice\\work",
  });
  async function pickAgent(user: ReturnType<typeof userEvent.setup>, prefix: string) {
    await user.type(screen.getByTestId(`${prefix}-composer`), "@No");
    await user.click(screen.getAllByTestId(`${prefix}-mention-option`)[0]!);
    return screen.getByTestId("composer-agent-offer");
  }

  it("follows a thread's dispatch once read, and leaves when another thread opens", async () => {
    const user = userEvent.setup();
    const dispatch = deferred<ChatDispatchStateForThreadResult>();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread(), thread({ id: "thread-2", title: "Second" })] });
    bridgeMock.chatDispatchStateForThread.mockReturnValueOnce(dispatch.promise);
    renderView(vi.fn(), vi.fn(), withAgent());
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click((await screen.findAllByTestId("chats-thread"))[0]!);
    expect((await pickAgent(user, "chats")).dataset.state).toBe("unknown");
    await act(async () => { dispatch.resolve({ liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: true }); });
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("paused");
    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click((await screen.findAllByTestId("chats-thread"))[1]!);
    await screen.findByTestId("chats-thread-view");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });
});
