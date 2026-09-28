// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import {
  ChatsView,
  channel,
  thread,
  message,
  bridgeMock,
  shareListing,
  emitWorkspaceActivity,
  emitCloudSessionChanged,
  renderView,
  navigatorView,
} from "./ChatsView.testHarness";

// --- Shared channels (MU-C4) -----------------------------------------------

describe("ChatsView shared channels (MU-C4)", () => {
  const teamChannel = () =>
    channel({ id: "channel-team", name: "team", slug: "team", wireId: "wire-team" });

  it("fails closed when sharing metadata is unavailable", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    renderView();
    await screen.findByTestId("chats-channel-name");
    // Failing closed is about authority, not silence. A listing that did not
    // answer at all locks every affordance below, and it says so — an
    // unexplained blank surface with every channel read-only was #618.
    expect((await screen.findByTestId("chats-shares-unreadable")).textContent).toContain(
      "dohc could not read your shares.",
    );
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    expect(screen.queryByTestId("chats-channel-shared")).toBeNull();
    // Entering the channel offers no share button either.
    await userEvent.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
  });

  // The joined lane is answered for what a caller is showing, so the
  // caller has to say what that is. It is the channel list plus the
  // invitations under "Shared with you" — the sharing surface decides for each
  // invitation whether this workspace already joined that channel.
  it("asks the joined lane only about the channels and invitations it is showing", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        received: [
          {
            shareId: "share-invite",
            channelWireId: "wire-invite",
            access: "read-write",
            granterEmail: "owner@example.com",
          },
        ],
      }),
    );
    bridgeMock.listJoinedSharedChannels.mockResolvedValue({ joined: [] });
    renderView();
    await screen.findByTestId("chats-join-shared");

    // The first read cannot name an invitation it has not been told about
    // yet, so it names the channels it shows and main adds the invitations to
    // the answer.
    expect(bridgeMock.listChatChannelShares.mock.calls[0]![0].channelWireIds).toEqual([
      "wire-team",
    ]);

    // The badge read speaks for no relay lane, so it has to keep covering the
    // invitations already on screen; a narrower scope would drop their answers
    // and offer Join for a channel this workspace is already in.
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listJoinedSharedChannels).toHaveBeenCalled());
    const badgeCall = bridgeMock.listJoinedSharedChannels.mock.calls.at(-1)![0];
    expect([...badgeCall.channelWireIds].sort()).toEqual(["wire-invite", "wire-team"]);
  });

  // A channel the joined lane did not answer for is unknown, not "no grant".
  // Unknown fails closed exactly as an unresolved listing does — otherwise a
  // channel that appeared since the last read would be writable on the word of
  // an answer that never covered it.
  it("locks a channel the joined lane did not answer for", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    // An answer that covers a different channel entirely.
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({ answerOnly: ["wire-other"] }),
    );
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
  });

  it("keeps an owned local channel writable after authoritative empty share metadata", async () => {
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing());
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // A session change on mount fires refreshShares while the overview is still
  // loading, so that reader cannot say what this surface shows. Asking anyway
  // claimed the lane with an answer covering NO channel, and the overview's
  // own fully-scoped answer was then refused for being older — every channel
  // the user owns read unanswered, which locks it. An empty lane used to mean
  // "no grants", and a local channel stayed writable.
  it("keeps a local channel writable when a session change lands before the channel list", async () => {
    let releaseChannels!: (value: {
      channels: ChatChannelRecord[];
      fileThreads: never[];
    }) => void;
    bridgeMock.listChatChannels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseChannels = resolve;
        }),
    );
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing());
    renderView();
    // The relay rejected the session while the first channel list is in flight.
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalled());
    act(() => emitCloudSessionChanged("session-b"));

    await act(async () => {
      releaseChannels({ channels: [channel()], fileThreads: [] });
      await Promise.resolve();
    });

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // refreshShares is deliberately not liveToken-guarded, so a share read
  // issued before a channel was created lands after it. It never named that
  // channel, so it must not drop its answer — replacing the whole lane made
  // the composer vanish under the user.
  it("keeps a created channel answered when an older share read lands after it", async () => {
    const user = userEvent.setup();
    let answerOldShareRead!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) return Promise.resolve(shareListing());
      // The second read is the one refreshShares issued before the create.
      return new Promise((resolve) => {
        answerOldShareRead = resolve;
      });
    });
    bridgeMock.createChatChannel.mockResolvedValue({
      channel: channel({ id: "channel-9", name: "launch", slug: "launch" }),
    });
    renderView();
    await screen.findByTestId("chats-channel");

    // Something share-shaped happens (a session revalidation), so a full read
    // goes out naming only the channels that exist right now.
    act(() => emitCloudSessionChanged("session-b"));
    await waitFor(() => expect(shareReads).toBe(2));

    // The user creates a channel and lands in it while that read is in flight.
    await user.click(screen.getByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();

    // The older read lands. It never named channel-9, so it says nothing
    // about it — and the composer stays.
    await act(async () => {
      answerOldShareRead(shareListing({ sessionKey: "session-b" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // The joined lane orders per WIRE, and this is why. refreshOverview reads
  // the channel list first, so it alone names a channel a sync just imported —
  // but its share read is still in flight, and a refreshShares issued from the
  // overview still on screen omits that channel and takes a newer ticket. One
  // watermark for the whole lane then barred the overview's response outright,
  // and the imported channel rendered with nothing answering for it: locked,
  // until some later refresh. A newer claim outranks only what it answered.
  it("answers a newly imported channel from the older read that alone named it", async () => {
    let channelReads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      channelReads += 1;
      return Promise.resolve({
        channels:
          channelReads === 1
            ? [teamChannel()]
            : [
                teamChannel(),
                channel({
                  id: "channel-imported",
                  name: "imported",
                  slug: "imported",
                  wireId: "wire-imported",
                }),
              ],
        fileThreads: [],
      });
    });
    let answerOverviewRead!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 2) {
        // The overview's read: it named both channels, and it stalls.
        return new Promise((resolve) => {
          answerOverviewRead = resolve;
        });
      }
      return Promise.resolve(shareListing());
    });
    const navigator = navigatorView;
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-name");

    // The shell reports a landed read; the background overview refresh lists
    // the imported channel and asks about both.
    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));
    expect(
      [...bridgeMock.listChatChannelShares.mock.calls[1]![0].channelWireIds].sort(),
    ).toEqual(["wire-imported", "wire-team"]);

    // A session revalidation refreshes the shares from what is on screen,
    // which is still the channel list without the import.
    act(() => emitCloudSessionChanged("session-a", "ready"));
    await waitFor(() => expect(shareReads).toBe(3));
    expect(bridgeMock.listChatChannelShares.mock.calls[2]![0].channelWireIds).toEqual([
      "wire-team",
    ]);

    // The overview's older response lands. It is outranked for wire-team, and
    // for wire-imported it is the only answer there has ever been.
    await act(async () => {
      answerOverviewRead(shareListing());
      await Promise.resolve();
    });

    const names = await screen.findAllByTestId("chats-channel-name");
    expect(names.map((element) => element.textContent)).toEqual(["team", "imported"]);
    await userEvent.click(screen.getAllByTestId("chats-channel")[1]!);
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-channel-title").textContent).toBe("imported");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  const importedChannel = () =>
    channel({
      id: "channel-imported",
      name: "imported",
      slug: "imported",
      wireId: "wire-imported",
    });

  // Eviction is view-driven, and a read's own scope is not the view. The
  // overview finds the imported channel and answers for it; a share read
  // issued from the render before that names only the old channel, and it
  // carries the newer ticket. Evicting to that scope took the answer away
  // from a channel that was already on screen — which locks it. Driven by
  // the substitution reviewer; adopted as the pin.
  it("keeps the imported channel answered when the stale newer read lands last", async () => {
    let channelReads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      channelReads += 1;
      return Promise.resolve({
        channels:
          channelReads === 1
            ? [teamChannel()]
            : [
                teamChannel(),
                channel({
                  id: "channel-imported",
                  name: "imported",
                  slug: "imported",
                  wireId: "wire-imported",
                }),
              ],
        fileThreads: [],
      });
    });
    let answerOverviewRead!: (value: ReturnType<typeof shareListing>) => void;
    let answerSessionRead!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 2) {
        return new Promise((resolve) => {
          answerOverviewRead = resolve;
        });
      }
      if (shareReads === 3) {
        return new Promise((resolve) => {
          answerSessionRead = resolve;
        });
      }
      return Promise.resolve(shareListing());
    });
    const navigator = navigatorView;
    const view = render(navigator(0));
    await screen.findByTestId("chats-channel-name");

    view.rerender(navigator(1));
    await waitFor(() => expect(shareReads).toBe(2));
    expect(
      [...bridgeMock.listChatChannelShares.mock.calls[1]![0].channelWireIds].sort(),
    ).toEqual(["wire-imported", "wire-team"]);

    act(() => emitCloudSessionChanged("session-a", "ready"));
    await waitFor(() => expect(shareReads).toBe(3));
    expect(bridgeMock.listChatChannelShares.mock.calls[2]![0].channelWireIds).toEqual([
      "wire-team",
    ]);

    // The overview's older response lands first: it alone names wire-imported,
    // and it puts the channel on screen.
    await act(async () => {
      answerOverviewRead(shareListing());
      await Promise.resolve();
    });
    const shown = await screen.findAllByTestId("chats-channel-name");
    expect(shown.map((element) => element.textContent)).toEqual(["team", "imported"]);

    // Then the newer read lands, naming only the channel the stale view showed.
    await act(async () => {
      answerSessionRead(shareListing());
      await Promise.resolve();
    });

    await userEvent.click(screen.getAllByTestId("chats-channel")[1]!);
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-channel-title").textContent).toBe("imported");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // A badge pass settles the surface while the first share lookup is still in
  // flight, and that lookup was scoped before this list existed. So the pass
  // that shows the list has to ask about the list: otherwise the channel it
  // just added gets no answer from anyone, and unanswered locks it.
  it("answers the channels a badge pass shows before the first share lookup returns", async () => {
    let channelReads = 0;
    bridgeMock.listChatChannels.mockImplementation(() => {
      channelReads += 1;
      return Promise.resolve({
        channels:
          channelReads === 1 ? [teamChannel()] : [teamChannel(), importedChannel()],
        fileThreads: [],
      });
    });
    let answerFirstLookup!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      // The mount's lookup stalls; nothing has answered the share lanes.
      if (shareReads === 1) {
        return new Promise((resolve) => {
          answerFirstLookup = resolve;
        });
      }
      return Promise.resolve(shareListing());
    });
    renderView();
    await waitFor(() => expect(shareReads).toBe(1));

    // Activity: the pass lists a channel a sync just pulled and shows it.
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(shareReads).toBe(2));
    expect(
      [...bridgeMock.listChatChannelShares.mock.calls[1]![0].channelWireIds].sort(),
    ).toEqual(["wire-imported", "wire-team"]);

    // The mount's lookup finally answers, for the list as it was.
    await act(async () => {
      answerFirstLookup(shareListing());
      await Promise.resolve();
    });

    await userEvent.click(screen.getAllByTestId("chats-channel")[1]!);
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-channel-title").textContent).toBe("imported");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  // A read that lost the relay lane may still answer the joined lane for a
  // channel nothing newer covered. That must not let it SEED the listing: a
  // newer lookup that failed established "unknown" on purpose, and the older
  // read's relay rows are exactly what that unknown replaced.
  it("does not re-seed stale invitations under an unknown a newer read established", async () => {
    let answerStaleRead!: (value: ReturnType<typeof shareListing>) => void;
    let shareReads = 0;
    const invitation = {
      shareId: "share-invite",
      channelWireId: "wire-invite",
      access: "read-write" as const,
      granterEmail: "owner@example.com",
    };
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(shareListing({ received: [invitation] }));
      }
      // The read that will land last, carrying the invitation it read then.
      if (shareReads === 2) {
        return new Promise((resolve) => {
          answerStaleRead = resolve;
        });
      }
      return Promise.reject(new Error("signed out"));
    });
    renderView();
    await screen.findByTestId("chats-join-shared");

    act(() => emitCloudSessionChanged("session-a", "ready"));
    await waitFor(() => expect(shareReads).toBe(2));
    // A newer revalidation fails: dohc has no listing it can stand behind.
    act(() => emitCloudSessionChanged("session-a", "ready"));
    await waitFor(() => expect(shareReads).toBe(3));
    await screen.findByTestId("chats-shares-unreadable");

    await act(async () => {
      answerStaleRead(shareListing({ received: [invitation] }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("chats-shares-unreadable")).toBeTruthy();
    expect(screen.queryByTestId("chats-join-shared")).toBeNull();
    await userEvent.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
  });

  // The badge pass reads the joined lane only. It speaks for no relay lane, so
  // it can correct a listing but never establish one — and a failure the user
  // asked for may have nulled the listing while its read was in flight.
  it("keeps a badge read from establishing a listing a failure cleared", async () => {
    let answerBadgeRead!: (value: { joined: never[] }) => void;
    let shareReads = 0;
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) return Promise.resolve(shareListing());
      return Promise.reject(new Error("signed out"));
    });
    bridgeMock.listJoinedSharedChannels.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerBadgeRead = resolve;
        }),
    );
    renderView();
    await screen.findByTestId("chats-channel-name");

    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listJoinedSharedChannels).toHaveBeenCalled());
    // The user's own revalidation fails while that read is in flight, so the
    // listing is unknown on purpose.
    act(() => emitCloudSessionChanged("session-a", "ready"));
    await screen.findByTestId("chats-shares-unreadable");

    await act(async () => {
      answerBadgeRead({ joined: [] });
      await Promise.resolve();
    });

    expect(screen.getByTestId("chats-shares-unreadable")).toBeTruthy();
    await userEvent.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
  });

  // A create is one local fact, and one local fact is not an answer for the
  // lane. While the share lookup has failed there is no listing to write into,
  // so the new channel fails closed with every other channel on the surface —
  // and the surface says why. Seeding a listing from the create instead would
  // put "no invitations, no members" over a lookup that never answered, which
  // is #618.
  it("fails a created channel closed while nothing has answered the share lanes", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockRejectedValue(new Error("signed out"));
    bridgeMock.createChatChannel.mockResolvedValue({
      channel: channel({ id: "channel-9", name: "launch", slug: "launch" }),
    });
    renderView();
    await screen.findByTestId("chats-shares-unreadable");

    await user.click(screen.getByTestId("chats-new-channel"));
    await user.type(screen.getByTestId("chats-new-channel-name"), "launch{Enter}");
    expect((await screen.findByTestId("chats-channel-title")).textContent).toBe(
      "launch",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
  });

  // The one deliberately wire-id-less fixture. ChatChannelRecord.wireId is
  // nullable — a channel with no recorded wire mapping cannot carry a grant,
  // so it is not lockable and never reaches the joined lane. Every other
  // fixture carries a wire id, because every channel main lists does.
  it("never locks a channel that has no wire identity at all", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ wireId: null })],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({ answerOnly: ["wire-other"] }),
    );
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  it("uses the last authoritative joined row when duplicate wire rows exist", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        joined: [
          {
            shareId: "share-old",
            channelWireId: "wire-team",
            access: "read-only",
            granterEmail: "owner@example.com",
            ended: false,
          },
          {
            shareId: "share-current",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: false,
          },
        ],
      }),
    );
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    expect(await screen.findByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

  it.each([false, true])("manages members through the share panel (already ended: %s)", async alreadyEnded => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        granted: [
          {
            shareId: "share-1",
            channelWireId: "wire-team",
            access: "read-write",
            recipientEmail: "ana@example.com",
            revokedAtMs: null,
          },
        ],
      }),
    );
    bridgeMock.shareChatChannel.mockResolvedValue({ shareId: "share-2" });
    const undo = alreadyEnded ? undefined : { undoId: "undo-1", expiresAtMs: 600_000 };
    bridgeMock.revokeRelayShare.mockResolvedValue({ undo });
    const shareRemovals = { removed: vi.fn(), failed: vi.fn() };
    renderView(vi.fn(), vi.fn(), { shareRemovals });
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared with 1",
    );

    await userEvent.click(screen.getByTestId("chats-channel"));
    const shareButton = await screen.findByTestId("chats-share-channel");
    expect(shareButton.textContent).toContain("Members · 1");
    await userEvent.click(shareButton);

    // The member list shows who has it, and Remove revokes their grant. The
    // shell gets the receipt and the words for the notice that holds Undo.
    const member = await screen.findByTestId("chats-share-member");
    expect(member.textContent).toContain("ana@example.com");
    await userEvent.click(screen.getByTestId("chats-share-revoke"));
    await waitFor(() =>
      expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" }),
    );
    await waitFor(() => expect(shareRemovals.removed).toHaveBeenCalledTimes(1));
    expect(shareRemovals.removed.mock.calls[0]![0]).toMatchObject({
      workspaceId: "workspace-a",
      shareId: "share-1",
      undo,
      message: alreadyEnded ? "ana@example.com no longer has access to team." : "Removed ana@example.com from team.",
      restoredMessage: "Restored ana@example.com to team.",
    });

    // Sharing to a new address, read-only via the checkbox.
    await userEvent.type(screen.getByTestId("chats-share-email"), "bo@example.com");
    await userEvent.click(screen.getByTestId("chats-share-readonly"));
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    await waitFor(() =>
      expect(bridgeMock.shareChatChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        channelId: "channel-team",
        recipientEmail: "bo@example.com",
        access: "read-only",
      }),
    );
  });

  // A revocation that landed is a local fact. When the confirming refresh
  // cannot reach the relay, the keep-cached rule must not resurrect the
  // removed person as a member with a live Remove button.
  it("shows a revoked member gone even when the confirming refresh cannot reach the relay", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(
          shareListing({
            granted: [
              {
                shareId: "share-1",
                channelWireId: "wire-team",
                access: "read-write",
                recipientEmail: "ana@example.com",
                revokedAtMs: null,
              },
            ],
          }),
        );
      }
      // Every later listing — including the post-revoke confirmation — finds
      // the relay down.
      return Promise.resolve({
        joined: [],
        sessionKey: "session-a",
        relay: { state: "unreachable" as const },
      });
    });
    bridgeMock.revokeRelayShare.mockResolvedValue({ undo: { undoId: "undo-1", expiresAtMs: 600_000 } });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-share-channel"));
    expect((await screen.findByTestId("chats-share-member")).textContent).toContain(
      "ana@example.com",
    );

    await userEvent.click(screen.getByTestId("chats-share-revoke"));
    await waitFor(() =>
      expect(bridgeMock.revokeRelayShare).toHaveBeenCalledWith({ shareId: "share-1" }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("chats-share-member")).toBeNull();
    });
  });

  // Over the cap, a new grant only deepens the state: the
  // relay's create path has no matching cap, and the granted rows are empty on
  // an over-limit read so nothing can be removed to make room. A surface that
  // names the constraint and still offers the one action that worsens it is
  // not an honest refusal.
  it("stops offering new grants while the listing is over the limit", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
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
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-share-channel"));

    // The panel says what is wrong...
    expect(
      (await screen.findByTestId("chats-share-members-unreadable")).dataset.failure,
    ).toBe("over-limit");
    // ...and the control that would make it worse is off.
    expect(
      (screen.getByTestId("chats-share-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByTestId("chats-share-email") as HTMLInputElement).disabled).toBe(
      true,
    );

    // Even typing an address does not enable it.
    await userEvent.type(screen.getByTestId("chats-share-email"), "bo@example.com");
    expect(
      (screen.getByTestId("chats-share-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(bridgeMock.shareChatChannel).not.toHaveBeenCalled();
  });

  // Only the granted lane can be deepened by a new
  // outgoing share. A full received lane is an inbound backlog the user did
  // not create and cannot clear from here, and blocking their outgoing work
  // over it turns one account-wide problem into a second one.
  it("still allows sharing when only the received lane is over the limit", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: {
        state: "over-limit" as const,
        lanes: [{ lane: "received" as const, rows: 5000 }],
        limit: 4096,
      },
    });
    bridgeMock.shareChatChannel.mockResolvedValue({ shareId: "share-new" });
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-share-channel"));

    // The surface still names the inbound problem...
    expect(
      (await screen.findByTestId("chats-share-members-unreadable")).dataset.failure,
    ).toBe("over-limit");
    // ...and outgoing sharing still works, because it adds to the other lane.
    expect((screen.getByTestId("chats-share-email") as HTMLInputElement).disabled).toBe(
      false,
    );
    await userEvent.type(screen.getByTestId("chats-share-email"), "bo@example.com");
    expect(
      (screen.getByTestId("chats-share-submit") as HTMLButtonElement).disabled,
    ).toBe(false);
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    await waitFor(() => expect(bridgeMock.shareChatChannel).toHaveBeenCalled());
  });

  // The owner side of #618: an unreachable listing left this panel showing no
  // members, which reads as "nobody has this channel" — the opposite of the
  // truth for a channel that IS shared.
  it("says dohc could not read the shares in the share panel instead of listing nobody", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [],
      sessionKey: "session-a",
      relay: { state: "unreachable" as const },
    });
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-share-channel"));
    const notice = await screen.findByTestId("chats-share-members-unreadable");
    expect(notice.textContent).toContain("dohc could not read your shares.");
    expect(screen.queryByTestId("chats-share-member")).toBeNull();
    // The retry works from here too.
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        granted: [
          {
            shareId: "share-1",
            channelWireId: "wire-team",
            access: "read-write",
            recipientEmail: "ana@example.com",
            revokedAtMs: null,
          },
        ],
      }),
    );
    await userEvent.click(screen.getByTestId("chats-share-members-unreadable-retry"));
    expect((await screen.findByTestId("chats-share-member")).textContent).toContain(
      "ana@example.com",
    );
    expect(screen.queryByTestId("chats-share-members-unreadable")).toBeNull();
  });

  // A revoke that started under the old session must not spend a commit
  // ticket in the new session's order: its optimistic claim would outrank
  // the new session's own in-flight listing and leave the panel empty after
  // an unreachable follow-up.
  it("lets the new session's answer land when a revoke from the old session finishes late", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    const answers: Array<(value: unknown) => void> = [];
    let shareReads = 0;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      shareReads += 1;
      if (shareReads === 1) {
        return Promise.resolve(
          shareListing({
            sessionKey: "session-a",
            granted: [
              {
                shareId: "share-1",
                channelWireId: "wire-team",
                access: "read-write",
                recipientEmail: "ana@example.com",
                revokedAtMs: null,
              },
            ],
          }),
        );
      }
      return new Promise((resolve) => {
        answers.push(resolve);
      });
    });
    let finishRevoke!: (value: { undo: { undoId: string; expiresAtMs: number } }) => void;
    bridgeMock.revokeRelayShare.mockReturnValue(
      new Promise((resolve) => {
        finishRevoke = resolve;
      }),
    );
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-share-channel"));
    expect((await screen.findByTestId("chats-share-member")).textContent).toContain(
      "ana@example.com",
    );

    // The revoke starts under session A and stalls.
    await userEvent.click(screen.getByTestId("chats-share-revoke"));
    await waitFor(() => expect(bridgeMock.revokeRelayShare).toHaveBeenCalled());

    // Switch sessions: the signal clears the panel and issues the new
    // session's listing, which stays in flight.
    act(() => emitCloudSessionChanged("session-b"));
    await waitFor(() => expect(shareReads).toBe(2));

    // The revoke finishes late; its confirming refresh cannot reach the
    // relay.
    await act(async () => {
      finishRevoke({ undo: { undoId: "undo-1", expiresAtMs: 600_000 } });
      await Promise.resolve();
    });
    await waitFor(() => expect(shareReads).toBe(3));
    await act(async () => {
      answers.at(-1)!({
        joined: [],
        sessionKey: "session-b",
        relay: { state: "unreachable" },
      });
      await Promise.resolve();
    });

    // The new session's own listing — issued at the switch — answers with
    // its grant. It must land, not be outranked by the stale revoke's claim.
    await act(async () => {
      answers[0]!(
        shareListing({
          sessionKey: "session-b",
          granted: [
            {
              shareId: "share-b",
              channelWireId: "wire-team",
              access: "read-write",
              recipientEmail: "bob@example.com",
              revokedAtMs: null,
            },
          ],
        }),
      );
      await Promise.resolve();
    });
    const members = await screen.findAllByTestId("chats-share-member");
    expect(members.map((member) => member.textContent).join(" ")).toContain(
      "bob@example.com",
    );
  });

  it("lists invitations under Shared with you, joins one, and re-enables the other Join buttons", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        received: [
          {
            shareId: "share-in",
            channelWireId: "wire-in",
            access: "read-write",
            granterEmail: "owner@example.com",
          },
          {
            shareId: "share-in-2",
            channelWireId: "wire-in-2",
            access: "read-write",
            granterEmail: "other@example.com",
          },
        ],
      }),
    );
    bridgeMock.joinSharedChannel.mockResolvedValue({
      joined: {
        shareId: "share-in",
        channelWireId: "wire-in",
        access: "read-write",
        granterEmail: "owner@example.com",
        ended: false,
      },
    });
    renderView();
    const section = await screen.findByTestId("chats-shared-with-you");
    expect(section.textContent).toContain("owner@example.com");
    expect(section.textContent).toContain("other@example.com");
    await userEvent.click(screen.getAllByTestId("chats-join-shared")[0]!);
    await waitFor(() =>
      expect(bridgeMock.joinSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-in",
      }),
    );
    // The overview reloads after joining (channel + shares re-fetch).
    await waitFor(() => expect(bridgeMock.listChatChannels).toHaveBeenCalledTimes(2));
    // Regression (CodeRabbit critical): the join-in-flight flag must reset
    // after a successful join even though refreshOverview bumps the liveness
    // token — the other invitation's Join button re-enables instead of
    // staying dead for the rest of the session.
    await waitFor(() => {
      const buttons = screen.getAllByTestId("chats-join-shared");
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      }
    });
  });

  it("offers an explicit rejoin action for an ended leave tombstone", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        received: [
          {
            shareId: "share-return",
            channelWireId: "wire-return",
            access: "read-write",
            granterEmail: "owner@example.com",
          },
        ],
        joined: [
          {
            shareId: "share-return",
            channelWireId: "wire-return",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: true,
          },
        ],
      }),
    );
    bridgeMock.joinSharedChannel.mockResolvedValue({
      joined: {
        shareId: "share-return",
        channelWireId: "wire-return",
        access: "read-write",
        granterEmail: "owner@example.com",
        ended: false,
      },
    });

    renderView();

    const section = await screen.findByTestId("chats-shared-with-you");
    expect(section.textContent).toContain("owner@example.com");
    await userEvent.click(screen.getByTestId("chats-join-shared"));
    await waitFor(() =>
      expect(bridgeMock.joinSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-return",
      }),
    );
  });

  it("shows a joined channel's provenance, disables composers when read-only, and can leave", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        joined: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-only",
            granterEmail: "owner@example.com",
            ended: false,
          },
        ],
      }),
    );
    bridgeMock.leaveSharedChannel.mockResolvedValue(undefined);
    renderView();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared by owner@example.com — read-only",
    );

    await userEvent.click(screen.getByTestId("chats-channel"));
    await screen.findByTestId("chats-joined-banner");
    // Read-only: the thread composer is replaced by an honest notice, and a
    // joined channel is never re-shareable from here.
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(screen.queryByTestId("chats-share-channel")).toBeNull();

    await userEvent.click(screen.getByTestId("chats-leave-shared"));
    await waitFor(() =>
      expect(bridgeMock.leaveSharedChannel).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: "share-in",
      }),
    );
  });

  it("keeps a feed deep link into a joined channel read-only", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        joined: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-only",
            granterEmail: "owner@example.com",
            ended: false,
          },
        ],
      }),
    );
    bridgeMock.listPersonalChatFeed.mockResolvedValue({
      items: [
        {
          message: message({ body: "Shared update", threadId: "thread-1" }),
          thread: thread({
            channelId: "channel-team",
            messageCount: 1,
            lastReadSequence: 0,
            unreadCount: 1,
          }),
          channel: {
            id: "channel-team",
            wireId: "wire-team",
            name: "team",
            slug: "team",
            kind: "channel",
          },
          reactions: [],
          matchedBy: ["channel"],
        },
      ],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ body: "Shared update", threadId: "thread-1" })],
    });

    renderView();
    await userEvent.click(await screen.findByTestId("chats-feed-link"));
    const update = await screen.findByText("Shared update");
    await userEvent.click(update.closest("button")!);

    await screen.findByTestId("chats-thread-view");
    expect(screen.getByTestId("chats-readonly-note").textContent).toContain(
      "read-only for you",
    );
    expect(screen.queryByTestId("chats-composer")).toBeNull();
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();
  });

  it("does not mark a thread read after its joined channel has ended", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        joined: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: true,
          },
        ],
      }),
    );
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
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");

    expect(screen.queryByTestId("chats-composer")).toBeNull();
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();
  });

  it("keeps a read-write joined channel's composer and blocks it once the share ends", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [teamChannel()],
      fileThreads: [],
    });
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        joined: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: false,
          },
        ],
      }),
    );
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-joined-banner");
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    cleanup();

    // The same channel after the share ended: still readable, no posting.
    // Nothing in the listing says why, so the note says only that.
    const endedRow = {
      shareId: "share-in",
      channelWireId: "wire-team",
      access: "read-write" as const,
      granterEmail: "owner@example.com",
      ended: true,
    };
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing({ joined: [endedRow] }));
    renderView();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "no longer shared",
    );
    await userEvent.click(screen.getByTestId("chats-channel"));
    const note = await screen.findByTestId("chats-readonly-note");
    expect(note.textContent).toBe(
      "This group is no longer shared with you. You can still read it.",
    );
    expect(screen.queryByTestId("chats-new-thread-composer")).toBeNull();
    cleanup();

    // Only the relay's removed lane may name the owner.
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({ joined: [endedRow], removed: ["share-in"] }),
    );
    renderView();
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "the owner removed your access",
    );
    await userEvent.click(screen.getByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe(
      "The owner removed your access to this group. You can still read it.",
    );
    cleanup();

    // An ended row whose invitation is still listed is one this workspace
    // left: the owner did nothing, and Join is the way back.
    bridgeMock.listChatChannelShares.mockResolvedValue(
      shareListing({
        received: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
          },
        ],
        joined: [
          {
            shareId: "share-in",
            channelWireId: "wire-team",
            access: "read-write",
            granterEmail: "owner@example.com",
            ended: true,
          },
        ],
      }),
    );
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    expect((await screen.findByTestId("chats-readonly-note")).textContent).toBe(
      "You left this group. You can still read it.",
    );
  });
});
