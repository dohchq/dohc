// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ChatsView,
  channel,
  thread,
  message,
  bridgeMock,
  shareListing,
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

  it("keeps an owned local channel writable after authoritative empty share metadata", async () => {
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing());
    renderView();

    await userEvent.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    expect(screen.queryByTestId("chats-readonly-note")).toBeNull();
  });

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

  it.each([false])("manages members through the share panel (already ended: %s)", async alreadyEnded => {
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
    const shareRemovals = { removed: vi.fn(), failed: vi.fn(), agentDisconnected: vi.fn() };
    renderView(vi.fn(), vi.fn(), { shareRemovals });
    expect((await screen.findByTestId("chats-channel-shared")).textContent).toContain(
      "Shared with 1",
    );

    await userEvent.click(screen.getByTestId("chats-channel"));
    const shareButton = await screen.findByTestId("chats-share-channel");
    expect(shareButton.textContent).toBe("A1");
    expect(shareButton.getAttribute("aria-label")).toBe("1 member");
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

    // Adding someone as View only, from Add people at the top of the list.
    // The dialog goes back to the list, which shows them while it reloads.
    let finishListing = () => {};
    bridgeMock.listChatChannelShares.mockImplementation(
      () => new Promise((resolve) => { finishListing = () => resolve(shareListing()); }),
    );
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    expect(document.activeElement).toBe(screen.getByTestId("chats-share-email"));
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
    const added = await screen.findByText("bo@example.com");
    expect(added.closest("[data-testid='chats-share-member']")?.textContent).toContain("View only");
    await act(async () => finishListing());

    // Add people starts fresh: no one picked, and Can post chosen again.
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    expect((screen.getByTestId("chats-share-email") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("chats-share-canpost").getAttribute("aria-checked")).toBe("true");

    // Close leaves the members button where it was.
    await userEvent.click(screen.getByTestId("chats-share-close"));
    expect(screen.queryByTestId("chats-share-panel")).toBeNull();
    expect(screen.getByTestId("chats-share-channel")).toBeTruthy();
  });

  it("closes Add people on an account change and adds no one else from its batch", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [teamChannel()], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing());
    let finishFirst!: (value: unknown) => void;
    bridgeMock.shareChatChannel.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    bridgeMock.shareChatChannel.mockResolvedValue({});
    renderView();
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-share-channel"));
    await userEvent.type(screen.getByTestId("chats-share-email"), "ana@example.com,ben@example.com,");
    await userEvent.click(screen.getByTestId("chats-share-submit"));
    expect(bridgeMock.shareChatChannel).toHaveBeenCalledTimes(1);

    act(() => emitCloudSessionChanged("session-b"));
    expect(screen.queryByTestId("chats-share-panel")).toBeNull();
    await act(async () => {
      finishFirst({});
      await Promise.resolve();
    });
    // Reopening under the new account does not let the old batch go on.
    await userEvent.click(screen.getByTestId("chats-share-channel"));
    await waitFor(() => expect(screen.getByTestId("chats-share-panel")).toBeTruthy());
    expect(bridgeMock.shareChatChannel).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId("chats-share-chip")).toEqual([]);
  });

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
      (screen.getByTestId("chats-share-add-people") as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByTestId("chats-share-add-people"));
    expect(screen.queryByTestId("chats-share-email")).toBeNull();
    expect(bridgeMock.shareChatChannel).not.toHaveBeenCalled();
  });

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

  });
});
