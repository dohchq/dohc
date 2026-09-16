// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import {
  ChatsView,
  channel,
  bridgeMock,
  shareListing,
  emitCloudSessionChanged,
  renderView,
  navigatorView,
} from "./ChatsView.testHarness";

describe("ChatsView channels", () => {
  it("lists channels with unread badges and thread counts", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({ id: "channel-2", name: "product", slug: "product", threadCount: 3, unreadCount: 2 }),
      ],
      fileThreads: [],
    });
    renderView();

    const names = await screen.findAllByTestId("chats-channel-name");
    expect(names.map((el) => el.textContent)).toEqual(["general", "product"]);
    // Only the channel with unread messages shows a badge.
    const badges = screen.getAllByTestId("chats-channel-unread");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("2");
    const rows = screen.getAllByTestId("chats-channel");
    expect(rows.map((row) => row.dataset.threadCount)).toEqual(["0", "3"]);
  });

  it("creates a channel inline and opens it", async () => {
    const user = userEvent.setup();
    // Production shape: main mints the new channel's wire id from its own
    // local id, so this is never null.
    bridgeMock.createChatChannel.mockResolvedValue({
      channel: channel({
        id: "channel-9",
        name: "launch",
        slug: "launch",
        wireId: "channel-9",
      }),
    });
    renderView();

    await user.click(await screen.findByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");

    await waitFor(() =>
      expect(bridgeMock.createChatChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        name: "launch",
        type: "posts",
      }),
    );
    // Straight into the new channel — no extra click.
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );
  });

  // A channel on screen with no answer in the joined lane is a locked
  // channel, and the create put one on screen. main mints the wire id from the
  // channel's own local id, so no grant can exist for it and the answer is
  // known without asking — which it has to be, because the user is already
  // inside the channel by the time any read could reply.
  it("leaves a freshly created channel writable without another share read", async () => {
    const user = userEvent.setup();
    bridgeMock.createChatChannel.mockResolvedValue({
      channel: channel({
        id: "channel-9",
        name: "launch",
        slug: "launch",
        wireId: "channel-9",
      }),
    });
    renderView();
    await screen.findByTestId("chats-channel");
    const sharesReadsBefore = bridgeMock.listChatChannelShares.mock.calls.length;
    const joinedReadsBefore = bridgeMock.listJoinedSharedChannels.mock.calls.length;

    await user.click(screen.getByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );

    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
    // And it did not take a second read to get there.
    expect(bridgeMock.listChatChannelShares.mock.calls.length).toBe(sharesReadsBefore);
    expect(bridgeMock.listJoinedSharedChannels.mock.calls.length).toBe(joinedReadsBefore);
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

  it("refetches the counts once the shell reports a landed read", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The editor read the thread: the durable count is zero now.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    view.rerender(navigator(1));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
  });

  it("refetches a channel count once the shell reports a started thread", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ threadCount: 0 })],
      fileThreads: [],
    });
    const view = render(navigator(0, 0));
    expect((await screen.findByTestId("chats-channel")).dataset.threadCount).toBe("0");

    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ threadCount: 1 })],
      fileThreads: [],
    });
    view.rerender(navigator(0, 1));

    await waitFor(() => {
      expect(screen.getByTestId("chats-channel").dataset.threadCount).toBe("1");
    });
  });

  // Clearing a badge must never cost the user the navigator itself.
  it("keeps a working navigator when the badge refresh fails, and retries on the next read", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The refresh the read triggers fails.
    bridgeMock.listChatChannels.mockRejectedValue(new Error("offline"));
    view.rerender(navigator(1));
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));

    // The channel list is still there — a stale badge beats an error card.
    expect(screen.getByTestId("chats-channel-name").textContent).toBe("general");
    expect(screen.getByTestId("chats-channel-unread").textContent).toBe("2");

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

  // liveToken means "everything in flight is now stale", and the mutations
  // capture it to decide whether their own completion still counts. A badge
  // refresh is not that: it must not throw away a channel the user just made.
  it("does not discard a channel creation that a badge refresh lands on top of", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    let finishCreate!: (result: { channel: ChatChannelRecord }) => void;
    bridgeMock.createChatChannel.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    const user = userEvent.setup();
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-unread");

    // Start creating a channel and leave the IPC in flight.
    await user.click(screen.getByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");
    await waitFor(() => expect(bridgeMock.createChatChannel).toHaveBeenCalled());

    // A read lands, so the navigator refreshes its badges underneath.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    view.rerender(navigator(1));
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });

    // The creation now answers. Its result must still count.
    await act(async () => {
      finishCreate({
        channel: channel({ id: "channel-9", name: "launch", slug: "launch" }),
      });
      await Promise.resolve();
    });
    // Straight into the new channel, and the create form is gone — neither
    // happens if the refresh invalidated the creation.
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );
    expect(screen.queryByTestId("chats-new-channel-name")).toBeNull();
  });

  // The share lookup is optional, so a failure returns "unknown" — which is
  // not the same as "there are none". A badge refresh must not spend a
  // teammate's pending invitation on a transient signed-out blip.
  it("keeps cached share metadata when the badge refresh cannot reach it", async () => {
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
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The read lands. Channels answer; the optional share lookup does not.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    view.rerender(navigator(1));

    // The badge catches up, and the invitation is still on offer.
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // A relay outage resolves the listing with `relay.state ===
  // "unreachable"` — it does not reject. That resolution must not read as
  // "there are no shares": the cached relay-backed rows stand until the relay
  // answers.
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
    expect((await screen.findByTestId("chats-channel-unread")).textContent).toBe("2");

    // The read lands; the relay is down, so the listing resolves unreachable.
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

    // The badge catches up, and the invitation is still on offer.
    await waitFor(() => {
      expect(screen.queryByTestId("chats-channel-unread")).toBeNull();
    });
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // The counterpart that keeps the distinction honest: when the relay answers
  // with no rows, that is the truth, and the cached rows go.
  it("clears cached relay share rows when the relay answers an authoritative empty listing", async () => {
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

    // The read lands; the relay answers: nobody shares anything with you now.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing());
    view.rerender(navigator(1));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    });
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
    // The mount's read never settles until this test says so; the background
    // refresh behind it fails first and therefore holds the newer ticket.
    let resolveMount!: (value: ReturnType<typeof shareListing>) => void;
    const mountRead = new Promise<ReturnType<typeof shareListing>>((resolve) => {
      resolveMount = resolve;
    });
    bridgeMock.listChatChannelShares
      .mockReturnValueOnce(mountRead)
      .mockRejectedValue(new Error("offline"));

    const view = render(navigator(0));
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1),
    );
    // The background refresh: nothing has answered yet, so it fills in.
    view.rerender(navigator(1));
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2),
    );
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

  // An over-limit listing is not an outage: the same request
  // answers the same way forever. Reporting it as unreachable gave the
  // surface a Try again that could never work and no way to say what was
  // wrong — the defect #618 exists to fix, for the one condition dohc's own
  // cap creates.
  it("names the count and the limit for an over-limit listing, and offers no retry", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: {
        state: "over-limit" as const,
        lanes: [
          { lane: "granted" as const, rows: 4097 },
          { lane: "received" as const, rows: 5000 },
        ],
        limit: 4096,
      },
    });
    render(navigator(0));

    const notice = await screen.findByTestId("chats-shares-unreadable");
    expect(notice.dataset.failure).toBe("over-limit");
    // The constraint, what it observed, and the configured limit — in the
    // nouns the surface already uses, not the lane names main uses.
    expect(notice.textContent).toContain("dohc cannot list this many shares.");
    expect(notice.textContent).toContain(
      "You have 4097 shares of your channels; the limit is 4096.",
    );
    expect(notice.textContent).toContain(
      "You have 5000 shares from other people; the limit is 4096.",
    );
    // The unit is shares, not channels: a relay lane holds one row per grant,
    // so one channel shared with 4097 people is 4097 rows.
    expect(notice.textContent).not.toMatch(/d+ channels/);
    // A retry repeats the identical request, so there is no button to press.
    expect(screen.queryByTestId("chats-shares-unreadable-retry")).toBeNull();
    // And it never poses as the outage it is not.
    expect(notice.textContent).not.toContain("could not read");
  });

  // The failure is account-scoped, and unlike a stale row
  // it is a PERSISTENT claim: an over-limit answer names the previous
  // account's share counts. Leaving it up shows account A's numbers under
  // account B for as long as B's listing takes — or for good, if it stalls.
  it("drops an over-limit failure when the account changes, even while the next listing stalls", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: {
        state: "over-limit" as const,
        lanes: [{ lane: "granted" as const, rows: 4097 }],
        limit: 4096,
      },
    });
    render(navigator(0));
    expect(
      (await screen.findByTestId("chats-shares-unreadable")).textContent,
    ).toContain("You have 4097 shares of your channels");

    // The user switches accounts, and the new account's listing never
    // arrives — the window in which a retained failure lies loudest.
    bridgeMock.listChatChannelShares.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      emitCloudSessionChanged("session-b");
    });

    // Account A's counts leave with account A's rows.
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
    // The invitation dohc already knew about is still on offer...
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
    // ...and it is marked as possibly older than this answer.
    const notice = screen.getByTestId("chats-shares-unreadable");
    expect(notice.dataset.failure).toBe("over-limit");
    expect(notice.textContent).toContain("This list may be out of date.");
  });

  // The sibling test above covers a background read that
  // REJECTED. This one resolves structurally with `unreachable` — the same
  // "learned nothing" fact wearing a different shape — and it must be treated
  // the same. Keying the carve-out on `value === null` covered one of three.
  it("lets an in-flight listing clear a notice a resolved background outage raised", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    let resolveMount!: (value: ReturnType<typeof shareListing>) => void;
    const mountRead = new Promise<ReturnType<typeof shareListing>>((resolve) => {
      resolveMount = resolve;
    });
    bridgeMock.listChatChannelShares.mockReturnValueOnce(mountRead).mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: { state: "unreachable" as const },
    });

    const view = render(navigator(0));
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1),
    );
    view.rerender(navigator(1));
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByTestId("chats-shares-unreadable")).toBeTruthy();

    // The read that was always in flight answers, authoritatively, on an
    // older ticket.
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

    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("chats-shares-unreadable")).toBeNull();
    });
  });

  // The cached rows stay, and now they are labelled: they are
  // real, they are just older than this failure.
  it("marks cached invitations as possibly out of date while the relay is unreachable", async () => {
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
    expect(screen.queryByTestId("chats-shares-unreadable")).toBeNull();

    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: { state: "unreachable" as const },
    });
    view.rerender(navigator(1));

    const notice = await screen.findByTestId("chats-shares-unreadable");
    expect(notice.textContent).toContain("dohc could not read your shares.");
    expect(notice.textContent).toContain("This list may be out of date.");
    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
  });

  // Signed-out is not an outage either: dohc read the answer, and the answer
  // is that this machine has no account-scoped rows. Claiming it could not
  // read them would send the user to retry something that already worked.
  it("says nothing about reachability when the listing resolves signed-out", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: null,
      relay: { state: "signed-out" as const },
    });
    render(navigator(0));
    await waitFor(() => expect(bridgeMock.listChatChannelShares).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByTestId("chats-shares-unreadable")).toBeNull();
    });
    expect(screen.queryByTestId("chats-shared-with-you")).toBeNull();
  });

  // Signed-out is the third fact, and it is not an outage: the cached relay
  // rows are account-scoped, so another account's invitations and recipient
  // emails must not survive a logout or account switch.
  it("clears cached relay share rows when the listing resolves signed-out", async () => {
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

    // The user signed out (or switched accounts). The next catch-up refresh
    // resolves signed-out — the rows belong to nobody on this machine now.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 0 })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: null,
      relay: { state: "signed-out" as const },
    });
    view.rerender(navigator(1));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    });
  });

  // The trigger half of the signed-out pin: logout emits only a session
  // signal — no rerender, no catch-up refresh, and the activity ping's badge
  // path never asks the relay. The mounted view itself must re-read the
  // listing and drop the previous account's rows.
  it("clears cached relay share rows when a session change arrives, without any refresh", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
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
    render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    // The user logs out: every later listing resolves signed-out, and main
    // pushes the session signal.
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: null,
      relay: { state: "signed-out" as const },
    });
    act(() => emitCloudSessionChanged(null));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    });
  });

  // The relay rows are keyed by the SESSION they were read under, so the
  // keep-cached-through-an-outage rule can only ever keep the same account's
  // rows. The sharpest case: switch accounts, and the new account's first
  // listing cannot reach the relay — the previous account's invitations and
  // emails must be gone, not preserved.
  it("clears another account's cached relay rows when the new session cannot reach the relay", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
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
    render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    // Another account signs in, and its first listing finds the relay down.
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-b",
      relay: { state: "unreachable" as const },
    });
    act(() => emitCloudSessionChanged("session-b"));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    });
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

  // The signal carries the new session's key so a token rotation within the
  // same session invalidates nothing — and asks for nothing. Mid-transition
  // the credential cache is deliberately empty, so a listing issued off the
  // same-key event would answer an authoritative signed-out and clear the
  // very rows the same-key rule preserved; a stalled cleanup would hide
  // them indefinitely.
  it("keeps the rows through a same-session rotation while cleanup stalls", async () => {
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
      // Mid-transition truth: the credential cache is cleared, so any
      // listing issued now answers an authoritative signed-out.
      return Promise.resolve({
        joined: [],
        sessionKey: null,
        relay: { state: "signed-out" as const },
      });
    });
    render(navigator(0));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();

    // The token rotates: same server, relay, and user — same key.
    act(() => emitCloudSessionChanged("session-a"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("chats-join-shared")).toBeTruthy();
    // The same-key event asked for nothing: asking mid-transition is the
    // defect — the transitional answer would have been signed-out.
    expect(shareReads).toBe(1);
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

  // The session refresh commits under the session generation, not the
  // conversation-navigation token: opening a channel while the new session's
  // listing is in flight must not discard its answer — nothing would re-list
  // until some unrelated refresh.
  it("lands the session refresh's answer when the user navigates during it", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const answers: Array<(value: unknown) => void> = [];
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(shareListing({ sessionKey: "session-a" }));
      }
      return new Promise((resolve) => {
        answers.push(resolve);
      });
    });
    render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        readRevision={0}
      />,
    );
    await waitFor(() => expect(shareReads).toBe(1));

    // Switch sessions; the new session's listing stays in flight.
    act(() => emitCloudSessionChanged("session-b"));
    await waitFor(() => expect(shareReads).toBe(2));

    // The user opens a channel meanwhile — a navigation, not a session or
    // workspace change.
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");

    // The listing answers with the new session's invitation. It must commit.
    await act(async () => {
      answers[0]!(
        shareListing({
          sessionKey: "session-b",
          received: [
            {
              shareId: "share-b",
              channelWireId: "wire-b",
              granterEmail: "peer@example.com",
              access: "read-write",
              ended: false,
            },
          ],
        }),
      );
      await Promise.resolve();
    });

    // Back on the overview, the invitation is there — no unrelated refresh
    // needed. goBack's own overview refresh stays in flight (reads 3+ stall),
    // so what shows can only be the session refresh's commit.
    await userEvent.click(screen.getByTestId("chats-channel-back"));
    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
  });

  // Two lookups can settle in one React batch, both reading a null listing
  // ref. The newer unreachable answer claims only the joined lane; the older
  // answered one must still land its authoritative relay rows — an
  // all-or-nothing claim on the stale joined ticket would silently discard
  // them, leaving invitations empty until some later refresh.
  it("keeps an answered listing's relay rows when an unreachable one commits first in the same batch", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel()],
      fileThreads: [],
    });
    const answerShares: Array<(value: unknown) => void> = [];
    bridgeMock.listChatChannelShares.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerShares.push(resolve);
        }),
    );
    const view = render(navigator(0));
    await waitFor(() => expect(answerShares).toHaveLength(1));

    // A read lands: the catch-up issues a second, newer lookup.
    view.rerender(navigator(1));
    await waitFor(() => expect(answerShares).toHaveLength(2));

    // Both settle in one batch: the newer one unreachable first, then the
    // older one with the relay's real rows.
    await act(async () => {
      answerShares[1]({
        joined: [],
        sessionKey: "session-a",
        relay: { state: "unreachable" },
      });
      answerShares[0](
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
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-join-shared")).toBeTruthy();
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

  it("does not refetch while the revision stands still", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ unreadCount: 2 })],
      fileThreads: [],
    });
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-unread");
    expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(1);

    view.rerender(navigator(0));
    await waitFor(() => {
      expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(1);
    });
  });
});
