// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type ChatsNav } from "./ChatsView";
import {
  ChatsView,
  NOW,
  channel,
  thread,
  message,
  openingPreview,
  personalFeedItem,
  fileThread,
  bridgeMock,
  emitWorkspaceActivity,
  renderView,
  shareListing,
} from "./ChatsView.testHarness";
import { deferred } from "../../testing/deferred";

// Like opens the emoji picker; the reaction is written when a choice is
// picked. jsdom measures every box as empty and the picker dismisses itself
// when its trigger sits outside the viewport, so the trigger gets a size.
async function openPicker(like: HTMLElement) {
  vi.spyOn(like, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 32, 32));
  await userEvent.click(like);
  return screen.findByTestId("chats-feed-reaction-picker");
}

function choiceFor(picker: HTMLElement, emoji: string) {
  return within(picker)
    .getAllByTestId("chats-feed-reaction-choice")
    .find((button) => button.dataset.emoji === emoji)!;
}

async function pickReaction(like: HTMLElement, emoji: string) {
  await userEvent.click(choiceFor(await openPicker(like), emoji));
}

// A Home item the way main lists it: the viewer is named per thread.
function homeItem(body: string, id: string) {
  return { ...personalFeedItem(body, id), viewerAuthorId: "author-you" };
}

function like(messageId: string, authorId = "author-you") {
  return {
    reactionId: `reaction-${messageId}-${authorId}`,
    messageId,
    threadId: "thread-1",
    emoji: "👍",
    authorId,
    authorKind: "human" as const,
    authorDisplayName: authorId,
  };
}

// A raw code carries no words of its own, so the caller's sentence is the
// whole message the test can pin.
const wireFailure = () => new Error("ECONNRESET");

function feedPill() {
  return screen.getByTestId("chats-feed-reaction-pill");
}

// A pending write marks the message's controls aria-disabled and leaves them
// focusable; a locked group disables them natively.
function isPending(control: HTMLElement) {
  return control.getAttribute("aria-disabled") === "true";
}

describe("ChatsView hybrid feed", () => {
  it("keeps Home in the editor while Open Groups reveals the sidebar", async () => {
    const onOpenNavigator = vi.fn();
    renderView(vi.fn(), vi.fn(), { variant: "page", onOpenNavigator });
    const feed = await screen.findByTestId("chats-personal-feed");
    expect(screen.queryByTestId("chats-feed-back")).toBeNull();
    expect(screen.queryByTestId("chats-view")).toBeNull();
    await userEvent.click(screen.getByTestId("chats-feed-empty-groups"));
    expect(onOpenNavigator).toHaveBeenCalledOnce();
    expect(screen.getByTestId("chats-personal-feed")).toBe(feed);
  });

  it("does not render the sidebar catalogue for an editor destination cleared after leaving", async () => {
    const onOpenNavigator = vi.fn();
    renderView(vi.fn(), vi.fn(), { variant: "page", initialNav: { level: "channels" }, onOpenNavigator });
    await screen.findByTestId("chats-page-empty");
    expect(screen.queryByTestId("chats-view")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Chats" }));
    expect(onOpenNavigator).toHaveBeenCalledOnce();
  });

  it("opens Groups from an empty Home", async () => {
    const onNavCommand = vi.fn();
    renderView(vi.fn(), vi.fn(), { onNavCommand });
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("No posts in your groups yet.");
    await userEvent.click(screen.getByTestId("chats-feed-empty-groups"));
    expect(onNavCommand).toHaveBeenLastCalledWith({ level: "channels" });
    expect(await screen.findByTestId("chats-channel")).toBeTruthy();
  });

  it.each([
    { access: "read-only", ended: false, locked: true },
    { access: "read-write", ended: true, locked: true },
    { access: "read-write", ended: false, locked: false },
  ])("sets Home Like availability for joined $access groups, ended=$ended", async ({ access, ended, locked }) => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-joined" })], fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing({
      joined: [{ channelWireId: "wire-joined", access, ended, shareId: "share-1" }],
    }));
    const item = personalFeedItem("Shared post", "shared-message");
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [{ ...item, channel: { ...item.channel, wireId: "wire-joined" } }],
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const like = await screen.findByTestId("chats-feed-like");
    // The trigger stays visible either way; a locked group only disables it.
    expect(like.getAttribute("aria-label")).toBe("Add reaction");
    expect((like as HTMLButtonElement).disabled).toBe(locked);
    if (locked) {
      await userEvent.click(like);
      expect(screen.queryByTestId("chats-feed-reaction-picker")).toBeNull();
    } else {
      await pickReaction(like, "👍");
    }
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(locked ? 0 : 1);
  });

  it("shows a known viewer's Like before the write and its listing answer", async () => {
    const write = deferred<unknown>();
    const listing = deferred<unknown>();
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [homeItem("A post", "message-1")] });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockImplementationOnce(() => listing.promise);
    renderView(vi.fn(), onError);
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await pickReaction(await screen.findByTestId("chats-feed-like"), "👍");

    expect(feedPill().dataset.emoji).toBe("👍");
    expect(feedPill().textContent).toContain("1");
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();

    // The write names the reaction's own author, which after sign-in can be a
    // removed local alias. Only the listing may rename the viewer.
    await act(async () => {
      write.resolve({ reaction: { ...like("message-1", "local-you"), state: "added" }, viewerAuthorId: "local-you" });
      await write.promise;
    });
    expect(bridgeMock.listChatReactions).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1" });
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      listing.resolve({ reactions: [like("message-1")], viewerAuthorId: "author-you" });
      await listing.promise;
    });
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    expect(feedPill().textContent).toContain("1");
    expect(onError).not.toHaveBeenCalled();
  });

  it("restores the prior reaction when a Home write fails", async () => {
    const write = deferred<unknown>();
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [{ ...homeItem("Liked by two", "message-1"), reactions: [like("message-1"), like("message-1", "author-peer")] }],
    });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    renderView(vi.fn(), onError);
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const pill = await screen.findByTestId("chats-feed-reaction-pill");
    expect(pill.textContent).toContain("2");
    await userEvent.click(pill);

    expect(bridgeMock.setChatReaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-1", emoji: "👍", state: "removed" }),
    );
    expect(feedPill().textContent).toContain("1");
    expect(feedPill().getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      write.reject(wireFailure());
      await write.promise.catch(() => undefined);
    });
    expect(feedPill().textContent).toContain("2");
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    expect(onError).toHaveBeenCalledWith("Could not update that reaction.", expect.any(Error));
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
    // Home shows no row identity; usePersonalChatFeed.test.ts pins that the
    // exact prior rows, not a rebuilt one, come back.
  });

  it("keeps an acknowledged Like when Home cannot reload reactions", async () => {
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [homeItem("A post", "message-1")] });
    bridgeMock.listChatReactions.mockRejectedValue(wireFailure());
    renderView(vi.fn(), onError);
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await pickReaction(await screen.findByTestId("chats-feed-like"), "👍");

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "Your reaction was saved, but Home could not reload reactions.",
        expect.any(Error),
      ),
    );
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    expect(feedPill().textContent).toContain("1");
  });

  it("rests one item's reaction controls while its write is pending and keeps other items usable", async () => {
    const write = deferred<unknown>();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [homeItem("First", "message-a"), homeItem("Second", "message-b")],
    });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [like("message-a"), like("message-b")],
      viewerAuthorId: "author-you",
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const likes = await screen.findAllByTestId("chats-feed-like");
    await pickReaction(likes[0]!, "👍");
    const items = screen.getAllByTestId("chats-feed-item");
    const pillA = within(items[0]!).getByTestId("chats-feed-reaction-pill");
    expect(pillA.getAttribute("aria-pressed")).toBe("true");
    // The whole message rests: a second emoji would share the same listing.
    expect(isPending(likes[0]!)).toBe(true);
    expect(isPending(pillA)).toBe(true);
    await userEvent.click(pillA);
    await userEvent.click(likes[0]!);
    expect(screen.queryByTestId("chats-feed-reaction-picker")).toBeNull();
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(1);

    expect(isPending(likes[1]!)).toBe(false);
    await pickReaction(likes[1]!, "👍");
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
    expect(bridgeMock.setChatReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "message-b", state: "added" }),
    );

    await act(async () => {
      write.resolve({ reaction: { ...like("message-a"), state: "added" }, viewerAuthorId: "author-you" });
      await write.promise;
    });
    // Settled: the message's controls come back and the next click writes.
    await waitFor(() => expect(isPending(likes[0]!)).toBe(false));
    expect(isPending(pillA)).toBe(false);
    await pickReaction(likes[0]!, "👍");
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(3);
    expect(bridgeMock.setChatReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "message-a", state: "removed" }),
    );
  });

  it("frees a reopened Home's controls and lets no old completion free a newer write", async () => {
    const oldWrite = deferred<unknown>();
    const oldListing = deferred<unknown>();
    const newWrite = deferred<unknown>();
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [homeItem("A post", "message-1")] });
    bridgeMock.setChatReaction
      .mockImplementationOnce(() => oldWrite.promise)
      .mockImplementationOnce(() => newWrite.promise);
    bridgeMock.listChatReactions
      .mockImplementationOnce(() => oldListing.promise)
      .mockResolvedValue({ reactions: [like("message-1")], viewerAuthorId: "author-you" });
    renderView(vi.fn(), onError);
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await pickReaction(await screen.findByTestId("chats-feed-like"), "👍");
    await userEvent.click(screen.getByTestId("chats-feed-back"));
    await userEvent.click(await screen.findByTestId("chats-feed-link"));

    // A fresh Home: nothing rests, and the server has no like yet.
    const trigger = await screen.findByTestId("chats-feed-like");
    expect(isPending(trigger)).toBe(false);
    expect(screen.queryByTestId("chats-feed-reaction-pill")).toBeNull();
    await pickReaction(trigger, "👍");
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
    expect(isPending(trigger)).toBe(true);

    // The old write settles in full. It neither repaints nor frees the new claim.
    await act(async () => {
      oldWrite.resolve({ reaction: { ...like("message-1"), state: "added" }, viewerAuthorId: "author-you" });
      await oldWrite.promise;
      oldListing.resolve({ reactions: [like("message-1"), like("message-1", "author-peer")], viewerAuthorId: "author-you" });
      await oldListing.promise;
    });
    await userEvent.click(trigger);
    expect(screen.queryByTestId("chats-feed-reaction-picker")).toBeNull();
    expect(isPending(trigger)).toBe(true);
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
    expect(feedPill().textContent).toContain("1");

    await act(async () => {
      newWrite.resolve({ reaction: { ...like("message-1"), state: "added" }, viewerAuthorId: "author-you" });
      await newWrite.promise;
    });
    await waitFor(() => expect(isPending(trigger)).toBe(false));
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus on the Like trigger through a pending write and never moves focus on completion", async () => {
    const writeA = deferred<unknown>();
    const writeB = deferred<unknown>();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [homeItem("First", "message-a"), homeItem("Second", "message-b")],
    });
    bridgeMock.setChatReaction
      .mockImplementationOnce(() => writeA.promise)
      .mockImplementationOnce(() => writeB.promise);
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [like("message-a"), like("message-b")],
      viewerAuthorId: "author-you",
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const [likeA, likeB] = await screen.findAllByTestId("chats-feed-like");

    // Picking returns focus to the trigger. Pending, it stays focusable and
    // refuses to open the picker again, so Enter changes nothing.
    await pickReaction(likeA!, "👍");
    expect(document.activeElement).toBe(likeA);
    expect(isPending(likeA!)).toBe(true);
    expect((likeA as HTMLButtonElement).disabled).toBe(false);
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByTestId("chats-feed-reaction-picker")).toBeNull();
    expect(document.activeElement).toBe(likeA);
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(1);

    // The user stays put: completion leaves focus where it is.
    await act(async () => {
      writeA.resolve({ reaction: { ...like("message-a"), state: "added" }, viewerAuthorId: "author-you" });
      await writeA.promise;
    });
    await waitFor(() => expect(isPending(likeA!)).toBe(false));
    expect(document.activeElement).toBe(likeA);

    // The user moves on: completion must not pull focus back.
    await pickReaction(likeB!, "👍");
    expect(document.activeElement).toBe(likeB);
    const [commentA] = screen.getAllByRole("button", { name: "Comment" });
    commentA!.focus();
    await act(async () => {
      writeB.resolve({ reaction: { ...like("message-b"), state: "added" }, viewerAuthorId: "author-you" });
      await writeB.promise;
    });
    await waitFor(() => expect(isPending(likeB!)).toBe(false));
    expect(document.activeElement).toBe(commentA);
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
  });

  it("keeps a saved Like when a Feed page read before the write lands late", async () => {
    const stale = deferred<unknown>();
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({ items: [homeItem("A post", "message-1")] })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({
        items: [{ ...homeItem("A post", "message-1"), reactions: [like("message-1")] }],
      });
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [like("message-1")], viewerAuthorId: "author-you" });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByTestId("chats-feed-like");

    // The refresh reads the thread first; the write is acknowledged after.
    act(() => emitWorkspaceActivity());
    expect(screen.getByText("Loading…")).toBeTruthy();
    await pickReaction(screen.getByTestId("chats-feed-like"), "👍");
    await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledTimes(1));
    // The acknowledgement dropped the pre-write page and read it again.
    expect(bridgeMock.listPersonalChatFeed).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      stale.resolve({ items: [homeItem("A post", "message-1")] });
      await stale.promise;
    });
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("drops a delayed Home reaction failure after leaving Home", async () => {
    const write = deferred<unknown>();
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [homeItem("A post", "message-1")] });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    renderView(vi.fn(), onError);
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await pickReaction(await screen.findByTestId("chats-feed-like"), "👍");
    await userEvent.click(screen.getByTestId("chats-feed-back"));
    await waitFor(() => expect(screen.queryByTestId("chats-personal-feed")).toBeNull());

    await act(async () => {
      write.reject(wireFailure());
      await write.promise.catch(() => undefined);
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops a delayed Home reaction answer from another workspace", async () => {
    const write = deferred<unknown>();
    const onError = vi.fn();
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [homeItem("A post", "message-1")] });
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [like("message-1")], viewerAuthorId: "author-you" });
    const view = (workspaceId: string) => (
      <ChatsView workspaceId={workspaceId} onOpenFileChat={vi.fn()} onError={onError} />
    );
    const { rerender } = render(view("workspace-a"));
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await pickReaction(await screen.findByTestId("chats-feed-like"), "👍");
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");

    rerender(view("workspace-b"));
    await waitFor(() => expect(screen.queryByTestId("chats-personal-feed")).toBeNull());
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByTestId("chats-feed-like");
    expect(screen.queryByTestId("chats-feed-reaction-pill")).toBeNull();

    await act(async () => {
      write.resolve({ reaction: { ...like("message-1"), state: "added" }, viewerAuthorId: "author-you" });
      await write.promise;
    });
    await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1" }));
    expect(screen.queryByTestId("chats-feed-reaction-pill")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a pending Home Like through a Feed refresh", async () => {
    const write = deferred<unknown>();
    const refresh = deferred<unknown>();
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({ items: [homeItem("A post", "message-1")] })
      .mockImplementationOnce(() => refresh.promise);
    bridgeMock.setChatReaction.mockImplementationOnce(() => write.promise);
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [like("message-1")], viewerAuthorId: "author-you" });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await pickReaction(await screen.findByTestId("chats-feed-like"), "👍");
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");

    // The refresh read the thread before the write landed, so it has no like.
    act(() => emitWorkspaceActivity());
    expect(bridgeMock.listPersonalChatFeed).toHaveBeenCalledTimes(2);
    await act(async () => {
      refresh.resolve({ items: [homeItem("A post, edited", "message-1")] });
      await refresh.promise;
    });
    expect(screen.getByText("A post, edited")).toBeTruthy();
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      write.resolve({ reaction: { ...like("message-1"), state: "added" }, viewerAuthorId: "author-you" });
      await write.promise;
    });
    await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledTimes(1));
    expect(feedPill().getAttribute("aria-pressed")).toBe("true");
    // Settled, so the next click is a new write.
    await pickReaction(screen.getByTestId("chats-feed-like"), "👍");
    expect(bridgeMock.setChatReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "message-1", state: "removed" }),
    );
  });

  it.each([
    { name: "opening post", openingId: "message-1", comment: false },
    { name: "ordinary comment", openingId: "opening", comment: true },
    { name: "reply without opening metadata", parentId: "opening", comment: true },
    { name: "post without opening metadata", comment: false },
  ])("uses the right Home context and bookmark target for an $name", async ({ openingId, parentId, comment }) => {
    const item = personalFeedItem("Home message", "message-1");
    bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [{
      ...item,
      message: { ...item.message, ...(parentId ? { parentMessageId: parentId } : {}) },
      ...(openingId ? { openingMessage: message({ id: openingId }) } : {}),
    }] });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const card = within(await screen.findByTestId("chats-feed-item"));
    expect(card.queryByText(item.thread.title) !== null).toBe(comment);
    expect(card.getByRole("button", { name: comment ? "Reply" : "Comment" })).toBeTruthy();
    await userEvent.click(card.getByTestId("chats-feed-bookmark"));
    expect(bridgeMock.saveChatBookmark).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      target: comment
        ? { kind: "message", threadId: "thread-1", messageId: "message-1" }
        : { kind: "thread", threadId: "thread-1" },
      mode: "live",
    });
  });

  it("shows an opening post saved in Groups as Saved on Home", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [{ ...personalFeedItem("Opening post", "message-1"), openingMessage: message() }],
    });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-post-bookmark"));
    await waitFor(() => expect(screen.getByTestId("chats-post-bookmark").getAttribute("aria-pressed")).toBe("true"));
    await userEvent.click(screen.getByTestId("chats-channel-back"));
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const saved = await screen.findByTestId("chats-feed-bookmark");
    expect(saved.getAttribute("aria-pressed")).toBe("true");
    expect(saved.textContent).toContain("Saved");
  });

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

    await screen.findByTestId("chats-personal-feed");
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

    await screen.findByTestId("chats-personal-feed");
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

  it("offers one icon bookmark action without a separate snapshot action", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openingMessage: openingPreview() })],
      viewerAuthorId: "you@example.com",
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    const bookmark = await screen.findByRole("button", {
      name: "Save as file",
    });
    expect(screen.queryByRole("button", { name: "Bookmark chat as snapshot" })).toBeNull();
    await user.click(bookmark);

    expect(bridgeMock.saveChatBookmark).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      target: { kind: "thread", threadId: "thread-1" },
      mode: "live",
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
      "You",
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
    expect(screen.queryByTestId("chats-feed-reaction-pill")).toBeNull();
    const picker = await openPicker(like);
    const thumbs = choiceFor(picker, "👍");
    expect(thumbs.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(thumbs);
    expect(screen.queryByTestId("chats-feed-reaction-picker")).toBeNull();

    expect(bridgeMock.setChatReaction).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      messageId: "message-like",
      emoji: "👍",
      state: "added",
    });
    const pill = await screen.findByTestId("chats-feed-reaction-pill");
    expect(pill.dataset.emoji).toBe("👍");
    expect(pill.textContent).toContain("1");
    // The listing named the viewer, so the picker now shows the choice as yours.
    expect(choiceFor(await openPicker(like), "👍").getAttribute("aria-pressed")).toBe("true");
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
      items: [
        {
          ...personalFeedItem("Already liked", "message-liked"),
          reactions: [mine],
          viewerAuthorId: "author-you",
        },
      ],
    });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const like = await screen.findByTestId("chats-feed-like");
    expect(screen.getByTestId("chats-feed-reaction-pill").dataset.emoji).toBe("👍");
    const thumbs = choiceFor(await openPicker(like), "👍");
    expect(thumbs.getAttribute("aria-pressed")).toBe("true");
    bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "author-you" });
    await userEvent.click(thumbs);
    expect(bridgeMock.setChatReaction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-liked", emoji: "👍", state: "removed" }),
    );
    await waitFor(() => expect(screen.queryByTestId("chats-feed-reaction-pill")).toBeNull());
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
        { ...personalFeedItem("First in thread", "message-a"), viewerAuthorId: "author-you" },
        { ...personalFeedItem("Second in thread", "message-b"), viewerAuthorId: "author-you" },
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
    await pickReaction(likes[0]!, "👍");
    await pickReaction(likes[1]!, "👍");
    const items = screen.getAllByTestId("chats-feed-item");
    await waitFor(() =>
      expect(within(items[1]!).getByTestId("chats-feed-reaction-pill").dataset.emoji).toBe("👍"),
    );
    // A's stale listing (only A liked) lands last. B stays liked.
    await act(async () => {
      answerA({ reactions: [reactionFor("message-a")], viewerAuthorId: "author-you" });
      await lateA;
    });
    expect(within(items[0]!).getByTestId("chats-feed-reaction-pill").dataset.emoji).toBe("👍");
    expect(within(items[1]!).getByTestId("chats-feed-reaction-pill").dataset.emoji).toBe("👍");
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
