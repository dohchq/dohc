// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type ChatsNav } from "./ChatsView";
import {
  NOW,
  channel,
  thread,
  message,
  openingPreview,
  personalFeedItem,
  fileThread,
  bridgeMock,
  renderView,
} from "./ChatsView.testHarness";

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

  // An in-place conversation click is a COMMAND, and the shell must
  // hear it synchronously in the click. The passive onNavChange report is an
  // effect: it flushes after the microtask queue, and on an exact repeat of
  // the current destination it changes nothing at all — a pending DM lookup
  // resolving in that window would remount the page over the message the
  // user just jumped to.
  it("reports a page feed click as a command, ahead of the passive nav report", async () => {
    const onNavChange = vi.fn();
    const onNavCommand = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [personalFeedItem("Feed update worth revisiting", "message-feed")],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ id: "message-feed", body: "Feed update worth revisiting" })],
    });
    renderView(vi.fn(), vi.fn(), { variant: "page", onNavChange, onNavCommand });

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const post = await screen.findByText("Feed update worth revisiting");
    await userEvent.click(post.closest("button")!);

    expect(onNavCommand).toHaveBeenCalledWith(
      expect.objectContaining({ level: "thread", focusMessageId: "message-feed" }),
    );
    // The command preceded the passive report of that destination.
    const commandOrder = onNavCommand.mock.invocationCallOrder[0]!;
    const reportIndex = onNavChange.mock.calls.findIndex(
      ([nav]) => (nav as ChatsNav).level === "thread",
    );
    expect(reportIndex).toBeGreaterThanOrEqual(0);
    expect(commandOrder).toBeLessThan(
      onNavChange.mock.invocationCallOrder[reportIndex]!,
    );
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
      "Poll open",
    );
    expect(screen.getByTestId("chats-post-reaction-pill").textContent).toContain("1");
    expect(screen.getByTestId("chats-post-agent-badge").textContent).toBe("agent");
    expect(cards[1]?.getAttribute("data-author-kind")).toBe("agent");
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

  it("likes a post from Home and shows who reacted", async () => {
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [personalFeedItem("A post to like", "message-like")],
    });
    bridgeMock.setChatReaction.mockResolvedValue({
      reaction: {
        reactionId: "reaction-like",
        messageId: "message-like",
        threadId: "thread-1",
        emoji: "👍",
        authorId: "author-you",
        authorKind: "human",
        authorDisplayName: "You",
        state: "added",
      },
      viewerAuthorId: "author-you",
    });
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [
        {
          reactionId: "reaction-like",
          messageId: "message-like",
          threadId: "thread-1",
          emoji: "👍",
          authorId: "author-you",
          authorKind: "human",
          authorDisplayName: "You",
        },
      ],
      viewerAuthorId: "author-you",
    });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const like = await screen.findByTestId("chats-feed-like");
    expect(like.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(like);

    expect(bridgeMock.setChatReaction).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "message-like",
      emoji: "👍",
      state: "added",
    });
    await waitFor(() =>
      expect(screen.getByTestId("chats-feed-like").getAttribute("aria-pressed")).toBe("true"),
    );
    const pill = screen.getByTestId("chats-feed-reaction-pill");
    expect(pill.dataset.emoji).toBe("👍");
    expect(pill.textContent).toContain("1");
  });

  it("opens Home with an already-liked post pressed, and unlikes it", async () => {
    const mine = {
      reactionId: "reaction-mine",
      messageId: "message-liked",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "author-you",
      authorKind: "human" as const,
      authorDisplayName: "You",
    };
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [{ ...personalFeedItem("Already liked", "message-liked"), reactions: [mine] }],
    });
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [mine],
      viewerAuthorId: "author-you",
    });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const like = await screen.findByTestId("chats-feed-like");
    await waitFor(() => expect(like.getAttribute("aria-pressed")).toBe("true"));
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "author-you" });
    await userEvent.click(like);
    expect(bridgeMock.setChatReaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-liked", state: "removed" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-feed-like").getAttribute("aria-pressed")).toBe("false"),
    );
  });

  it("keeps two Home items from one thread on their own answers", async () => {
    const reactionFor = (messageId: string) => ({
      reactionId: `reaction-${messageId}`,
      messageId,
      threadId: "thread-1",
      emoji: "👍",
      authorId: "author-you",
      authorKind: "human" as const,
      authorDisplayName: "You",
    });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        personalFeedItem("First in thread", "message-a"),
        personalFeedItem("Second in thread", "message-b"),
      ],
    });
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "author-you" });
    bridgeMock.setChatReaction.mockResolvedValue({
      reaction: { ...reactionFor("message-a"), state: "added" },
      viewerAuthorId: "author-you",
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const likes = await screen.findAllByTestId("chats-feed-like");
    expect(likes).toHaveLength(2);

    // A's listing lags; B's answers first with both likes on the thread.
    let answerA!: (value: { reactions: ReturnType<typeof reactionFor>[]; viewerAuthorId: string }) => void;
    const lateA = new Promise<{ reactions: ReturnType<typeof reactionFor>[]; viewerAuthorId: string }>(
      (resolve) => { answerA = resolve; },
    );
    bridgeMock.listChatReactions
      .mockImplementationOnce(() => lateA)
      .mockResolvedValueOnce({
        reactions: [reactionFor("message-a"), reactionFor("message-b")],
        viewerAuthorId: "author-you",
      });
    await userEvent.click(likes[0]!);
    await userEvent.click(likes[1]!);
    await waitFor(() =>
      expect(screen.getAllByTestId("chats-feed-like")[1]!.getAttribute("aria-pressed")).toBe("true"),
    );
    // A's stale listing (only A liked) lands last. B stays liked.
    await act(async () => {
      answerA({ reactions: [reactionFor("message-a")], viewerAuthorId: "author-you" });
      await lateA;
    });
    const after = screen.getAllByTestId("chats-feed-like");
    expect(after[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(after[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps Saved beside Open file once a post is saved", async () => {
    const onOpenPath = vi.fn();
    bridgeMock.listChatBookmarks.mockResolvedValue({
      bookmarks: [
        {
          bookmarkId: "bookmark-thread-1",
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
      ],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread()],
      viewerAuthorId: "author-you",
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath });

    await userEvent.click(await screen.findByTestId("chats-channel"));
    const saved = await screen.findByTestId("chats-post-bookmark");
    await waitFor(() => expect(saved.getAttribute("aria-pressed")).toBe("true"));
    expect(saved.textContent).toContain("Saved");
    await userEvent.click(screen.getByTestId("chats-post-bookmark-open"));
    expect(onOpenPath).toHaveBeenCalledWith("Bookmarks/Chats/Friday--thread-1.md");
    // Saved is still the reverse path.
    await userEvent.click(saved);
    expect(bridgeMock.archiveChatBookmark).toHaveBeenCalled();
  });
});
