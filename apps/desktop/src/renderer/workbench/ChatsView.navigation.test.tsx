// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatBookmarkRecord } from "../../ipc/bridgeContract";
import {
  ChatsView,
  NOW,
  channel,
  thread,
  message,
  openingPreview,
  dm,
  bridgeMock,
  workspaceActivityCallbacks,
  emitWorkspaceActivity,
  renderView,
} from "./ChatsView.testHarness";

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
