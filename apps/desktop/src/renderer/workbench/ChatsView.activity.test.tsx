// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  ChannelThreadRecord,
  ChatChannelRecord,
  ChatMessageRecord,
  DmRecord,
  FileChatThreadRecord,
} from "../../ipc/bridgeContract";
import {
  ChatsView,
  NOW,
  channel,
  thread,
  message,
  personalFeedItem,
  dm,
  bridgeMock,
  shareListing,
  workspaceActivityCallbacks,
  emitWorkspaceActivity,
  renderView,
  navigatorView,
} from "./ChatsView.testHarness";

describe("ChatsView live activity refresh", () => {
  it("refreshes the open Feed with fresh workspace activity content", async () => {
    let refreshed = false;
    bridgeMock.listPersonalChatFeed.mockImplementation(() =>
      Promise.resolve({
        items: [
          personalFeedItem(
            refreshed ? "Fresh Feed update" : "Existing Feed update",
            refreshed ? "message-fresh" : "message-existing",
          ),
        ],
      }),
    );
    renderView();

    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Existing Feed update");

    refreshed = true;
    act(() => emitWorkspaceActivity());

    expect(await screen.findByText("Fresh Feed update")).toBeTruthy();
    expect(screen.queryByText("Existing Feed update")).toBeNull();
    expect(bridgeMock.listPersonalChatFeed).toHaveBeenCalledTimes(2);
  });

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
    let resolveOldRefresh!: (value: {
      items: ReturnType<typeof personalFeedItem>[];
    }) => void;
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
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    await screen.findByText("Old workspace Feed");
    act(() => emitWorkspaceActivity());

    rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
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

  it("re-lists threads when workspace activity changes the open channel feed", async () => {
    const user = userEvent.setup();
    let refreshed = false;
    bridgeMock.listChannelThreads.mockImplementation(() =>
      Promise.resolve({
        threads: refreshed
          ? [thread(), thread({ id: "thread-2", title: "Posted from the CLI" })]
          : [thread()],
      }),
    );
    bridgeMock.listChatMessages.mockImplementation(
      ({ threadId }: { threadId: string }) =>
        Promise.resolve({
          messages: [
            message({
              id: `message-${threadId}`,
              threadId,
              body: threadId === "thread-2" ? "Posted from the CLI" : message().body,
            }),
          ],
        }),
    );
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByText(thread().title);
    expect(screen.queryByText("Posted from the CLI")).toBeNull();
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    refreshed = true;
    act(() => emitWorkspaceActivity());

    expect(await screen.findByText("Posted from the CLI")).toBeTruthy();
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(2);
  });

  it("reloads an open thread's messages, decisions, and run records in place", async () => {
    const user = userEvent.setup();
    const opening = message();
    const agentReport = message({
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
    expect((await screen.findByTestId("chats-run-chip")).textContent).toBe("run run-liv");
    // The same view stayed mounted; activity caused fresh reads rather than a
    // back/forward navigation or optimistic local append.
    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(bridgeMock.listChatMessages.mock.calls.length).toBeGreaterThan(
      messageReadsBefore,
    );
    expect(bridgeMock.listChatThreadDecisions.mock.calls.length).toBeGreaterThan(
      decisionReadsBefore,
    );
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
  });

  // The write lands in a chat the user does not have open, so the roll-up
  // badge on the channel list is the only place it shows. Without the list's
  // own subscription the count waits for a navigation or a relaunch.
  it("raises the channel list's roll-up badge while the list stays on screen", async () => {
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({ channels: [channel({ unreadCount })], fileThreads: [] }),
    );
    renderView();

    await screen.findByTestId("chats-channel-name");
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    expect(workspaceActivityCallbacks.size).toBeGreaterThan(0);

    // An agent posts into a thread nobody opened.
    unreadCount = 3;
    act(() => emitWorkspaceActivity());

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("3");
    // Nothing navigated: the badge appeared on the list itself.
    expect(screen.getByTestId("chats-channels-heading")).toBeTruthy();
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
  });

  // The DM roll-up sits in the same list, but it refreshed only on the
  // 5-second poll — a DM badge lagging beside a live channel badge reads as
  // "no new DMs".
  it("raises the DM roll-up badge the moment a write arrives, not on the next poll", async () => {
    // Fake timers, never advanced: with the clock frozen the 5s poll cannot
    // fire, so it structurally cannot answer for the activity signal — a
    // slow machine cannot false-pass this by letting the poll tick land
    // inside a real-time wait.
    vi.useFakeTimers();
    try {
      let unreadCount = 0;
      bridgeMock.syncDms.mockImplementation(() =>
        Promise.resolve({ available: true, dms: [dm({ unreadCount })] }),
      );
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      screen.getByTestId("chats-dm-item");
      expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
      const syncsBefore = bridgeMock.syncDms.mock.calls.length;

      // An agent's DM write lands while the list is on screen.
      unreadCount = 2;
      act(() => emitWorkspaceActivity());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(bridgeMock.syncDms.mock.calls.length, "remove `void refreshDms()` from the channels-level activity branch. With the clock frozen, no other caller exists to sync.").toBeGreaterThan(syncsBefore);
      expect(screen.getByTestId("chats-dm-unread").textContent).toBe("2");
      // Nothing navigated: the badge appeared on the list itself.
      expect(screen.getByTestId("chats-channels-heading")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // The activity signal fires for every settled file batch and run update,
  // and syncDms is a relay sync, not a local read. The rule (badgeRead
  // precedent): one sync in flight, and a burst arriving mid-sync runs
  // exactly one trailing pass when it settles.
  it("coalesces an activity burst into one in-flight DM sync plus one trailing pass", async () => {
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [dm()] });
    renderView();
    await screen.findByTestId("chats-dm-item");
    const syncsBefore = bridgeMock.syncDms.mock.calls.length;

    let release!: () => void;
    const held = new Promise<{ available: boolean; dms: DmRecord[] }>(
      (resolve) => {
        release = () =>
          resolve({ available: true, dms: [dm({ unreadCount: 1 })] });
      },
    );
    bridgeMock.syncDms.mockImplementation(() => held);
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 1),
    );

    // The burst lands while that sync is in flight.
    act(() => {
      emitWorkspaceActivity();
      emitWorkspaceActivity();
      emitWorkspaceActivity();
    });
    expect(bridgeMock.syncDms.mock.calls.length, "revert refreshDms to a plain un-coalesced sync. Each of these starts its own relay sync and the count below reads syncsBefore + 4.").toBe(syncsBefore + 1);

    // One trailing pass when the held sync settles — not one per event.
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 2),
    );
    expect((await screen.findByTestId("chats-dm-unread")).textContent).toBe("1");
    expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 2);
  });

  // The renderer invariant (AGENTS.md): a slow response for workspace A must
  // never repaint workspace B. The drain made syncDms multi-pass, so the
  // per-pass token check is what stands between a stale relay answer and the
  // switched list.
  it("drops a slow DM sync from the workspace the user left", async () => {
    type DmPage = { available: boolean; dms: DmRecord[] };
    let resolveStale!: (value: DmPage) => void;
    const stale = new Promise<DmPage>((resolve) => {
      resolveStale = resolve;
    });
    let oldReads = 0;
    bridgeMock.syncDms.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId !== "workspace-old") {
          return Promise.resolve({
            available: true,
            dms: [
              dm({
                channelId: "channel-dm-new",
                peerLabel: "carol@example.com",
                unreadCount: 0,
              }),
            ],
          });
        }
        oldReads += 1;
        return oldReads === 1
          ? Promise.resolve({ available: true, dms: [dm()] })
          : stale;
      },
    );
    const view = render(
      <ChatsView
        workspaceId="workspace-old"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await screen.findByTestId("chats-dm-item");
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(oldReads).toBe(2));

    view.rerender(
      <ChatsView
        workspaceId="workspace-new"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-dm-name").textContent).toBe(
        "carol@example.com",
      ),
    );

    await act(async () => {
      resolveStale({ available: true, dms: [dm({ unreadCount: 9 })] });
      await stale;
    });
    expect(screen.getByTestId("chats-dm-name").textContent, "delete the per-pass `if (token !== liveToken.current) return;` inside the drain. This stale answer then repaints the new workspace's list with the old one's DM and a badge of 9.").toBe(
      "carol@example.com",
    );
    expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
  });

  // The dead-era yield: a workspace switch during a stalled old-workspace
  // sync must steal the drain's slot, not queue onto it — a queued pass on a
  // sync that never settles would leave the new workspace's DM list empty
  // forever.
  it("never queues the new workspace's DM sync onto the stalled one it left", async () => {
    // Fake timers, never advanced: the 5s poll cannot fire, so only the
    // switch can start the new workspace's sync. A 2 s real-time wait made
    // the same point and could miss on a loaded gate.
    vi.useFakeTimers();
    try {
      type DmPage = { available: boolean; dms: DmRecord[] };
      const leftBehind = new Promise<DmPage>(() => {
        // never settles: the drain the switch must not wait on
      });
      let oldReads = 0;
      let newReads = 0;
      bridgeMock.syncDms.mockImplementation(
        ({ workspaceId }: { workspaceId: string }) => {
          if (workspaceId !== "workspace-old") {
            newReads += 1;
            return Promise.resolve({
              available: true,
              dms: [
                dm({
                  channelId: "channel-dm-new",
                  peerLabel: "carol@example.com",
                }),
              ],
            });
          }
          oldReads += 1;
          return oldReads === 1
            ? Promise.resolve({ available: true, dms: [dm()] })
            : leftBehind;
        },
      );
      const view = render(
        <ChatsView
          workspaceId="workspace-old"
          onOpenFileChat={vi.fn()}
          onError={vi.fn()}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      screen.getByTestId("chats-dm-item");
      act(() => emitWorkspaceActivity());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(oldReads).toBe(2);

      view.rerender(
        <ChatsView
          workspaceId="workspace-new"
          onOpenFileChat={vi.fn()}
          onError={vi.fn()}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(newReads, "weaken the drain's entry guard to `if (active !== null)`. The switch's own refreshDms then queues onto the dead drain and no workspace-new sync starts.").toBeGreaterThan(0);
      expect(screen.getByTestId("chats-dm-name").textContent).toBe(
        "carol@example.com",
      );
    } finally {
      vi.useRealTimers();
    }
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
    bridgeMock.listChatChannels.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
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
      },
    );
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

  // The switch happens while a badge read for the old workspace is still in
  // flight. Activity in the new workspace must not queue a pass onto it: that
  // pass carries the old workspace's id and the new workspace's liveToken, and
  // the guard would pass while the wrong workspace's channels repaint.
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
    bridgeMock.listChatChannels.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
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
          channels: [
            channel({ id: "channel-left", name: "left-behind", slug: "left-behind" }),
          ],
          fileThreads: [],
        });
      },
    );
    const view = render(
      <ChatsView workspaceId="workspace-old" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("general"),
    );
    // A badge read for the old workspace is now in flight.
    act(() => emitWorkspaceActivity());
    expect(oldWorkspaceReads).toBe(2);

    view.rerender(
      <ChatsView workspaceId="workspace-new" onOpenFileChat={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-name").textContent).toBe("planning"),
    );
    // A write lands in the workspace the user switched TO. It is not swallowed
    // by the read still in flight for the workspace the user left: the new
    // workspace gets its own badge read (its mount read, then this one).
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

  // The share listing is relay-backed for the granted and received rows, and
  // answers "none" when the relay is unreachable — the main handler catches the
  // failure and returns empty rows. A badge refresh that replaced them would
  // let an unrelated file save erase a pending invitation that is still true.
  it("leaves the relay-backed share listing alone while it updates a badge", async () => {
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({ channels: [channel({ unreadCount })], fileThreads: [] }),
    );
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        received: [
          {
            shareId: "share-received",
            channelWireId: "wire-received",
            granterEmail: "owner@example.com",
            access: "read-write",
            ended: false,
          },
        ],
      }),
    );
    renderView();
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    // The relay goes away: the handler resolves, reporting it unreachable.
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: { state: "unreachable" as const },
    });
    unreadCount = 3;
    act(() => emitWorkspaceActivity());

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("3");
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
    // The badge pass asked the local registry, and the relay-backed lookup not
    // at all — its rows are not this reader's to answer.
    expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listJoinedSharedChannels).toHaveBeenCalled();
  });

  // The editor marks a thread read and the shell bumps readRevision, whose
  // refresh does not change liveToken. A badge read issued before it must not
  // put the count it already cleared back on screen.
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
      // The read the editor's mark-read triggers: the count is gone.
      return Promise.resolve({ channels: [channel({ unreadCount: 0 })], fileThreads: [] });
    });
    const navigator = (readRevision: number) =>
      navigatorView(readRevision, { onOpenInTab: vi.fn() });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // A badge read is in flight when the read lands.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);
    view.rerender(navigator(1));
    await waitFor(() => expect(screen.queryByTestId("chats-channel-unread")).toBeNull());

    // The older badge read answers with the count as it was.
    await act(async () => {
      resolveStaleBadge({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      await staleBadge;
    });
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
  });

  // A joined-only correction answers one question. It must not take the other
  // one's place: a full share read still in flight carries the invitations and
  // member rows nothing else in this refresh can produce.
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
      // The readRevision refresh's full lookup: it stalls.
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

    // The full lookup is in flight when a write starts a badge pass.
    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "no longer shared",
      ),
    );

    // The full lookup answers, carrying an invitation only it can report.
    await act(async () => {
      answerFullRead(shareListing({ received: [invitation], joined: [joinedRow] }));
      await Promise.resolve();
    });

    // Both answers stand: the invitation lands, and the newer joined row is
    // not undone by the older listing that carried it.
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
      "no longer shared",
    );
  });

  // The initial load holds the surface at "loading" until its share lookup
  // answers. A badge read that lands during that wait is newer than the
  // snapshot that load is carrying, and dropping it leaves the stale counts on
  // screen until the next event.
  it("keeps a badge result that lands while the first load is still waiting", async () => {
    let answerFirstShares!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerFirstShares = resolve;
        });
      }
      return Promise.resolve(shareListing());
    });
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      // The first load's snapshot is already old by the time it is displayed.
      return Promise.resolve({
        channels: [channel({ unreadCount: reads === 1 ? 2 : 5 })],
        fileThreads: [],
      });
    });
    renderView();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();

    // A write lands while the first load still waits on its share lookup.
    act(() => emitWorkspaceActivity());
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("5");

    // The first load finally answers. Its channels are older; its shares are
    // still the only answer to a question the badge read never asked.
    await act(async () => {
      answerFirstShares(shareListing());
      await Promise.resolve();
    });
    expect(screen.getByTestId("chats-channel-unread").textContent).toBe("5");
  });

  // The badge drain must not be held by a request that may never return. The
  // grant side lives on the relay behind an unbounded fetch; what this reader
  // needs — which channels this machine joined — is local.
  it("keeps refreshing badges while the relay-backed share lookup hangs", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(shareListing({ joined: [joinedRow] }));
      }
      // The relay stopped answering, and nothing bounds that wait.
      return new Promise(() => {});
    });
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({
        channels: [channel({ wireId: "wire-joined", unreadCount })],
        fileThreads: [],
      }),
    );
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({ joined: [joinedRow] });
    renderView();
    await screen.findByTestId("chats-channel-shared");

    unreadCount = 1;
    act(() => emitWorkspaceActivity());
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("1");

    // The second write still gets through: no request is holding the drain.
    unreadCount = 4;
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-unread").textContent).toBe("4"),
    );
    expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1);
  });

  // Another mounted Chats view joins this workspace's first shared channel.
  // The listing then carries a channel this view has no grant row for, and a
  // channel with no grant row reads as this workspace's own: sharing offered
  // on someone else's channel, and a composer on a read-only grant.
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

    // The other view joins, so the registry now has a read-only grant and the
    // channel is pulled locally. This view hears about it as workspace activity.
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

    await waitFor(() =>
      expect(screen.getAllByTestId("chats-channel")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "Shared by owner@example.com — read-only",
      ),
    );

    // Opening it is honest: read-only, and no composer to post with.
    await user.click(screen.getAllByTestId("chats-channel")[1]);
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  // The other side of that rule. While the share metadata is unresolved there
  // is nothing to correct, and a badge pass that claimed the joined lane
  // anyway would starve the listing that owns both lanes — leaving "unknown"
  // on screen, which locks every channel including this workspace's own.
  it("lets the first share listing settle even when a badge pass ran first", async () => {
    let answerShares!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerShares = resolve;
        });
      }
      return Promise.resolve(shareListing());
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(shareReads).toBe(1));

    // A write lands before the share metadata has resolved.
    act(() => emitWorkspaceActivity());
    await screen.findByTestId("chats-channel-name");

    await act(async () => {
      answerShares(shareListing());
      await Promise.resolve();
    });

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // A refresh nobody asked for must not take the surface down to a spinner
  // before it knows anything: it commits nothing on failure, so the error card
  // and its Try again would never come back.
  it("leaves the retry on screen when a background refresh fails over an error", async () => {
    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    const navigator = (readRevision: number) =>
      navigatorView(readRevision, { onOpenInTab: vi.fn() });
    const view = render(navigator(0));
    // The mount refresh is the user's, so it reports its failure.
    expect(await screen.findByText("Try again")).toBeTruthy();

    // A read lands; that background refresh fails too, and says nothing.
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    // The way out is still on screen, and it still works.
    expect(screen.getByText("Try again")).toBeTruthy();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    await userEvent.click(screen.getByText("Try again"));
    expect((await screen.findByTestId("chats-channel-name")).textContent).toBe("general");
  });

  // The same rule on the share lanes. A background lookup that rejects holds
  // no answer about the grants either, and committing "unknown" for it locks
  // every channel — including this workspace's own.
  it("does not lock every channel when a background share lookup rejects", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let shareReads = 0;
    let answerMount!: (value: ReturnType<typeof shareListing>) => void;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerMount = resolve;
        });
      }
      return Promise.reject(new Error("signed out"));
    });
    // No onOpenInTab: this instance navigates in place, so the channel view is
    // reachable. With it, clicking a channel hands off to the shell instead.
    const navigator = navigatorView;
    const user = userEvent.setup();
    const view = render(navigator(0));
    await waitFor(() => expect(shareReads).toBe(1));

    // A read lands while the mount's lookup is still out. That background
    // refresh's lookup rejects.
    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));

    // The request the surface was waiting on answers, and it is believed.
    await act(async () => {
      answerMount(shareListing());
      await Promise.resolve();
    });

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // One listing in flight is what keeps an activity storm off the relay, and
  // the slot is the whole mechanism. A drain that has been superseded must not
  // hand it back when it finally gives up, or the next write opens a second
  // listing beside the one already running.
  it("does not open a second listing when a superseded drain finishes", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let answerAbandoned!: (value: ChannelListPage) => void;
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      // 2 is the drain the navigation abandons; it answers late. 4 is the
      // drain that owns the slot afterwards, and it stays in flight.
      if (reads === 2) {
        return new Promise<ChannelListPage>((resolve) => {
          answerAbandoned = resolve;
        });
      }
      if (reads >= 4) return new Promise<ChannelListPage>(() => {});
      return Promise.resolve({ channels: [channel()], fileThreads: [] });
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-name");

    // A write starts a drain, then a navigation leaves it behind.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(reads).toBe(3));

    // The next write starts the drain that now owns the slot.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(4);

    // The abandoned drain answers and gives up. The slot is not its to release.
    await act(async () => {
      answerAbandoned({ channels: [channel()], fileThreads: [] });
      await Promise.resolve();
    });
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(4);
  });

  // A pass queued before a navigation belongs to the era it was queued in.
  // Running it afterwards would put another listing on the relay for a write
  // the navigation's own refresh has already accounted for.
  it("drops a queued pass that a navigation has moved past", async () => {
    const joinedRow = {
      shareId: "share-joined",
      channelWireId: "wire-joined",
      granterEmail: "owner@example.com",
      access: "read-write" as const,
      ended: false,
    };
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({ joined: [joinedRow] }),
    );
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({
        channels: [channel({ wireId: "wire-joined" })],
        fileThreads: [],
      }),
    );
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let answerCorrection!: (value: { joined: unknown[] }) => void;
    bridgeMock.listJoinedSharedChannels.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerCorrection = resolve;
        }),
    );
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-shared");

    // A write starts a pass; it is inside its joined-grant read.
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listJoinedSharedChannels).toHaveBeenCalled());
    // A second write queues one more pass onto it.
    act(() => emitWorkspaceActivity());
    const readsBeforeNavigation = bridgeMock.listChatChannels.mock.calls.length;

    // The user navigates, which refreshes the list on its own account.
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() =>
      expect(bridgeMock.listChatChannels.mock.calls.length).toBe(
        readsBeforeNavigation + 1,
      ),
    );

    // The pass finishes. Its queued successor belongs to the era before the
    // navigation, so it does not run.
    await act(async () => {
      answerCorrection({ joined: [joinedRow] });
      await Promise.resolve();
    });
    expect(bridgeMock.listChatChannels.mock.calls.length).toBe(
      readsBeforeNavigation + 1,
    );
  });

  // A background failure is fast when the relay is refusing, and the load it
  // lands on top of is slow. The failure holds no answer for the list, so it
  // must not take the lane away from the request that does.
  it("does not strand the first load behind a background failure", async () => {
    type ChannelListPage = {
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };
    let answerFirstLoad!: (value: ChannelListPage) => void;
    let reads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return new Promise<ChannelListPage>((resolve) => {
          answerFirstLoad = resolve;
        });
      }
      return Promise.reject(new Error("offline"));
    });
    const navigator = (readRevision: number) =>
      navigatorView(readRevision, { onOpenInTab: vi.fn() });
    const view = render(navigator(0));
    await waitFor(() => expect(reads).toBe(1));

    // The editor reports a read; that background refresh fails immediately.
    view.rerender(navigator(1));
    await waitFor(() => expect(reads).toBe(2));

    // The first load answers. It is the request the surface was waiting on.
    await act(async () => {
      answerFirstLoad({ channels: [channel({ unreadCount: 2 })], fileThreads: [] });
      await Promise.resolve();
    });

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");
    expect(screen.queryByText("Try again")).toBeNull();
  });

  // The channel listing itself syncs shared channels over the relay before it
  // reads, so it can stall too. Once a navigation has moved past that read it
  // can commit nothing, and a later write must not queue behind it.
  it("frees the badge drain once a navigation leaves its read behind", async () => {
    let reads = 0;
    let unreadCount = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      reads += 1;
      if (reads === 2) return new Promise(() => {});
      return Promise.resolve({
        channels: [channel({ unreadCount })],
        fileThreads: [],
      });
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chats-channel-name");

    // A write starts a badge read that never comes back.
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(2);

    // The user opens a channel and comes back. That read can commit nothing now.
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(reads).toBe(3));

    // The next write is not stranded behind the abandoned read.
    unreadCount = 9;
    act(() => emitWorkspaceActivity());
    expect(reads).toBe(4);
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("9");
  });

  // A failed lookup learned nothing. "Unknown" is a state of the whole share
  // listing, so a response that no longer owns both lanes must not write it:
  // doing so throws away a newer joined-grant answer and locks every channel.
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
      // The refresh the user's back-navigation owns. It stalls, then fails.
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

    // Back out of a channel: goBack owns a foreground overview refresh, whose
    // share lookup is the one that will fail.
    await waitFor(() => expect(screen.getAllByTestId("chats-channel")).toHaveLength(2));
    await user.click(screen.getAllByTestId("chats-channel")[0]);
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(shareReads).toBe(2));

    // A write lands, and the badge pass corrects the joined grant.
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "no longer shared",
      ),
    );

    // Now the older lookup fails.
    await act(async () => {
      failFullRead();
      await Promise.resolve();
    });

    // The correction stands, and nothing locked behind a response that
    // learned nothing: the owned channel still has its composer.
    expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
      "no longer shared",
    );
    await user.click(screen.getAllByTestId("chats-channel")[0]);
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // The other half of the same rule: a failed lookup that does own both lanes
  // must still settle the state, or the share controls wait forever. Unknown
  // fails closed.
  it("commits unknown when the share lookup fails with nothing newer to keep", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();

    // The mount resolved the share metadata: the owned channel is writable.
    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();

    // Back out: that refresh owns both lanes, and its lookup fails.
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2),
    );

    await user.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-readonly-note")).toBeTruthy();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
  });

  // The channel listing syncs joined shared channels before it reads, and that
  // sync records a revoked or downgraded grant. Those joined rows are local, so
  // they are answered even while the relay is down — and until they land, the
  // composer stays enabled on a channel main will refuse to accept posts for.
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
      "no longer shared",
    );

    // The sync finds the grant revoked and records it in the registry, which
    // is what the local read reports.
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({
      joined: [{ ...joinedRow, ended: true }],
    });
    act(() => emitWorkspaceActivity());

    await waitFor(() =>
      expect(screen.getByTestId("chats-channel-shared").textContent).toContain(
        "no longer shared",
      ),
    );
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // Activity fires for every settled file batch and run update, and the
  // channel listing syncs shared channels over the relay before it reads.
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
    // Three unrelated writes, one relay-backed listing.
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2);

    await act(async () => {
      deferred[0]({ channels: [channel({ unreadCount: 1 })], fileThreads: [] });
      await Promise.resolve();
    });
    // The events that arrived mid-read are not lost — they cost one catch-up.
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3));
    await act(async () => {
      deferred[1]({ channels: [channel({ unreadCount: 5 })], fileThreads: [] });
      await Promise.resolve();
    });

    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("5");
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3);
  });

  // A refresh nobody asked for must not spend the answer to one the user did:
  // back-navigation, Join, Leave and the retry button all own an overview
  // request, and losing one leaves a completed action invisible.
  it("does not discard a user-owned overview refresh that activity lands on top of", async () => {
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
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const user = userEvent.setup();
    renderView();

    // Back out of a channel: goBack owns an explicit overview refresh.
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-channel-back"));
    await waitFor(() => expect(deferred.length).toBe(1));

    // A file save lands while that refresh is still in flight, and the badge
    // read it starts fails.
    bridgeMock.listChatChannels.mockRejectedValueOnce(new Error("offline"));
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(3));

    // The user's refresh answers, and its answer is still the one that counts.
    await act(async () => {
      deferred[0]({
        channels: [
          channel(),
          channel({ id: "channel-launch", name: "launch", slug: "launch" }),
        ],
        fileThreads: [],
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getAllByTestId("chats-channel-name").map((node) => node.textContent),
      ).toContain("launch"),
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
    // Navigate back before the thread list resolves.
    await user.click(screen.getByTestId("chats-channel-back"));
    resolveThreads({ threads: [thread({ title: "Stale thread" })] });

    await screen.findAllByTestId("chats-channel-name");
    expect(screen.queryByText("Stale thread")).toBeNull();
  });

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

  it("clears sent reply text after leave and return resets reply mode", async () => {
    const user = userEvent.setup();
    const opening = message();
    const parentComment = message({
      id: "comment-reply-parent",
      parentMessageId: opening.id,
      authorDisplayName: "Ana",
      body: "Can you confirm?",
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [opening, parentComment],
    });

    let resolveSend!: (value: { message: ChatMessageRecord }) => void;
    const pendingSend = new Promise<{ message: ChatMessageRecord }>((resolve) => {
      resolveSend = resolve;
    });
    bridgeMock.sendChatMessage.mockImplementation(() => pendingSend);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-comment-reply"));
    await user.type(screen.getByTestId("chats-composer"), "Confirmed{Enter}");
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: parentComment.id,
        body: "Confirmed",
      }),
    );

    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe(
      "Confirmed",
    );

    await act(async () => {
      resolveSend({
        message: message({
          id: "comment-sent-reply",
          parentMessageId: parentComment.id,
          body: "Confirmed",
        }),
      });
      await pendingSend;
    });

    await waitFor(() =>
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(screen.getByText("Confirmed")).toBeTruthy();
    fireEvent.submit(screen.getByTestId("chats-composer").closest("form")!);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});
