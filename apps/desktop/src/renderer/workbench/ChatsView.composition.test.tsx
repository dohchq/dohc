// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ListChatReactionsResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import {
  NOW,
  channel,
  personalFeedItem,
  shareListing,
  thread,
  message,
  bridgeMock,
  renderView,
  navigatorView,
  mentionRoster,
} from "./ChatsView.testHarness";
import { runnerProgram } from "./ChatsView";

describe("ChatsView My agent", () => {
  it("attributes a runner failure to dohc without an agent badge", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message(), message({
      id: "failure", authorKind: "agent", authorDisplayName: "You",
      body: "⚠ Agent run failed (exit 3). Open the run chip for details.",
    })] });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-thread"));
    const notes = await screen.findAllByTestId("chats-message");
    const note = within(notes.find((element) => element.dataset.messageId === "failure")!);
    expect(note.getByTestId("chats-message-author").textContent).toBe("dohc");
    expect(note.getByTestId("chats-message-author").dataset.authorKind).toBe("system");
    expect(note.queryByTestId("chats-comment-agent-badge")).toBeNull();
  });

  it("stays absent when the workspace has no agent channel", async () => {
    renderView();
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-my-agent-section")).toBeNull();
  });

  it("renders under Agents, stays out of the group list, and uses the agent placeholder", async () => {
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
    expect(agentSection.compareDocumentPosition(screen.getByTestId("chats-channels-heading")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
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

  it("names a set-up agent under Agents and offers Manage, with no card in the conversation", async () => {
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
      userSettings: DEFAULT_USER_SETTINGS,
      onSaveUserSettings: vi.fn(async () => undefined),
      workspacePath: "C:\\people\\ice\\work",
    });

    expect((await screen.findByTestId("chats-my-agent-name")).textContent).toBe("Ice's agent");
    expect(screen.queryByTestId("chats-my-agent-state")).toBeNull();
    await user.click(screen.getByTestId("chats-manage-agent"));
    expect(onSetupAgent).toHaveBeenCalledOnce();
    await user.click(screen.getByTestId("chats-my-agent"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.queryByTestId("chats-agent-setup-card")).toBeNull();
    // The agent's screen says what runs it and what it reaches.
    const agentScreen = screen.getByTestId("chats-agent-screen");
    expect(agentScreen.dataset.state).toBe("ready");
    expect(screen.getByTestId("chats-agent-screen-runner").textContent).toBe("Runner on");
    expect(screen.getByTestId("chats-agent-screen-reach").textContent).toBe("reaches work");
    await user.click(screen.getByTestId("chats-agent-screen-manage"));
    expect(onSetupAgent).toHaveBeenCalledTimes(2);
  });

  it("names the program a runner command starts, with the whole command on hover", () => {
    expect(runnerProgram('node "C:\\w\\dohc\\apps\\desktop\\e2e\\fixtures\\fakeChatRunner.mjs" ask')).toBe("node fakeChatRunner.mjs");
    expect(runnerProgram("codex exec --sandbox read-only")).toBe("codex");
    expect(runnerProgram('"C:\\Program Files\\Agent\\agent.exe" --serve')).toBe("agent.exe");
    expect(runnerProgram("python3 /home/me/bot.py")).toBe("python3 bot.py");
  });

  it("lists other people's agents from joined channels, read-only, under who shared them", async () => {
    const user = userEvent.setup();
    const shared = channel({ id: "channel-team", name: "team", slug: "team", wireId: "wire-team" });
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel(), shared], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        joined: [
          {
            shareId: "share-team",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: false,
          },
        ],
      }),
    );
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          ...personalFeedItem("Rebuilt the index.", "message-their-agent"),
          message: message({
            id: "message-their-agent",
            authorKind: "agent",
            authorDisplayName: "Owner",
            body: "Rebuilt the index.",
          }),
          channel: { id: "channel-team", wireId: "wire-team", name: "team", slug: "team", kind: "channel" as const },
        },
        // The user's own agent in their own channel is not someone else's.
        {
          ...personalFeedItem("Checked the exports.", "message-my-agent"),
          message: message({
            id: "message-my-agent",
            authorKind: "agent",
            authorDisplayName: "You",
            body: "Checked the exports.",
          }),
        },
      ],
    });
    renderView();

    // Home reads what arrived; the nav lists the agents among it.
    await user.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Rebuilt the index.");
    await user.click(screen.getByTestId("chats-feed-back"));
    const rows = await screen.findAllByTestId("chats-other-agent");
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId("chats-other-agent-name").textContent).toBe("Owner's agent");
    expect(rows[0]!.dataset.owner).toBe("owner@example.com");
    expect(rows[0]!.textContent).toContain("via owner@example.com");
    // Opening one goes to its latest work; there is nothing here to configure.
    await user.click(rows[0]!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-add-agent")).toBeNull();
  });

  it("adds an agent from Agents: name, runner, check, and one settings write", async () => {
    const user = userEvent.setup();
    const onSaveUserSettings = vi.fn(async () => undefined);
    const runnerSelfTest = vi.fn(async () => ({ ok: true, detail: "The runner answered." }));
    vi.stubGlobal("dohcDesktop", { ...(globalThis as { dohcDesktop?: object }).dohcDesktop, runnerSelfTest });
    // An enabled MCP server is not a set-up agent.
    renderView(vi.fn(), vi.fn(), {
      agentSetup: {
        runnerConfigured: false,
        runnerEnabled: false,
        mcpEnabled: true,
      },
      onSetupAgent: vi.fn(),
      userSettings: DEFAULT_USER_SETTINGS,
      onSaveUserSettings,
    });

    await user.click(await screen.findByTestId("chats-add-agent-open"));
    expect(screen.getByTestId("chats-add-agent-preview").textContent).toContain("Your agent");
    await user.type(screen.getByTestId("chats-add-agent-name"), "Ice");
    expect(screen.getByTestId("chats-add-agent-preview").textContent).toContain("Ice's agent");
    await user.type(screen.getByTestId("chats-add-agent-command"), "node agent.mjs");
    await user.click(screen.getByTestId("chats-add-agent-check"));
    await waitFor(() =>
      expect(screen.getByTestId("chats-add-agent-check-result").dataset.state).toBe("ok"),
    );
    expect(runnerSelfTest).toHaveBeenCalledWith({ workspaceId: "workspace-a" });
    await user.click(screen.getByTestId("chats-add-agent-submit"));
    await waitFor(() => expect(screen.queryByTestId("chats-add-agent")).toBeNull());
    // The check and the add each wrote the same settings: the name, the
    // command, dispatch on.
    expect(onSaveUserSettings).toHaveBeenCalledTimes(2);
    expect(onSaveUserSettings).toHaveBeenLastCalledWith({
      ...DEFAULT_USER_SETTINGS,
      profile: { preferredName: "Ice" },
      runner: { ...DEFAULT_USER_SETTINGS.runner, command: "node agent.mjs", enabled: true },
    });
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


describe("group details", () => {
  it("shows the saved purpose under the group header", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel({ purpose: "Plan the launch" })], fileThreads: [] });
    renderView();
    fireEvent.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-channel-purpose")).textContent).toBe("Plan the launch");
  });

  it("resets group purpose and type after a workspace switch", async () => {
    const view = render(navigatorView(0));
    fireEvent.click(await screen.findByTestId("chats-new-channel"));
    fireEvent.change(screen.getByTestId("chats-new-channel-purpose"), { target: { value: "Old purpose" } });
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    view.rerender(navigatorView(0, { workspaceId: "workspace-b" }));
    fireEvent.click(await screen.findByTestId("chats-new-channel"));
    expect((screen.getByTestId("chats-new-channel-purpose") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("radio", { name: "Posts" }).getAttribute("aria-checked")).toBe("true");
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

  it("lists an agent that speaks only in a joined group's chat lane", async () => {
    const group = channel({ id: "c-chat", wireId: "w-chat", type: "chat" });
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [group], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing({ joined: [{
      shareId: "share-chat", channelWireId: "w-chat", granterEmail: "owner@example.test", access: "read-write", ended: false,
    }] }));
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [], nextCursor: null });
    bridgeMock.listChannelThreads.mockImplementation(async (payload: { lane?: string }) =>
      payload.lane === "chat"
        ? { threads: [thread({ id: "lane", channelId: "c-chat", messageCount: 1 })] }
        : { threads: [] },
    );
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "m-lane", threadId: "lane", authorKind: "agent", authorDisplayName: "Owner's agent", authorUserId: "agent-owner" }),
    ] });
    renderView();
    await waitFor(() => expect(screen.getAllByTestId("chats-other-agent")).toHaveLength(1));
    expect(screen.getByTestId("chats-other-agents").textContent).toContain("via owner@example.test");
    fireEvent.click(screen.getByTestId("chats-other-agent"));
    expect(await screen.findByTestId("chats-channel-view")).toBeTruthy();
  });

  it("resets purpose and type when Escape cancels group creation", async () => {
    renderView();
    fireEvent.click(await screen.findByTestId("chats-new-channel"));
    fireEvent.change(screen.getByTestId("chats-new-channel-purpose"), { target: { value: "Cancelled purpose" } });
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    fireEvent.keyDown(screen.getByTestId("chats-new-channel-purpose"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("chats-new-channel"));
    expect((screen.getByTestId("chats-new-channel-purpose") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("radio", { name: "Posts" }).getAttribute("aria-checked")).toBe("true");
  });
});
