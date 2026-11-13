// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  renderView,
  navigatorView,
} from "./ChatsView.testHarness";
import { deferred } from "../../testing/deferred";

describe("ChatsView channels", () => {
  it("keeps reaction writes ordered when switching away from and remounting a chat lane", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel({ type: "both" })], fileThreads: [] });
    bridgeMock.listChannelThreads.mockImplementation(async (input) => ({ threads: input.lane === "chat" ? [thread()] : [] }));
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
      .mockResolvedValueOnce({ channel: channel({ id: "channel-9", name: "launch", slug: "launch", wireId: "channel-9" }) });
    renderView(vi.fn(), onError);

    await user.click(await screen.findByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch");
    await user.click(screen.getByTestId("chats-new-channel-submit"));
    await screen.findByTestId("chats-new-channel-error");
    await user.click(screen.getByTestId("chats-new-channel-cancel"));

    const retry = onError.mock.calls[0]?.[2] as () => void;
    act(() => retry());
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("launch");
    expect(bridgeMock.createChatChannel).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", name: "launch", type: "chat" });
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

    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel(), existing], fileThreads: [] });
    act(() => onError.mock.calls[0]?.[2]?.());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenLastCalledWith(
      "A group with that name already exists.",
      taken,
      undefined,
      undefined,
      {
        title: "dohc couldn't create #Launch_team",
        identity: "group-name-taken:launch-team",
        action: expect.objectContaining({ label: "Open", run: expect.any(Function), ends: true }),
      },
    );
    act(() => onError.mock.calls[1]?.[4]?.action?.run());
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe("Launch team");
    expect(bridgeMock.listChannelThreads).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", channelId: existing.id });
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
});

// Journey 3: the navigator kept an unread badge more than 30s after
// the thread was read. It hands every conversation to the editor, so it never
// reaches its own mark-read and had no reason to refetch the counts it loaded
// at mount. The shell reports each landed read through readRevision.
describe("ChatsView panel navigator unread badges", () => {
  function navigator(readRevision: number, threadRevision = 0) {
    return navigatorView(readRevision, { onOpenInTab: vi.fn(), threadRevision });
  }

  // Clearing a badge must never cost the user the navigator itself.
  it("keeps a working navigator when the badge refresh fails, and retries on the next read", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2 unread");

    // The refresh the read triggers fails.
    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    // The channel list is still there — a stale badge beats an error card.
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
    expect(screen.getByTestId("chats-channel-unread").textContent).toBe("2 unread");

    // The signal was not spent on that failure: the next read still refetches
    // and the badge catches up.
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

  // Keeping the cached rows is only half of honest. An unreachable
  // listing with nothing cached committed no rows and said nothing, so the
  // section that lists invitations disappeared and the surface read as "you
  // have no shares".
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
    // The section itself must survive: hiding it was the defect.
    expect(screen.getByTestId("chats-shared-with-you")).toBeTruthy();

    // The Next has to work on this surface: the retry asks again.
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
    // A reached relay takes the notice down and lists the invitation.
    await waitFor(() => {
      expect(screen.queryByTestId("chats-shares-unreadable")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
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
    // The invitation dohc already knew about is still on offer...
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
    // ...and it is marked as possibly older than this answer.
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

    // A read lands: account A's catch-up lookup is issued and stalls.
    view.rerender(navigator(1));
    await waitFor(() => expect(answerShares).toHaveLength(2));

    // Switch to account B. Its listing cannot reach the relay and resolves
    // first — the relay lane stays unclaimed.
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

    // Account A's stalled read answers last, with A's rows. It was issued
    // under the old session: it must commit nothing.
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
      // The new session's relay stalls forever.
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

    // Transition start: preserve, ask for nothing.
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

    // Mount: one person has the channel.
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

    // Meanwhile the user shares the channel with someone else, and that
    // lookup answers first.
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
    await waitFor(() =>
      expect(screen.getAllByTestId("chats-share-member")).toHaveLength(2),
    );

    // Now the stalled background lookup answers with its older snapshot.
    await act(async () => {
      answerShares[1](shareListing({ granted: [grant("ana@example.com", "share-1")] }));
      await Promise.resolve();
    });

    // Bo is still there.
    const members = screen.getAllByTestId("chats-share-member");
    expect(members).toHaveLength(2);
    expect(members.map((el) => el.textContent).join(" ")).toContain("bo@example.com");
  });
});
