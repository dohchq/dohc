import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatDispatchStateForThreadResult, ChatMessageRecord, ListChatReactionsResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
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
import { formatChatTime, formatClockDigits } from "../time";

describe("ChatsView My agent", () => {
  it("discovers an opted-in agent after creation while navigator polling is suspended", async () => {
    const listeners = new Set<(event: { workspaceId: string }) => void>();
    bridgeMock.onWorkspaceActivity.mockImplementation((callback: (event: { workspaceId: string }) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    const view = render(navigatorView(0, { suspendPolling: true, userSettings: DEFAULT_USER_SETTINGS }));
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-my-agent")).toBeNull();
    const enabled = settingsWithAgent({ name: "Nova" });
    view.rerender(navigatorView(0, { suspendPolling: true, userSettings: enabled }));
    await waitFor(() => expect(listeners.size).toBe(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel(), channel({
      id: "new-agent", kind: "agent", agentId: "default", name: "My agent", slug: "agent",
    })], fileThreads: [] });
    await act(async () => { for (const listener of listeners) listener({ workspaceId: "workspace-b" }); });
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2);
    await act(async () => { for (const listener of [...listeners]) listener({ workspaceId: "workspace-a" }); });
    expect(await screen.findByTestId("chats-my-agent")).toBeTruthy();
    await waitFor(() => expect(listeners.size).toBe(0));
  });

  it.each([
    { title: "CLI title", body: "A separate body", visible: true },
    { title: "Derived title", body: "Derived title\nMore details", visible: false },
  ])("preserves the title without repeating the first body line: $title", async ({ title, body, visible }) => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ title })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body })] });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-thread"));
    const heading = await screen.findByTestId("chats-thread-post-title");
    expect(heading.textContent).toBe(title);
    expect(heading.classList.contains("sr-only")).toBe(!visible);
    expect(screen.getByTestId("chats-message-body").textContent).toBe(body);
  });

  it("stays absent when the workspace has no agent channel", async () => {
    renderView();
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-my-agent-section")).toBeNull();
  });

  it("renders under Agents, stays out of the group list, and opens on its conversation", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({
          id: "channel-agent",
          name: "agent-internal",
          slug: "agent",
          kind: "agent",
          agentId: "default",
          unreadCount: 2,
        }),
      ],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockImplementation(async (input) => ({
      threads: input.lane === "chat" ? [] : [thread({ channelId: "channel-agent" })],
    }));
    renderView();

    const agentSection = await screen.findByTestId("chats-my-agent-section");
    expect(agentSection.compareDocumentPosition(screen.getByTestId("chats-channels-heading")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getByTestId("chats-my-agent-unread").textContent).toBe("2");
    expect(screen.getAllByTestId("chats-channel-name").map((node) => node.textContent)).toEqual([
      "general",
    ]);

    await user.click(screen.getByTestId("chats-my-agent"));
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("My agent");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Chat", "Posts"]);
    expect(screen.getByTestId("chats-group-lane-chat").getAttribute("aria-selected")).toBe("true");
    expect(
      (screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).placeholder,
    ).toBe("Message your agent…");
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
    // Older posts stay readable under Posts, which takes no new ones.
    await user.click(screen.getByTestId("chats-group-lane-posts"));
    expect(await screen.findByTestId("chats-thread")).toBeTruthy();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

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
          agentId: "default",
        }),
      ],
      fileThreads: [],
    });
    renderView(vi.fn(), vi.fn(), {
      agentSetup: {
        workspaceId: "workspace-a",
        preferredName: "Sam",
        agentName: "Nova",
        runnerConfigured: true,
        runnerEnabled: true,
        agentRunActive: false,
        agents: [{ id: "default", name: "Nova", enabled: true }],
      },
      onSetupAgent,
      userSettings: DEFAULT_USER_SETTINGS,
      onSaveUserSettings: vi.fn(async () => undefined),
      workspacePath: "C:\\people\\ice\\work",
    });

    expect((await screen.findByTestId("chats-my-agent-name")).textContent).toBe("Nova");
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
    expect(runnerProgram('"C:\\Program Files\\nodejs\\node.exe" "C:\\Agent Scripts\\bot.mjs"')).toBe("node.exe bot.mjs");
    expect(runnerProgram("'/opt/my agent/run.sh' --fast")).toBe("run.sh");
    expect(runnerProgram("")).toBe("");
  });

  it("lists agents shared by other people from joined channels, read-only, under who shared them", async () => {
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
          message: message({ presentation: { group: "fixture", hue: null, self: false },
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
          message: message({ presentation: { group: "fixture", hue: null, self: false },
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
    expect(screen.getByTestId("chats-other-agent-name").textContent).toBe("Owner");
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
    // An active agent run is not a set-up agent.
    renderView(vi.fn(), vi.fn(), {
      agentSetup: {
        workspaceId: "workspace-a",
        runnerConfigured: false,
        runnerEnabled: false,
        agentRunActive: true,
        agents: [],
      },
      onSetupAgent: vi.fn(),
      userSettings: DEFAULT_USER_SETTINGS,
      onSaveUserSettings,
    });

    await user.click(await screen.findByTestId("chats-add-agent-open"));
    expect(screen.getByTestId("chats-add-agent-preview").textContent).toContain("Your agent");
    await user.type(screen.getByTestId("chats-add-agent-agent-name"), "Nova");
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(screen.getByTestId("chats-add-agent-preview").textContent).toContain("Nova");
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
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
    expect(onSaveUserSettings).toHaveBeenLastCalledWith(settingsWithAgent({ name: "Nova" }), DEFAULT_USER_SETTINGS);
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

  it("sends a reply from the thread composer and renders agent authorship", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message(),
        message({ presentation: { group: "fixture", hue: null, self: false },
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
      "ice@dohc.ai",
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
    const nonAdjacentReply = message({ presentation: { group: "fixture", hue: null, self: false },
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

    await user.click(contexts[0]!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("draws one author's comments within five minutes as one run with hover actions", async () => {
    const user = userEvent.setup();
    const opening = message({ body: "The full opening post body." });
    const first = message({ id: "comment-1", parentMessageId: opening.id, authorDisplayName: "Ana", body: "First" });
    const second = message({
      id: "comment-2", parentMessageId: opening.id, authorDisplayName: "Ana", body: "Second", createdAtMs: NOW + 60_000,
    });
    const later = message({
      id: "comment-3", parentMessageId: opening.id, authorDisplayName: "Ana", body: "Later", createdAtMs: NOW + 10 * 60_000,
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ messageCount: 4 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening, first, second, later] });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const divider = await screen.findByTestId("chats-comments-divider");
    expect(divider.getAttribute("role")).toBeNull();
    expect(divider.querySelector(".sr-only")?.textContent).toBe("3 comments");
    const items = screen.getAllByTestId("chats-message").filter((element) => element.tagName === "LI");
    expect(items.map((item) => item.dataset.continues)).toEqual(["false", "true", "false"]);
    // The continued comment keeps its author and time for screen readers.
    const author = items[1]!.querySelector('[data-testid="chats-message-author"]');
    expect(author?.textContent).toBe("Ana");
    expect(author?.parentElement?.className).toBe("sr-only");
    // Its hover time is the clock without AM or PM, right-aligned in a slot
    // that ends at the avatar's edge; the full time is its tooltip.
    const slot = items[1]!.querySelector('[data-testid="chats-comment-run-time"]')!;
    expect(slot.className.split(/\s+/)).toEqual(expect.arrayContaining(["left-0", "w-9", "justify-end"]));
    const runTime = slot.querySelector("time")!;
    expect(runTime.textContent).toBe(formatClockDigits(second.createdAtMs));
    expect(runTime.textContent).not.toMatch(/AM|PM/i);
    expect(runTime.getAttribute("title")).toBe(formatChatTime(second.createdAtMs).label);
    expect(items[0]!.querySelector('[data-testid="chats-comment-run-time"]')).toBeNull();
    // Every action sits in the row's toolbar, inside the row.
    const bubble = items[0]!.querySelector('[data-testid="chats-comment-bubble"]')!;
    const toolbar = bubble.querySelector('[data-testid="chats-message-toolbar"]')!;
    expect(toolbar.querySelector('[data-testid="chats-comment-reply"]')?.getAttribute("aria-label")).toBe("Reply");
    expect(toolbar.querySelector('[data-testid="chats-add-reaction"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-testid="chats-message-bookmark"]')).not.toBeNull();
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
        message({ presentation: { group: "fixture", hue: null, self: false },
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
        message({ presentation: { group: "fixture", hue: null, self: false },
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
    await user.type(composer, "@Nova look");

    // Two Enter keydowns in the same tick (no await between): the synchronous
    // in-flight ref must swallow the second so only one send goes out.
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter" });
    resolveSend({ message: message({ id: "m-new", body: "@Nova look" }) });

    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));
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
      message({ id: "m-lane", threadId: "lane", authorKind: "agent", authorDisplayName: "Owner", authorUserId: "agent-owner" }),
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

  it("says a group's new post runs the agent, and leaves when the post starts", async () => {
    const user = userEvent.setup();
    bridgeMock.startChannelThread.mockResolvedValue({
      thread: thread({ id: "thread-new" }), message: message({ threadId: "thread-new", body: "@Nova check it" }), viewerAuthorId: "you",
    });
    renderView(vi.fn(), vi.fn(), withAgent());
    await user.click(await screen.findByTestId("chats-channel"));
    const offer = await pickAgent(user, "chats-new-thread");
    expect(offer.dataset.state).toBe("runs");
    expect(screen.getByTestId("composer-agent-offer-reach").textContent).toBe("reaches work");
    await user.type(screen.getByTestId("chats-new-thread-composer"), "check it{Enter}");
    await screen.findByTestId("chats-thread-view");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });

  it("follows a thread's dispatch once read, and leaves when another thread opens", async () => {
    const user = userEvent.setup();
    const dispatch = deferred<ChatDispatchStateForThreadResult>();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread(), thread({ id: "thread-2", title: "Second" })] });
    bridgeMock.chatDispatchStateForThread.mockReturnValueOnce(dispatch.promise);
    renderView(vi.fn(), vi.fn(), withAgent());
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click((await screen.findAllByTestId("chats-thread"))[0]!);
    expect((await pickAgent(user, "chats")).dataset.state).toBe("unknown");
    await act(async () => { dispatch.resolve({ liveRunId: null, pendingCount: 0, paused: true }); });
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("paused");
    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click((await screen.findAllByTestId("chats-thread"))[1]!);
    await screen.findByTestId("chats-thread-view");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });

  it("says nothing about running in a group's chat, whose dispatch it does not read", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel({ type: "chat" })], fileThreads: [] });
    renderView(vi.fn(), vi.fn(), withAgent());
    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-lane");
    await waitFor(() => expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(false));
    expect((await pickAgent(user, "chats-lane")).dataset.state).toBe("unknown");
    expect(screen.getByTestId("composer-agent-offer-reach").textContent).toBe("Reaches work");
  });

  it("keeps the comment's reply bar clear: the offer floats above the bar", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message(), message({ id: "comment-1", body: "Friday works." })] });
    renderView(vi.fn(), vi.fn(), withAgent());
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click((await screen.findAllByTestId("chats-comment-reply"))[0]!);
    const bar = await screen.findByTestId("chats-replying-mode");
    const offer = await pickAgent(user, "chats");
    expect(offer.parentElement!.firstElementChild).toBe(bar);
    await user.click(screen.getByTestId("chats-replying-cancel"));
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("runs");
  });
});
