// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GROUP_NAME_TAKEN_ERROR } from "../../ipc/errorWords";
import {
  ChatsView,
  channel,
  bridgeMock,
  message,
  thread,
  shareListing,
  emitCloudSessionChanged,
  emitWorkspaceActivity,
  renderView,
  navigatorView,
} from "./ChatsView.testHarness";
import { deferred } from "../../testing/deferred";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";

describe("ChatsView channels", () => {
  describe("in a joined workspace at Comment", () => {
    function joined(createsGroups: boolean, channels = [channel({ name: "Launch team" })]) {
      bridgeMock.listChatChannels.mockResolvedValue({ channels, fileThreads: [] });
      bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
      renderView(vi.fn(), vi.fn(), { joinedWorkspace: { createsGroups } });
    }

    it("shows a Group's composer and replies, with no Add people", async () => {
      joined(false);
      fireEvent.contextMenu(await screen.findByTestId("chats-channel"), {
        clientX: 40,
        clientY: 60,
      });
      expect(screen.queryByTestId("chat-row-menu-add-people")).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      fireEvent.click(screen.getByTestId("chats-channel"));
      expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
      expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
      expect(screen.queryByTestId("chats-share-channel")).toBeNull();
    });

    it("keeps General closed, as the relay does", async () => {
      joined(false, [
        channel({ id: "general", name: "General", wireId: "channel_wire_general_v1" }),
      ]);
      fireEvent.click(await screen.findByTestId("chats-channel"));
      expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe(
        "Members post in Groups only.",
      );
      expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    });

    // A Group's own rule decides its composer: View only reads, and Can post
    // takes posts even from a member at View.
    it.each([
      ["comment", "view", "Only admins and the owner post in Team."],
      ["view", "view", "Only admins and the owner post in Team."],
      ["view", "comment", null],
    ] as const)(
      "at %s with the Group at %s, shows the composer only where the Group takes posts",
      async (member, level, note) => {
        const team = channel({ id: "channel-team", name: "Team", wireId: "wire-team" });
        bridgeMock.listChatChannels.mockResolvedValue({ channels: [team], fileThreads: [] });
        bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
        bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
        renderView(vi.fn(), vi.fn(), {
          joinedWorkspace: {
            createsGroups: false,
            groupLevels: {
              groupDefault: member,
              groups: new Map<string, "view" | "comment" | "edit">(
                level === member ? [] : [["wire-team", level]],
              ),
            },
          },
        });
        fireEvent.click(await screen.findByTestId("chats-channel"));
        if (note === null) {
          expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
          expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
        } else {
          expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe(note);
          expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
        }
      },
    );

    // Read state is the reader's own, so a post read in a View only Group
    // leaves its unread count behind.
    it("marks a post read in a Group at View", async () => {
      const team = channel({ id: "channel-team", name: "Team", wireId: "wire-team" });
      bridgeMock.listChatChannels.mockResolvedValue({ channels: [team], fileThreads: [] });
      bridgeMock.listChannelThreads.mockResolvedValue({
        threads: [
          thread({
            channelId: "channel-team",
            messageCount: 1,
            lastReadSequence: 0,
            unreadCount: 1,
          }),
        ],
      });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
      renderView(vi.fn(), vi.fn(), {
        joinedWorkspace: {
          createsGroups: false,
          groupLevels: { groupDefault: "comment", groups: new Map([["wire-team", "view"]]) },
        },
      });
      await userEvent.click(await screen.findByTestId("chats-channel"));
      await userEvent.click(await screen.findByTestId("chats-thread"));
      const note = await screen.findByTestId("chats-readonly-note");
      expect(note.textContent).toBe("Only admins and the owner post in Team.");
      // In the reply composer's column, with the lock.
      expect(note.className).toContain("max-w-[640px]");
      expect(note.querySelector("svg.lucide-lock")).not.toBeNull();
      await waitFor(() =>
        expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
          workspaceId: "workspace-a",
          threadId: "thread-1",
          upToSequence: 1,
        }),
      );
    });

    it("shows no Agents section and makes no saved-message calls", async () => {
      bridgeMock.listChatChannels.mockResolvedValue({
        channels: [channel({ name: "Launch team" })],
        fileThreads: [],
      });
      renderView(vi.fn(), vi.fn(), {
        joinedWorkspace: { createsGroups: false },
        userSettings: DEFAULT_USER_SETTINGS,
      });
      await screen.findByTestId("chats-channel");
      expect(screen.queryByTestId("chats-my-agent-section")).toBeNull();
      expect(screen.queryByText("Add an agent")).toBeNull();
      expect(bridgeMock.listChatBookmarks).not.toHaveBeenCalled();
    });

    it("offers New group to an admin only", async () => {
      joined(true);
      expect(await screen.findByTestId("chats-new-channel")).toBeTruthy();
      cleanup();
      joined(false);
      await screen.findByTestId("chats-channel");
      expect(screen.queryByTestId("chats-new-channel")).toBeNull();
    });

    it("puts one muted line under an empty Groups heading", async () => {
      joined(false, []);
      expect((await screen.findByTestId("chats-channels-empty")).textContent).toBe(
        "No Groups yet.",
      );
    });
  });

  it("keeps reaction writes ordered when switching away from and remounting a chat lane", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ type: "both" })],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockImplementation(async (input) => ({
      threads: input.lane === "chat" ? [thread()] : [],
    }));
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    const writes: ReturnType<typeof deferred<void>>[] = [];
    bridgeMock.setChatReaction.mockImplementation(() => {
      const write = deferred<void>();
      writes.push(write);
      return write.promise;
    });
    renderView();
    fireEvent.click(await screen.findByTestId("chats-channel"));
    fireEvent.click(await screen.findByTestId("chats-group-lane-chat"));
    const quick = (await screen.findAllByTestId("chats-lane-quick-reaction"))[0]!;
    fireEvent.click(quick);
    fireEvent.click(quick);
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByTestId("chats-group-lane-posts"));
    expect(screen.queryByTestId("chats-lane-quick-reaction")).toBeNull();
    fireEvent.click(screen.getByTestId("chats-group-lane-chat"));
    fireEvent.click((await screen.findAllByTestId("chats-lane-quick-reaction"))[0]!);
    expect(writes).toHaveLength(1);
    await act(async () => writes[0]!.resolve());
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(bridgeMock.setChatReaction.mock.lastCall?.[0].state).toBe("added");
    await act(async () => writes[1]!.resolve());
  });

  it("creates the group from Try again after the dialog closed", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    bridgeMock.createChatChannel
      .mockRejectedValueOnce(new Error("The workspace engine is not running."))
      .mockResolvedValueOnce({
        channel: channel({ id: "channel-9", name: "launch", slug: "launch", wireId: "channel-9" }),
      });
    renderView(vi.fn(), onError);

    await user.click(await screen.findByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch");
    await user.click(screen.getByTestId("chats-new-channel-submit"));
    await screen.findByTestId("chats-new-channel-error");
    await user.click(screen.getByTestId("chats-new-channel-cancel"));

    const retry = onError.mock.calls[0]?.[2] as () => void;
    act(() => retry());
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("launch");
    expect(bridgeMock.createChatChannel).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      name: "launch",
      type: "chat",
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("offers Open when Try again finds the group name taken and opens that group", async () => {
    const user = userEvent.setup();
    const onError = vi.fn<Parameters<typeof ChatsView>[0]["onError"]>();
    const taken = new Error("A group with that name already exists.");
    taken.name = GROUP_NAME_TAKEN_ERROR;
    const existing = channel({ id: "channel-9", name: "Launch team", slug: "launch-team" });
    bridgeMock.createChatChannel
      .mockRejectedValueOnce(new Error("The workspace engine is not running."))
      .mockRejectedValueOnce(taken);
    renderView(vi.fn(), onError);

    await user.click(await screen.findByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "Launch_team");
    await user.click(screen.getByTestId("chats-new-channel-submit"));
    await screen.findByTestId("chats-new-channel-error");
    await user.click(screen.getByTestId("chats-new-channel-cancel"));

    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), existing],
      fileThreads: [],
    });
    act(() => onError.mock.calls[0]?.[2]?.());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenLastCalledWith(
      "A group with that name already exists.",
      taken,
      undefined,
      undefined,
      {
        title: "dohc could not create #Launch_team",
        identity: "group-name-taken:launch-team",
        action: expect.objectContaining({ label: "Open", run: expect.any(Function), ends: true }),
      },
    );
    act(() => onError.mock.calls[1]?.[4]?.action?.run());
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("Launch team");
    expect(bridgeMock.listChannelThreads).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      channelId: existing.id,
    });
    expect(bridgeMock.createChatChannel).toHaveBeenCalledTimes(2);
  });

  it("creates a group with the type and purpose the form holds", async () => {
    const user = userEvent.setup();
    bridgeMock.createChatChannel.mockResolvedValue({
      channel: channel({
        id: "channel-10",
        name: "Launch team",
        slug: "launch-team",
        type: "both",
        purpose: "Ship it.",
        wireId: "channel-10",
      }),
    });
    renderView();

    await user.click(await screen.findByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "Launch team");
    await user.type(screen.getByTestId("chats-new-channel-purpose"), "Ship it.");
    await user.click(screen.getByTestId("chats-new-channel-type-both"));
    await user.click(screen.getByTestId("chats-new-channel-submit"));

    await waitFor(() =>
      expect(bridgeMock.createChatChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        name: "Launch team",
        type: "both",
        purpose: "Ship it.",
      }),
    );
    const view = await screen.findByTestId("chats-channel-view");
    expect(view.dataset.groupType).toBe("both");
    expect(screen.getByTestId("chats-group-lane-chat")).toBeTruthy();
  });
  it("shows a joined workspace's Groups at View with no way to post, add people or add a Group", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ name: "Launch team" })],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    const user = userEvent.setup();
    renderView(vi.fn(), vi.fn(), {
      joinedWorkspace: {
        postingClosed: "Only people who can comment post here.",
        createsGroups: false,
      },
    });
    await user.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe(
      "Only people who can comment post here.",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
    await user.click(screen.getByTestId("chats-channel-back"));
    await screen.findByTestId("chats-channels-heading");
    expect(screen.queryByTestId("chats-new-channel")).toBeNull();
  });

  it("counts no unread messages in a Group the person can no longer reach once the membership ended", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ name: "Launch team", unreadCount: 3 })],
      fileThreads: [],
    });
    renderView(vi.fn(), vi.fn(), {
      joinedWorkspace: {
        postingClosed: "Your membership ended.",
        createsGroups: false,
        ended: true,
      },
    });
    const row = await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    expect(row.textContent).not.toContain("3");
  });
});

describe("ChatsView panel navigator unread badges", () => {
  function navigator(readRevision: number, threadRevision = 0) {
    return navigatorView(readRevision, { onOpenInTab: vi.fn(), threadRevision });
  }

  it("keeps a working navigator when the badge refresh fails, and retries on the next read", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2 unread");

    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    // The channel list is still there — a stale badge beats an error card.
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
    expect(screen.getByTestId("chats-channel-unread").textContent).toBe("2 unread");

    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    view.rerender(navigator(2));
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
  });

  it("keeps cached relay share rows when a catch-up refresh resolves with the relay unreachable", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
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
    const view = render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2 unread");

    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: { state: "unreachable" as const },
    });
    view.rerender(navigator(1));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  it("says dohc could not read the shares when the relay is unreachable, and offers a retry", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: { state: "unreachable" as const },
    });
    const user = userEvent.setup();
    render(navigator(0));

    const notice = await screen.findByTestId("chats-shares-unreadable");
    expect(notice.textContent).toContain("dohc could not read your shares.");
    // Nothing is cached, so nothing on screen is stale — saying so would be
    // false.
    expect(notice.textContent).not.toContain("out of date");
    expect(screen.getByTestId("chats-shared-with-you")).toBeTruthy();

    const before = bridgeMock.listChatChannelShares.mock.calls.length;
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
    await user.click(screen.getByTestId("chats-shares-unreadable-retry"));
    await waitFor(() => {
      expect(bridgeMock.listChatChannelShares.mock.calls.length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("chats-shares-unreadable")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // A refresh nobody asked for that failed learned nothing, so
  // it takes no data lane — and it must take no reachability lane either.
  // Claiming one let a background failure outrank the answer already in
  // flight: the listing landed, its rows rendered, and "could not read your
  // shares" stayed on top of them until some later refresh happened.
  it("lets an in-flight listing clear the notice a later background failure raised", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    let resolveMount!: (value: ReturnType<typeof shareListing>) => void;
    const mountRead = new Promise<ReturnType<typeof shareListing>>((resolve) => {
      resolveMount = resolve;
    });
    bridgeMock.listChatChannelShares
      .mockReturnValueOnce(mountRead)
      .mockRejectedValue(new Error("offline"));

    const view = render(navigator(0));
    await waitFor(() => expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1));
    // The background refresh: nothing has answered yet, so it fills in.
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("chats-shares-unreadable")).toBeTruthy();

    // Now the read that was always in flight answers, authoritatively.
    resolveMount(
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

    // Its rows land, and the notice goes with them — an older ticket still
    // answers a question the newer failure never learned anything about.
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("chats-shares-unreadable")).toBeNull();
    });
  });

  // Over-limit is non-authoritative for the same reason unreachable is: dohc
  // has no listing it can stand behind, so the cached rows are still the best
  // thing it knows. Without this the new state could quietly become
  // authoritative and clear them — the clobber, through the door this
  // round opened.
  it("keeps cached relay share rows when a refresh resolves over-limit", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
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
    const view = render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: {
        state: "over-limit" as const,
        lanes: [{ lane: "received" as const, rows: 4097 }],
        limit: 4096,
      },
    });
    view.rerender(navigator(1));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
    const notice = screen.getByTestId("chats-shares-unreadable");
    expect(notice.dataset.failure).toBe("over-limit");
    expect(notice.textContent).toContain("This list may be out of date.");
  });

  // The in-flight race the session KEY alone cannot stop: account A's read is
  // still in flight when the user switches to B, B's listing resolves
  // unreachable first (leaving the relay lane unclaimed), and A's answered
  // response lands last. Session keys clear only at commit — the read issued
  // under the old session must be refused outright, or it restores A's rows
  // under B.
  it("refuses an old account's in-flight answer that lands after the session change", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    const invitation = {
      shareId: "share-received",
      channelWireId: "wire-received",
      granterEmail: "owner@example.com",
      access: "read-write",
      ended: false,
    };
    const answerShares: Array<(value: unknown) => void> = [];
    bridgeMock.listChatChannelShares.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerShares.push(resolve);
        }),
    );
    const view = render(navigator(0));
    await waitFor(() => expect(answerShares).toHaveLength(1));
    await act(async () => {
      answerShares[0](shareListing({ sessionKey: "session-a", received: [invitation] }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    view.rerender(navigator(1));
    await waitFor(() => expect(answerShares).toHaveLength(2));

    act(() => emitCloudSessionChanged("session-b"));
    await waitFor(() => expect(answerShares).toHaveLength(3));
    await act(async () => {
      answerShares[2]({
        joined: [],
        sessionKey: "session-b",
        relay: { state: "unreachable" },
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();

    await act(async () => {
      answerShares[1](shareListing({ sessionKey: "session-a", received: [invitation] }));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();
  });

  // The rows must leave the screen at the signal itself: the new session's
  // listing may never resolve (a stalled relay), and waiting on it would
  // keep showing the previous account's invitations and emails indefinitely.
  it("clears the previous account's rows at the session change, before any listing answers", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(
          shareListing({
            sessionKey: "session-a",
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
      }
      return new Promise(() => {});
    });
    render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    act(() => emitCloudSessionChanged("session-b"));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    });
    // The refresh was issued — the clear did not wait on it.
    expect(shareReads).toBe(2);
  });

  // The other moment of the same-key contract: the ready phase is adoption
  // end, and it runs exactly one revalidation against the settled session —
  // invitations and revocations from during the reauth must land without
  // waiting for an unrelated refresh.
  it("revalidates once on the ready phase of a same-session rotation", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(
          shareListing({
            sessionKey: "session-a",
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
      }
      // The relay revoked the invitation during the reauth.
      return Promise.resolve(shareListing({ sessionKey: "session-a" }));
    });
    render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    act(() => emitCloudSessionChanged("session-a", "changing"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(shareReads).toBe(1);
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();

    // Adoption end: exactly one revalidation, and the revocation lands.
    act(() => emitCloudSessionChanged("session-a", "ready"));
    await waitFor(() => expect(shareReads).toBe(2));
    await waitFor(() => {
      expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    });
    expect(shareReads).toBe(2);
  });

  // refreshOverview and refreshShares both write channelShares. Without one
  // order over both, a share lookup issued first can resolve last and put the
  // pre-mutation snapshot back — the person you just invited disappearing.
  it("does not let a slow background lookup undo a share the user just made", async () => {
    const teamChannel = channel({
      id: "channel-team",
      name: "team",
      slug: "team",
      wireId: "wire-team",
    });
    const grant = (recipientEmail: string, shareId: string) => ({
      shareId,
      channelWireId: "wire-team",
      access: "read-write" as const,
      recipientEmail,
      revokedAtMs: null,
    });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel],
      fileThreads: [],
    });
    bridgeMock.shareChatChannel.mockResolvedValue({ shareId: "share-2" });
    // Every share lookup is answered by hand, so the order is the test.
    const answerShares: Array<(value: unknown) => void> = [];
    bridgeMock.listChatChannelShares.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerShares.push(resolve);
        }),
    );
    const user = userEvent.setup();
    const view = render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        readRevision={0}
      />,
    );

    await waitFor(() => expect(answerShares).toHaveLength(1));
    await act(async () => {
      answerShares[0](shareListing({ granted: [grant("ana@example.com", "share-1")] }));
      await Promise.resolve();
    });
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-share-channel"));
    expect((await screen.findByTestId("chats-share-member")).textContent).toContain(
      "ana@example.com",
    );

    // A read lands: the badge refresh issues its share lookup and stalls.
    view.rerender(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        readRevision={1}
      />,
    );
    await waitFor(() => expect(answerShares).toHaveLength(2));

    await user.click(screen.getByTestId("chats-share-add-people"));
    await user.type(screen.getByTestId("chats-share-email"), "bo@example.com");
    await user.click(screen.getByTestId("chats-share-submit"));
    await waitFor(() => expect(answerShares).toHaveLength(3));
    await act(async () => {
      answerShares[2](
        shareListing({
          granted: [grant("ana@example.com", "share-1"), grant("bo@example.com", "share-2")],
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByTestId("chats-share-member")).toHaveLength(2));

    // Now the stalled background lookup answers with its older snapshot.
    await act(async () => {
      answerShares[1](shareListing({ granted: [grant("ana@example.com", "share-1")] }));
      await Promise.resolve();
    });

    const members = screen.getAllByTestId("chats-share-member");
    expect(members).toHaveLength(2);
    expect(members.map((el) => el.textContent).join(" ")).toContain("bo@example.com");
  });
});

describe("ChatsView Group access marks", () => {
  const groups = [
    channel({ id: "channel-hidden", name: "Hidden", wireId: "wire-hidden" }),
    channel({ id: "channel-read", name: "Read", wireId: "wire-read" }),
    channel({ id: "channel-open", name: "Open", wireId: "wire-open" }),
  ];
  function membersList(groupRules: Array<{ channelWireId: string; level: string }> | null) {
    return {
      status: "ready",
      view: {
        memberLevel: "comment",
        people: [
          { role: "owner", state: "active" },
          { role: "member", state: "active" },
        ],
        groupRules,
      },
    };
  }
  const rules = [
    { channelWireId: "wire-hidden", level: "none" },
    { channelWireId: "wire-read", level: "view" },
    { channelWireId: "wire-open", level: "comment" },
  ];
  const marks = () =>
    Object.fromEntries(
      screen.getAllByTestId("chats-channel").map((row) => {
        const mark = row.querySelector("[data-testid='chats-group-access-mark']");
        return [
          row.querySelector("[data-testid='chats-channel-name']")?.textContent,
          mark ? `${mark.getAttribute("data-level")}: ${mark.getAttribute("title")}` : null,
        ];
      }),
    );

  it.each([
    ["the owner", {}],
    ["an admin", { joinedWorkspace: { createsGroups: true } }],
  ] as const)("shows %s which Groups a rule hides or makes read-only", async (_who, extra) => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    bridgeMock.workspaceMembers.mockResolvedValue(membersList(rules));
    renderView(vi.fn(), vi.fn(), extra);
    await waitFor(() =>
      expect(marks()).toEqual({
        Hidden: "none: Hidden from members",
        Read: "view: Members can read only",
        Open: null,
      }),
    );
    expect(screen.getByRole("button", { name: /Hidden.*Hidden from members/ })).toBeTruthy();
  });

  it("shows a member no marks and reads no rules", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    bridgeMock.workspaceMembers.mockResolvedValue(membersList(rules));
    renderView(vi.fn(), vi.fn(), { joinedWorkspace: { createsGroups: false } });
    await screen.findAllByTestId("chats-channel");
    await act(async () => {});
    expect(screen.queryByTestId("chats-group-access-mark")).toBeNull();
    expect(bridgeMock.workspaceMembers).not.toHaveBeenCalled();
  });

  it("shows no mark while the rules are unknown", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    const read = deferred<unknown>();
    bridgeMock.workspaceMembers.mockReturnValueOnce(read.promise);
    renderView();
    await screen.findAllByTestId("chats-channel");
    await act(async () => {});
    expect(screen.queryByTestId("chats-group-access-mark")).toBeNull();
    await act(async () => read.resolve(membersList(null)));
    expect(screen.queryByTestId("chats-group-access-mark")).toBeNull();
  });

  it("marks a Group again once Group settings saves its rule", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    let saved = rules.filter((rule) => rule.channelWireId !== "wire-open");
    bridgeMock.workspaceMembers.mockImplementation(
      async (input: { request: { action: string; group?: string; level?: string } }) => {
        if (input.request.action === "group") {
          saved = [...saved, { channelWireId: input.request.group!, level: input.request.level! }];
          return { status: "ready" };
        }
        return membersList(saved);
      },
    );
    renderView(vi.fn(), vi.fn(), { joinedWorkspace: { createsGroups: true } });
    await waitFor(() => expect(marks().Read).toBe("view: Members can read only"));
    expect(marks().Open).toBeNull();
    const open = screen.getAllByTestId("chats-channel").find((row) => row.textContent === "Open");
    fireEvent.click(open!);
    fireEvent.click(await screen.findByTestId("chats-group-settings"));
    fireEvent.click(await screen.findByRole("radio", { name: "No access" }));
    fireEvent.click(screen.getByTestId("chats-group-settings-save"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("chats-channel-view")
          .querySelector("[data-testid='chats-group-access-mark']")
          ?.getAttribute("data-level"),
      ).toBe("none"),
    );
  });

  it("opens Group settings from a Group's menu, and saves while the owner is alone", async () => {
    const user = userEvent.setup();
    const onShowFolder = vi.fn();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        ...groups,
        channel({ id: "channel-team", name: "Team", wireId: "wire-team", folderPath: "Team" }),
      ],
      fileThreads: [],
    });
    bridgeMock.workspaceMembers.mockImplementation(async (input: { request: { action: string } }) =>
      input.request.action === "group"
        ? { status: "ready" }
        : {
            status: "ready",
            view: {
              memberLevel: "comment",
              people: [{ role: "owner", state: "active" }],
              groupRules: [],
              inviteLink: null,
            },
          },
    );
    renderView(vi.fn(), vi.fn(), { onShowFolder });
    const row = (name: string) =>
      screen.getAllByTestId("chats-channel").find((entry) => entry.textContent === name)!;
    await screen.findAllByTestId("chats-channel");
    fireEvent.contextMenu(row("Team"), { clientX: 40, clientY: 60 });
    await user.click(await screen.findByTestId("chat-row-menu-show-folder"));
    expect(onShowFolder).toHaveBeenCalledExactlyOnceWith("Team");
    fireEvent.contextMenu(row("Open"), { clientX: 40, clientY: 60 });
    expect(screen.queryByTestId("chat-row-menu-show-folder")).toBeNull();
    await user.click(screen.getByTestId("chat-row-menu-group-settings"));
    const dialog = await screen.findByTestId("chats-group-settings-dialog");
    expect(dialog.textContent).toContain("Open");
    expect(dialog.textContent).toContain("Only you are in this workspace.");
    await user.click(await screen.findByRole("radio", { name: "View only" }));
    await user.click(screen.getByTestId("chats-group-settings-save"));
    await waitFor(() =>
      expect(bridgeMock.workspaceMembers).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        request: { action: "group", group: "wire-open", level: "view" },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("chats-group-settings-dialog")).toBeNull());
  });

  it("offers Show folder on a new Group only once the share lookup says it's this computer's", async () => {
    const team = channel({
      id: "channel-team",
      name: "Team",
      wireId: "wire-team",
      folderPath: "Team",
    });
    let withTeam = false;
    bridgeMock.listChatChannels.mockImplementation(() =>
      Promise.resolve({ channels: withTeam ? [channel(), team] : [channel()], fileThreads: [] }),
    );
    renderView(vi.fn(), vi.fn(), { onShowFolder: vi.fn() });
    await screen.findByTestId("chats-channel");

    const joinedRead = deferred<{ joined: unknown[] }>();
    bridgeMock.listJoinedSharedChannels.mockReturnValue(joinedRead.promise);
    withTeam = true;
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(screen.getAllByTestId("chats-channel")).toHaveLength(2));
    const openTeamMenu = async () => {
      const row = screen
        .getAllByTestId("chats-channel")
        .find((entry) => entry.textContent?.startsWith("Team"))!;
      fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
      await screen.findByTestId("chat-row-menu-archive");
    };
    await openTeamMenu();
    expect(screen.queryByTestId("chat-row-menu-show-folder")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("chat-row-menu-archive")).toBeNull());

    await act(async () => {
      joinedRead.resolve({
        joined: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: false,
          },
        ],
      });
      await Promise.resolve();
    });
    await screen.findByTestId("chats-channel-shared");
    await openTeamMenu();
    expect(screen.queryByTestId("chat-row-menu-show-folder")).toBeNull();
  });

  it("offers only Close in Group settings when the workspace never synced", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    bridgeMock.workspaceMembers.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:workspace-members': Error [workspace-not-synced]: Sync this workspace before sharing.",
      ),
    );
    renderView(vi.fn(), vi.fn());
    const row = (await screen.findAllByTestId("chats-channel")).find(
      (entry) => entry.textContent === "Open",
    )!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    await user.click(await screen.findByTestId("chat-row-menu-group-settings"));
    const dialog = await screen.findByTestId("chats-group-settings-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Only you are in this workspace."));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByTestId("chats-group-settings-save")).toBeNull();
    expect(dialog.textContent).not.toContain("Try again");
  });

  // The page tells the shell, and the shell tells the navigator.
  it("reads the rules again when another Chats changes one", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    bridgeMock.workspaceMembers.mockResolvedValueOnce(membersList([]));
    bridgeMock.workspaceMembers.mockResolvedValueOnce(membersList(rules));
    const { rerender } = renderView(vi.fn(), vi.fn(), { groupAccessRevision: 0 });
    await screen.findAllByTestId("chats-channel");
    await waitFor(() => expect(bridgeMock.workspaceMembers).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("chats-group-access-mark")).toBeNull();
    rerender({ groupAccessRevision: 1 });
    await waitFor(() => expect(marks().Hidden).toBe("none: Hidden from members"));
  });

  // The owner or another admin can change a rule on another computer, and nothing tells this one.
  it("reads the rules again when the window comes back into focus", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: groups, fileThreads: [] });
    bridgeMock.workspaceMembers.mockResolvedValueOnce(membersList([]));
    bridgeMock.workspaceMembers.mockResolvedValueOnce(membersList(rules));
    renderView(vi.fn(), vi.fn());
    await screen.findAllByTestId("chats-channel");
    await waitFor(() => expect(bridgeMock.workspaceMembers).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("chats-group-access-mark")).toBeNull();
    fireEvent.focus(window);
    await waitFor(() => expect(marks().Hidden).toBe("none: Hidden from members"));
  });
});
