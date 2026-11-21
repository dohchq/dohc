// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatBookmarkRecord } from "../../ipc/bridgeContract";
import { chatTabPath } from "./workbenchState";
import {
  ChatsView,
  NOW,
  channel,
  thread,
  message,
  openingPreview,
  bridgeMock,
  renderView,
} from "./ChatsView.testHarness";
import { deferred } from "../../testing/deferred";

describe("ChatsView expand-to-tab", () => {
  it("marks the page variant on the root so the tab surface is testable", async () => {
    renderView(vi.fn(), vi.fn(), { variant: "page" });
    const view = await screen.findByTestId("chats-personal-feed");
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

  it("keeps thread navigation inside its channel editor", async () => {
    const user = userEvent.setup();
    const onOpenInTab = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
    });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "channel", channel: channel() },
      onOpenInTab,
      editorTabPath: chatTabPath({ kind: "channel", id: channel().id }),
    });

    await user.click(await screen.findByTestId("chats-post-card"));

    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
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
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("general");
  });

  // Such as a Group the owner set to No access: the copy rebuilds, the shell
  // mounts again, and the restored tab names a Group Chats no longer lists.
  it("closes a restored Group's tab once Chats lists without that Group", async () => {
    const list = deferred<{ channels: ReturnType<typeof channel>[]; fileThreads: [] }>();
    bridgeMock.listChatChannels.mockReturnValue(list.promise);
    const onCloseTab = vi.fn();
    const onNavChange = vi.fn();
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      editorTabPath: chatTabPath({ kind: "channel", id: "garden" }),
      onOpenInTab: vi.fn(),
      onCloseTab,
      onNavChange,
    });
    // Not while the list loads.
    await act(async () => {});
    expect(onCloseTab).not.toHaveBeenCalled();

    await act(async () => list.resolve({ channels: [channel()], fileThreads: [] }));

    await waitFor(() => expect(onCloseTab).toHaveBeenCalledOnce());
    expect(onNavChange).not.toHaveBeenCalledWith({ level: "channels" });
  });

  it("keeps a restored Group's tab while Chats cannot list", async () => {
    bridgeMock.listChatChannels.mockRejectedValue(new Error("ECONNRESET"));
    const onCloseTab = vi.fn();
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      editorTabPath: chatTabPath({ kind: "channel", id: "garden" }),
      onOpenInTab: vi.fn(),
      onCloseTab,
    });
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalled());
    await act(async () => {});
    expect(onCloseTab).not.toHaveBeenCalled();
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
      expect(onNavChange).toHaveBeenCalledWith(expect.objectContaining({ level: "thread" })),
    );
    expect(onNavChange).not.toHaveBeenCalledWith({ level: "channels" });
    expect(onNavChange.mock.calls[0]?.[0]).toMatchObject({ level: "thread" });
  });

  it("restores unsent drafts alongside the seeded conversation", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "thread", channel: channel(), thread: thread() },
      initialDrafts: {
        composer: "half-typed reply",
        newThreadBody: "",
        replyTarget: null,
        resolveTargetMessageId: null,
        poll: { threadId: "thread-1", choices: ["Thursday", "Friday"], open: true },
        newThreadPoll: null,
      },
    });

    await screen.findByTestId("chats-thread-view");
    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe(
        "half-typed reply",
      ),
    );
    expect(
      screen.getAllByTestId("chats-poll-choice").map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Thursday", "Friday"]);
  });

  it("keeps a handed-off poll with its thread when the tab returns to the group", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "channel", channel: channel() },
      initialDrafts: {
        composer: "Lunch?",
        newThreadBody: "",
        replyTarget: null,
        resolveTargetMessageId: null,
        poll: { threadId: "thread-1", choices: ["Soup", "Salad"], open: true },
        newThreadPoll: null,
      },
    });

    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    expect(
      screen.getAllByTestId("chats-poll-choice").map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Soup", "Salad"]);
  });

  it("restores the composer's reply/resolve mode, not just its text", async () => {
    // Without the mode, a reply (or decision resolution) drafted before the
    // handoff would post as a plain top-level comment after it.
    const user = userEvent.setup();
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "answer", parentMessageId: "message-1", body: "replying mid-expand" }),
    });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "thread", channel: channel(), thread: thread() },
      initialDrafts: {
        composer: "replying mid-expand",
        newThreadBody: "",
        replyTarget: { messageId: "message-1", authorLabel: "You" },
        resolveTargetMessageId: "message-1",
        poll: null,
        newThreadPoll: null,
      },
    });

    await screen.findByTestId("chats-thread-view");
    expect(await screen.findByTestId("chats-resolving-mode")).toBeTruthy();
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
    await user.click(screen.getByTestId("chats-send"));
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: "message-1",
        body: "replying mid-expand",
        resolves: { messageId: "message-1" },
      }),
    );
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
      expect(onDraftsChange).toHaveBeenCalledWith(expect.objectContaining({ newThreadBody: "hi" })),
    );
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
          message: message({ parentMessageId: "opening-message" }),
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
          message: message({ parentMessageId: "opening-message" }),
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
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const oldButton = await screen.findByTestId("chats-feed-bookmark");
    await userEvent.click(oldButton);
    expect((oldButton as HTMLButtonElement).disabled).toBe(true);

    rerender(<ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />);
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
