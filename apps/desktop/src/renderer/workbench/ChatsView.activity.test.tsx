// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatChannelRecord,
  ChatMessageRecord,
  FileChatThreadRecord,
} from "../../ipc/bridgeContract";
import {
  ChatsView,
  NOW,
  channel,
  thread,
  message,
  openingPreview,
  personalFeedItem,
  bridgeMock,
  shareListing,
  workspaceActivityCallbacks,
  emitWorkspaceActivity,
  emitCloudSessionChanged,
  renderView,
  navigatorView,
} from "./ChatsView.testHarness";

describe("ChatsView live activity refresh", () => {
  it("drops an older pagination page when activity starts a fresh Feed refresh", async () => {
    type FeedPage = {
      items: ReturnType<typeof personalFeedItem>[];
      nextCursor?: string;
    };
    let resolveOlder!: (value: FeedPage) => void;
    const olderPage = new Promise<FeedPage>((resolve) => {
      resolveOlder = resolve;
    });
    bridgeMock.listPersonalChatFeed
      .mockResolvedValueOnce({
        items: [personalFeedItem("Initial Feed item", "message-initial")],
        nextCursor: "older-cursor",
      })
      .mockImplementationOnce(() => olderPage)
      .mockResolvedValueOnce({
        items: [personalFeedItem("Activity refresh item", "message-refresh")],
      });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Initial Feed item");
    await userEvent.click(await screen.findByTestId("chats-feed-more"));
    act(() => emitWorkspaceActivity());
    await screen.findByText("Activity refresh item");

    await act(async () => {
      resolveOlder({
        items: [personalFeedItem("Stale paginated item", "message-stale-page")],
      });
      await olderPage;
    });
    expect(screen.queryByText("Stale paginated item")).toBeNull();
    expect(screen.getByText("Activity refresh item")).toBeTruthy();
  });

  it("drops a delayed Feed activity response after switching workspaces", async () => {
    let resolveOldRefresh!: (value: { items: ReturnType<typeof personalFeedItem>[] }) => void;
    const oldRefresh = new Promise<{
      items: ReturnType<typeof personalFeedItem>[];
    }>((resolve) => {
      resolveOldRefresh = resolve;
    });
    let oldWorkspaceReads = 0;
    bridgeMock.listPersonalChatFeed.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === "workspace-new") {
          return Promise.resolve({
            items: [personalFeedItem("New workspace Feed", "message-new")],
          });
        }
        oldWorkspaceReads += 1;
        return oldWorkspaceReads === 1
          ? Promise.resolve({
              items: [personalFeedItem("Old workspace Feed", "message-old-initial")],
            })
          : oldRefresh;
      },
    );
    const { rerender } = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Old workspace Feed");
    act(() => emitWorkspaceActivity());

    rerender(<ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId("chats-personal-feed")).toBeNull());
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("New workspace Feed");

    await act(async () => {
      resolveOldRefresh({
        items: [personalFeedItem("Stale old workspace Feed", "message-old-stale")],
      });
      await oldRefresh;
    });
    expect(screen.queryByText("Stale old workspace Feed")).toBeNull();
    expect(screen.getByText("New workspace Feed")).toBeTruthy();
  });

  it("reloads an open thread's messages, decisions, and run records in place", async () => {
    const user = userEvent.setup();
    const opening = message();
    const agentReport = message({
      presentation: { group: "fixture", hue: null, self: false },
      id: "agent-live-report",
      parentMessageId: opening.id,
      authorKind: "agent",
      authorDisplayName: "You",
      body: "done: checked the exports",
      createdAtMs: NOW + 1,
    });
    const openDecision = {
      threadId: "thread-1",
      messageId: agentReport.id,
      state: "open" as const,
      atMs: NOW + 1,
    };
    const run = {
      runId: "run-live-123456",
      threadId: "thread-1",
      triggerMessageId: opening.id,
      command: "node fakeChatRunner.mjs report",
      startedAtMs: NOW,
      exitCode: 0,
      logPath: "logs/run-live-123456.log",
    };
    let refreshed = false;
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 1 })],
    });
    bridgeMock.listChatMessages.mockImplementation(() =>
      Promise.resolve({ messages: refreshed ? [opening, agentReport] : [opening] }),
    );
    bridgeMock.listChatThreadDecisions.mockImplementation(() =>
      Promise.resolve({ decisions: refreshed ? [openDecision] : [] }),
    );
    bridgeMock.chatRunRecordsForThread.mockImplementation(() =>
      Promise.resolve({
        runs: refreshed ? { [agentReport.id]: run } : {},
      }),
    );
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    expect(screen.getByTestId("chats-message-body").textContent).toBe(opening.body);
    expect(screen.queryByText(agentReport.body)).toBeNull();
    expect(screen.queryByTestId("chats-comment-decision-open")).toBeNull();
    expect(screen.queryByTestId("chats-run-chip")).toBeNull();
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    const messageReadsBefore = bridgeMock.listChatMessages.mock.calls.length;
    const decisionReadsBefore = bridgeMock.listChatThreadDecisions.mock.calls.length;
    refreshed = true;
    act(() => {
      emitWorkspaceActivity();
    });

    expect(await screen.findByText(agentReport.body)).toBeTruthy();
    expect(await screen.findByTestId("chats-comment-decision-open")).toBeTruthy();
    expect((await screen.findByTestId("chats-run-chip")).textContent).toBe("Details");
    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(bridgeMock.listChatMessages.mock.calls.length).toBeGreaterThan(messageReadsBefore);
    expect(bridgeMock.listChatThreadDecisions.mock.calls.length).toBeGreaterThan(
      decisionReadsBefore,
    );
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
  });

  it("raises the channel list's roll-up badge while the list stays on screen", async () => {
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({ channels: [channel({ unreadCount })], fileThreads: [] }),
    );
    renderView();

    await screen.findByTestId("chats-channel-name");
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    expect(screen.getByTestId("chats-channel-name").className).not.toContain("font-semibold");
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    unreadCount = 3;
    act(() => emitWorkspaceActivity());

    const unread = await screen.findByTestId("chats-channel-unread");
    expect(unread.textContent).toBe("3 unread");
    expect(unread.className).toBe("sr-only");
    expect(screen.getByTestId("chats-channel-name").className).toContain("font-semibold");
    expect(screen.getByTestId("chats-channels-heading")).toBeTruthy();
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
  });

  it("drops a slow list refresh from the workspace the user left", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let resolveStale!: (value: ChannelListPage) => void;
    const staleRefresh = new Promise<ChannelListPage>((resolve) => {
      resolveStale = resolve;
    });
    let oldWorkspaceReads = 0;
    bridgeMock.listChatChannels.mockImplementation(({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId !== "workspace-old") {
        return Promise.resolve({
          channels: [channel({ id: "channel-new", name: "planning", slug: "planning" })],
          fileThreads: [],
        });
      }
      oldWorkspaceReads += 1;
      return oldWorkspaceReads === 1
        ? Promise.resolve({ channels: [channel()], fileThreads: [] })
        : staleRefresh;
    });
    const view = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("general"),
    );
    act(() => emitWorkspaceActivity());

    view.rerender(
      <ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );

    await act(async () => {
      resolveStale({
        channels: [channel({ unreadCount: 9 })],
        fileThreads: [],
      });
      await staleRefresh;
    });
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning");
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
  });

  it("never repaints one workspace's list with the one the user left", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let resolveLeftBehind!: (value: ChannelListPage) => void;
    const leftBehindRead = new Promise<ChannelListPage>((resolve) => {
      resolveLeftBehind = resolve;
    });
    let oldWorkspaceReads = 0;
    let newWorkspaceReads = 0;
    bridgeMock.listChatChannels.mockImplementation(({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId !== "workspace-old") {
        newWorkspaceReads += 1;
        return Promise.resolve({
          channels: [channel({ id: "channel-new", name: "planning", slug: "planning" })],
          fileThreads: [],
        });
      }
      oldWorkspaceReads += 1;
      if (oldWorkspaceReads === 1) {
        return Promise.resolve({ channels: [channel()], fileThreads: [] });
      }
      if (oldWorkspaceReads === 2) return leftBehindRead;
      // Any later read for the workspace the user left is the drain this
      // test exists to prevent; make what it would paint unmistakable.
      return Promise.resolve({
        channels: [channel({ id: "channel-left", name: "left-behind", slug: "left-behind" })],
        fileThreads: [],
      });
    });
    const view = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("general"),
    );
    act(() => emitWorkspaceActivity());
    expect(oldWorkspaceReads).toBe(2);

    view.rerender(
      <ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );
    act(() => emitWorkspaceActivity());
    expect(newWorkspaceReads).toBe(2);

    await act(async () => {
      resolveLeftBehind({ channels: [channel()], fileThreads: [] });
      await leftBehindRead;
    });

    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );
    expect(screen.queryByText("left-behind")).toBeNull();
    expect(oldWorkspaceReads).toBe(2);
  });

  it("cannot restore an unread count the editor already cleared", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let resolveStaleBadge!: (value: ChannelListPage) => void;
    const staleBadge = new Promise<ChannelListPage>((resolve) => {
      resolveStaleBadge = resolve;
    });
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      }
      if (reads === 2) return staleBadge;
      return Promise.resolve({ channels: [channel({ unreadCount: 0 })], fileThreads: [] });
    });
    const navigator = (readRevision: number) =>
      navigatorView(readRevision, { onOpenInTab: vi.fn() });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2 unread");

    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);
    view.rerender(navigator(1));
    await waitFor(() => expect(screen.queryByTestId("chats-channel-unread")).toBeNull());

    await act(async () => {
      resolveStaleBadge({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      await staleBadge;
    });
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
  });

  it("does not let a joined-only correction swallow a full share read", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    const invitation = {
      shareId: "share-invite",
      channelWireId: "wire-invite",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-joined" })],
      fileThreads: [],
    });
    let answerFullRead!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(shareListing({ joined: [joinedRow] }));
      }
      return new Promise((resolve) => {
        answerFullRead = resolve;
      });
    });
    // The badge pass's local read, issued later: the sync recorded the revoke.
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    const navigator = (readRevision: number) =>
      navigatorView(readRevision, { onOpenInTab: vi.fn() });
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-shared");
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();

    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain("No longer shared"),
    );

    await act(async () => {
      answerFullRead(shareListing({ received: [invitation], joined: [joinedRow] }));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect(screen.getByTestId("chats-channel-shared").textContent).toContain("No longer shared");
  });

  // The badge drain must not be held by a request that may never return. The
  // grant side lives on the relay behind an unbounded fetch; what this reader
  // needs — which channels this machine joined — is local.

  it("resolves the first shared channel a view learns about from a write", async () => {
    const sharedChannel = channel({
      id: "channel-shared",
      name: "shared-one",
      slug: "shared-one",
      wireId: "wire-shared",
    });
    let channelsIncludeShared = false;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({
        channels: channelsIncludeShared ? [channel(), sharedChannel] : [channel()],
        fileThreads: [],
      }),
    );
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-name");

    channelsIncludeShared = true;
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [
        {
          shareId: "share-joined",
          channelWireId: "wire-shared",
          granterEmail: "owner@example.com",
          access: "read-only" as const,
          ended: false,
        },
      ],
    });
    act(() => emitWorkspaceActivity());

    await waitFor(() => expect(screen.getAllByTestId("chats-channel")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "Shared by owner@example.com · Read-only",
      ),
    );

    await user.click(screen.getAllByTestId("chats-channel")[1]);
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  it("leaves the retry on screen when a background refresh fails over an error", async () => {
    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    const navigator = (readRevision: number) =>
      navigatorView(readRevision, { onOpenInTab: vi.fn() });
    const view = render(navigator(0));
    // The mount refresh is the user's, so it reports its failure.
    expect(await screen.findByText("Try again")).toBeTruthy();

    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Try again")).toBeTruthy();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    await userEvent.click(screen.getByText("Try again"));
    expect((await screen.findByTestId("chats-channel-name")).textContent).toBe("general");
  });

  it("does not let a failed share lookup undo a newer joined correction", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    const joinedChannel = channel({
      id: "channel-joined",
      name: "joined-one",
      slug: "joined-one",
      wireId: "wire-joined",
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), joinedChannel],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let failFullRead!: () => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(shareListing({ joined: [joinedRow] }));
      }
      return new Promise((_resolve, reject) => {
        failFullRead = () => reject(new Error("signed out"));
      });
    });
    // The badge pass's local read, issued later: the sync recorded the revoke.
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    const user = userEvent.setup();
    renderView();

    await waitFor(() => expect(screen.getAllByTestId("chats-channel")).toHaveLength(2));
    await user.click(screen.getAllByTestId("chats-channel")[0]);
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(shareReads).toBe(2));

    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain("No longer shared"),
    );

    await act(async () => {
      failFullRead();
      await Promise.resolve();
    });

    expect(screen.getByTestId("chats-channel-shared").textContent).toContain("No longer shared");
    await user.click(screen.getAllByTestId("chats-channel")[0]);
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  it("commits unknown when the share lookup fails with nothing newer to keep", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();

    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-readonly-note")).toBeTruthy();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  it("corrects a joined grant the listing's sync revoked, and keeps the cached invitation", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    const invitation = {
      shareId: "share-invite",
      channelWireId: "wire-invite",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: "wire-joined" })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({ received: [invitation], joined: [joinedRow] }),
    );
    renderView();
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared by owner@example.com",
    );
    expect(screen.getByTestId("chats-channel-shared").textContent).not.toContain(
      "No longer shared",
    );

    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    act(() => emitWorkspaceActivity());

    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain("No longer shared"),
    );
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  it("keeps one channel listing in flight through an activity storm, then catches up once", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    const deferred: Array<(value: ChannelListPage) => void> = [];
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({ channels: [channel()], fileThreads: [] });
      }
      return new Promise<ChannelListPage>((resolve) => deferred.push(resolve));
    });
    renderView();
    await screen.findByTestId("chats-channel-name");

    act(() => {
      emitWorkspaceActivity();
      emitWorkspaceActivity();
      emitWorkspaceActivity();
    });
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2);

    await act(async () => {
      deferred[0]({ channels: [channel({ unreadCount: 1 })], fileThreads: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3));
    await act(async () => {
      deferred[1]({ channels: [channel({ unreadCount: 5 })], fileThreads: [] });
      await Promise.resolve();
    });

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("5 unread");
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["their own post", { authorDisplayName: "You", authorUserId: "user-me" }],
    ["someone else's post, as a moderator", { authorDisplayName: "Sam", authorUserId: "user-sam" }],
  ])("drops the deleted first line from the title of %s", async (_case, author) => {
    const words = "I'll bring bean seeds on Saturday.";
    const opening = message({ ...author, id: "message-1", body: words });
    const reply = message({ id: "message-2", body: "Great, see you there.", createdAtMs: NOW + 1 });
    const listed = (title: string, deletedAtMs?: number) => ({
      threads: [
        thread({
          title,
          messageCount: 2,
          openingMessage: openingPreview({
            ...author,
            bodySnippet: deletedAtMs === undefined ? words : "",
            ...(deletedAtMs === undefined ? {} : { deletedAtMs }),
          }),
        }),
      ],
    });
    bridgeMock.listChannelThreads.mockResolvedValue(listed(words));
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening, reply] });
    renderView(vi.fn(), vi.fn(), { initialNav: { level: "channel", channel: channel() } });
    await userEvent.click(await screen.findByTestId("chats-post-card"));
    expect((await screen.findByTestId("chats-thread-title")).textContent).toBe(words);

    // The delete lands: the engine's title falls back with the first line gone.
    bridgeMock.listChannelThreads.mockResolvedValue(listed("New chat", NOW + 2));
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [{ ...opening, body: "", deletedAtMs: NOW + 2 }, reply],
    });
    act(() => emitWorkspaceActivity());

    await screen.findByTestId("chats-message-deleted");
    // The header names the post's Group, and the thread shows no heading.
    await waitFor(() =>
      expect(screen.getByTestId("chats-thread-title").textContent).toBe("Post in #general"),
    );
    expect(screen.getByTestId("chats-thread-post-title").className).toBe("sr-only");
    // A screen reader's heading names the post as the header does.
    expect(screen.getByTestId("chats-thread-post-title").textContent).toBe("Post in #general");
    expect(screen.getByTestId("chats-thread-view").textContent).not.toContain(words);

    // Its card shows the author, the time and the deleted line, with no title.
    await userEvent.click(screen.getByTestId("chats-thread-back"));
    await screen.findByTestId("chats-post-deleted");
    expect(screen.queryByTestId("chats-post-title")).toBeNull();
    expect(screen.getByTestId("chats-post-card").textContent).not.toContain("New chat");
  });

  it("keeps a Group post's own title of New chat while its first message stands", async () => {
    const opening = message({ id: "message-1", body: "A different opening line" });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [
        thread({
          title: "New chat",
          messageCount: 1,
          openingMessage: openingPreview({ bodySnippet: "A different opening line" }),
        }),
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    renderView(vi.fn(), vi.fn(), { initialNav: { level: "channel", channel: channel() } });
    await userEvent.click(await screen.findByTestId("chats-post-card"));

    expect((await screen.findByTestId("chats-thread-title")).textContent).toBe("New chat");
  });

  it("reads a deleted first line's title again at the next activity after a failed read", async () => {
    const words = "I'll bring bean seeds on Saturday.";
    const opening = message({ id: "message-1", body: words });
    const reply = message({ id: "message-2", body: "Great, see you there.", createdAtMs: NOW + 1 });
    const listed = (title: string, deletedAtMs?: number) => ({
      threads: [
        thread({
          title,
          messageCount: 2,
          openingMessage: openingPreview({
            bodySnippet: deletedAtMs === undefined ? words : "",
            ...(deletedAtMs === undefined ? {} : { deletedAtMs }),
          }),
        }),
      ],
    });
    bridgeMock.listChannelThreads.mockResolvedValue(listed(words));
    bridgeMock.listChatMessages.mockImplementation(async () => ({ messages: [opening, reply] }));
    renderView(vi.fn(), vi.fn(), { initialNav: { level: "channel", channel: channel() } });
    await userEvent.click(await screen.findByTestId("chats-post-card"));
    expect((await screen.findByTestId("chats-thread-title")).textContent).toBe(words);

    // The delete lands, and the title's read fails once.
    bridgeMock.listChannelThreads.mockImplementation(async () => {
      throw new Error("The engine is busy.");
    });
    bridgeMock.listChatMessages.mockImplementation(async () => ({
      messages: [{ ...opening, body: "", deletedAtMs: NOW + 2 }, reply],
    }));
    act(() => emitWorkspaceActivity());
    await screen.findByTestId("chats-message-deleted");
    await waitFor(() => expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByTestId("chats-thread-title").textContent).toBe(words);

    bridgeMock.listChannelThreads.mockResolvedValue(listed("New chat", NOW + 2));
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-thread-title").textContent).toBe("Post in #general"),
    );
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
    await waitFor(() => expect(screen.getAllByTestId("chats-thread-unread")).toHaveLength(1));
  });

  it("an open thread's refresh marks it read again only when it shows more messages", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 2, lastReadSequence: 1, unreadCount: 1 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message(), message({ id: "m2" })],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(1));

    for (let refresh = 0; refresh < 3; refresh += 1) {
      const reads = bridgeMock.listChatMessages.mock.calls.length;
      act(() => emitWorkspaceActivity());
      await waitFor(() =>
        expect(bridgeMock.listChatMessages.mock.calls.length).toBeGreaterThan(reads),
      );
      await act(async () => {});
    }
    expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(1);

    // A read marked while signed out is published only when the owner marks it again.
    act(() => emitCloudSessionChanged("session-b", "ready"));
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(2));
    expect(bridgeMock.markChatThreadRead).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      upToSequence: 2,
    });

    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message(), message({ id: "m2" }), message({ id: "m3" })],
    });
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(3));
    expect(bridgeMock.markChatThreadRead).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      upToSequence: 3,
    });
  });
});

describe("ChatsView liveness", () => {
  it("keeps a newer send busy when an abandoned thread send settles", async () => {
    const user = userEvent.setup();
    const firstThread = thread({ id: "thread-1", title: "First thread" });
    const secondThread = thread({ id: "thread-2", title: "Second thread" });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [firstThread, secondThread],
    });

    let resolveFirstSend!: (value: { message: ChatMessageRecord }) => void;
    let resolveSecondSend!: (value: { message: ChatMessageRecord }) => void;
    const firstSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const secondSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveSecondSend = resolve;
    });
    bridgeMock.sendChatMessage
      .mockImplementationOnce(() => firstSend)
      .mockImplementationOnce(() => secondSend);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click((await screen.findAllByTestId("chats-thread"))[0]!);
    await user.type(screen.getByTestId("chats-composer"), "First send{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click((await screen.findAllByTestId("chats-thread"))[1]!);
    const nextComposer = await screen.findByTestId("chats-composer");
    await user.clear(nextComposer);
    await user.type(nextComposer, "Second send{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      resolveFirstSend({
        message: message({
          id: "message-from-first-thread",
          threadId: firstThread.id,
          body: "First send",
        }),
      });
      await firstSend;
    });

    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText("First send")).toBeNull();

    await act(async () => {
      resolveSecondSend({
        message: message({
          id: "message-from-second-thread",
          threadId: secondThread.id,
          body: "Second send",
        }),
      });
      await secondSend;
    });

    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Second send")).toBeTruthy();
  });

  it("keeps a preserved draft locked when returning to its in-flight thread", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });

    let resolveSend!: (value: { message: ChatMessageRecord }) => void;
    const pendingSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveSend = resolve;
    });
    bridgeMock.sendChatMessage.mockImplementation(() => pendingSend);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Still sending{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    const restoredComposer = await screen.findByTestId("chats-composer");
    expect((restoredComposer as HTMLTextAreaElement).value).toBe("Still sending");
    expect((restoredComposer as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.submit(restoredComposer.closest("form")!);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend({
        message: message({
          id: "message-original-send",
          body: "Still sending",
        }),
      });
      await pendingSend;
    });

    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("");
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Still sending")).toBeTruthy();
  });
});
