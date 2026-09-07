// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, DmRecord } from "../../ipc/bridgeContract";
import { withholdDmsInRequestLanes } from "../../workspaces/dmRequests";
import {
  channel,
  message,
  dm,
  bridgeMock,
  emitWorkspaceActivity,
  emitCloudSessionChanged,
  renderView,
} from "./ChatsView.testHarness";

// Direct messages (WS-MU-C3): participants-only conversations behind the
// collaboration gate. Solo (available:false, no DMs) renders nothing — the
// zero-bloat rule — and the DM conversation is one running thread whose
// composer sends on Enter (anti-forum).
describe("ChatsView direct messages", () => {
  it("accepts a message request elsewhere without navigating this workspace", async () => {
    const user = userEvent.setup();
    const request = { shareId: "share-dm-request", granterEmail: "bob@example.com" };
    const accepted = dm({
      role: "participant",
      shareId: request.shareId,
      peerLabel: "bob@example.com",
    });
    const onNavCommand = vi.fn();
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [],
      pending: [request],
      declined: [],
    });
    bridgeMock.acceptDm.mockResolvedValue({ dm: accepted });
    bridgeMock.listChatMessages.mockImplementation(({ workspaceId, threadId }) =>
      threadId === accepted.threadId && workspaceId !== "workspace-b"
        ? Promise.reject(new Error("channel not found"))
        : Promise.resolve({ messages: [] }),
    );

    renderView(vi.fn(), vi.fn(), { variant: "page", onNavCommand });
    expect(await screen.findByText("Direct message requests")).toBeTruthy();
    expect(screen.getByText("Wants to message you")).toBeTruthy();
    await user.click(screen.getByTestId("chats-dm-request-accept"));

    expect(await screen.findByTestId("chats-accept-dm-dialog")).toBeTruthy();
    expect(screen.getByText(
      "The conversation stays in the workspace you pick.",
    )).toBeTruthy();
    const options = screen.getAllByTestId("chats-accept-dm-workspace-option");
    const currentOption = options.find(
      (option) => option.getAttribute("data-workspace-id") === "workspace-a",
    );
    const personalOption = options.find(
      (option) => option.getAttribute("data-workspace-id") === "workspace-b",
    );
    expect(currentOption?.querySelector("input")?.checked).toBe(true);
    await user.click(personalOption!);
    expect(screen.getByTestId("chats-accept-dm-confirm").textContent).toBe(
      "Add to Personal",
    );
    await user.click(screen.getByTestId("chats-accept-dm-confirm"));

    await waitFor(() => {
      expect(bridgeMock.acceptDm).toHaveBeenCalledWith({
        workspaceId: "workspace-b",
        shareId: request.shareId,
      });
    });
    expect(onNavCommand).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    expect(
      (await screen.findByTestId("chats-dm-accepted-elsewhere")).textContent,
    ).toContain(
      "Added your conversation with bob@example.com to Personal.",
    );
    expect(bridgeMock.listChatMessages).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("chats-dm-accepted-elsewhere-dismiss"));
    expect(screen.queryByTestId("chats-dm-accepted-elsewhere")).toBeNull();
  });

  it("keeps the cross-workspace confirmation when accept queues behind a DM refresh", async () => {
    const user = userEvent.setup();
    const request = { shareId: "share-dm-race", granterEmail: "bob@example.com" };
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [],
      pending: [request],
      declined: [],
    });
    bridgeMock.acceptDm.mockResolvedValue({
      dm: dm({ role: "participant", shareId: request.shareId }),
    });

    renderView();
    await screen.findByTestId("chats-dm-request-item");
    const syncsBefore = bridgeMock.syncDms.mock.calls.length;
    let resolvePoll!: (result: {
      available: boolean;
      dms: DmRecord[];
      pending: (typeof request)[];
      declined: (typeof request)[];
    }) => void;
    const pendingPoll = new Promise<{
      available: boolean;
      dms: DmRecord[];
      pending: (typeof request)[];
      declined: (typeof request)[];
    }>((resolve) => {
      resolvePoll = resolve;
    });
    bridgeMock.syncDms
      .mockImplementationOnce(() => pendingPoll)
      .mockImplementation(() => new Promise<never>(() => undefined));

    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 1),
    );
    await user.click(screen.getByTestId("chats-dm-request-accept"));
    const personalOption = screen
      .getAllByTestId("chats-accept-dm-workspace-option")
      .find((option) => option.dataset.workspaceId === "workspace-b");
    await user.click(personalOption!);
    await user.click(screen.getByTestId("chats-accept-dm-confirm"));
    await screen.findByTestId("chats-dm-accepted-elsewhere");

    await act(async () => {
      resolvePoll({ available: true, dms: [], pending: [], declined: [] });
      await pendingPoll;
    });
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBe(syncsBefore + 2),
    );
    expect(screen.getByTestId("chats-dm-accepted-elsewhere")).toBeTruthy();
  });

  it("refuses an old account's DM response after the session changes", async () => {
    const oldRequest = {
      shareId: "share-old-account",
      granterEmail: "old-account@example.com",
    };
    const newRequest = {
      shareId: "share-new-account",
      granterEmail: "new-account@example.com",
    };
    type SyncResult = {
      available: boolean;
      dms: DmRecord[];
      pending: (typeof oldRequest)[];
      declined: (typeof oldRequest)[];
    };
    let resolveStaleSync!: (result: SyncResult) => void;
    let resolveNewSync!: (result: SyncResult) => void;
    const staleSync = new Promise<SyncResult>((resolve) => {
      resolveStaleSync = resolve;
    });
    const newSync = new Promise<SyncResult>((resolve) => {
      resolveNewSync = resolve;
    });
    bridgeMock.syncDms
      .mockResolvedValueOnce({
        available: true,
        dms: [],
        pending: [oldRequest],
        declined: [],
      })
      .mockImplementationOnce(() => staleSync)
      .mockImplementationOnce(() => newSync)
      .mockImplementation(() => new Promise<never>(() => undefined));

    renderView();
    expect(await screen.findByText("old-account@example.com")).toBeTruthy();
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.syncDms).toHaveBeenCalledTimes(2));
    act(() => emitCloudSessionChanged("session-b"));
    await waitFor(() => {
      expect(screen.queryByText("old-account@example.com")).toBeNull();
    });

    await act(async () => {
      resolveStaleSync({
        available: true,
        dms: [],
        pending: [oldRequest],
        declined: [],
      });
      await staleSync;
    });
    await waitFor(() => expect(bridgeMock.syncDms).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("old-account@example.com")).toBeNull();

    await act(async () => {
      resolveNewSync({
        available: true,
        dms: [],
        pending: [newRequest],
        declined: [],
      });
      await newSync;
    });
    expect(await screen.findByText("new-account@example.com")).toBeTruthy();
  });

  it("refuses an old account's open-DM response after the session changes", async () => {
    const user = userEvent.setup();
    const oldDm = dm({
      peerLabel: "old-peer@example.com",
      threadId: null,
    });
    const oldRequest = {
      shareId: "share-old-open-dm",
      granterEmail: "old-open-dm@example.com",
    };
    type SyncResult = {
      available: boolean;
      dms: DmRecord[];
      pending: (typeof oldRequest)[];
      declined: (typeof oldRequest)[];
    };
    let resolveStaleSync!: (result: SyncResult) => void;
    const staleSync = new Promise<SyncResult>((resolve) => {
      resolveStaleSync = resolve;
    });
    bridgeMock.syncDms
      .mockResolvedValueOnce({
        available: true,
        dms: [oldDm],
        pending: [],
        declined: [],
      })
      .mockImplementationOnce(() => staleSync)
      .mockImplementation(() => new Promise<never>(() => undefined));

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    await screen.findByTestId("chats-dm-view");
    await waitFor(() => expect(bridgeMock.syncDms).toHaveBeenCalledTimes(2));
    expect(bridgeMock.syncDms.mock.calls[1]?.[0]).toEqual({
      workspaceId: "workspace-a",
      openChannelId: oldDm.channelId,
    });

    act(() => emitCloudSessionChanged("session-b"));
    await waitFor(() => {
      expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    });
    await act(async () => {
      resolveStaleSync({
        available: true,
        dms: [oldDm],
        pending: [oldRequest],
        declined: [],
      });
      await staleSync;
    });

    expect(screen.queryByText("old-open-dm@example.com")).toBeNull();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
  });

  it("closes the open accept-DM dialog when the cloud session changes", async () => {
    const user = userEvent.setup();
    const request = {
      shareId: "share-old-account-dialog",
      granterEmail: "old-account@example.com",
    };
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [],
      pending: [request],
      declined: [],
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-request-accept"));
    expect(await screen.findByTestId("chats-accept-dm-dialog")).toBeTruthy();

    act(() => emitCloudSessionChanged("session-b"));

    await waitFor(() => {
      expect(screen.queryByTestId("chats-accept-dm-dialog")).toBeNull();
    });
  });

  it("accepts a message request in the current workspace and opens it", async () => {
    const user = userEvent.setup();
    const request = {
      shareId: "share-dm-current",
      granterEmail: "bob@example.com",
    };
    const accepted = dm({
      role: "participant",
      shareId: request.shareId,
      peerLabel: "bob@example.com",
    });
    const onNavCommand = vi.fn();
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [],
      pending: [request],
      declined: [],
    });
    bridgeMock.acceptDm.mockResolvedValue({ dm: accepted });

    renderView(vi.fn(), vi.fn(), { variant: "page", onNavCommand });
    await user.click(await screen.findByTestId("chats-dm-request-accept"));
    await user.click(screen.getByTestId("chats-accept-dm-confirm"));

    await waitFor(() =>
      expect(bridgeMock.acceptDm).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        shareId: request.shareId,
      }),
    );
    expect(onNavCommand).toHaveBeenCalledWith({ level: "dm", dm: accepted });
    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
  });

  it("routes a panel-variant accept through the editor tab seam", async () => {
    const user = userEvent.setup();
    const request = {
      shareId: "share-dm-panel-accept",
      granterEmail: "bob@example.com",
    };
    const accepted = dm({
      role: "participant",
      shareId: request.shareId,
      peerLabel: "bob@example.com",
    });
    const onOpenInTab = vi.fn();
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [],
      pending: [request],
      declined: [],
    });
    bridgeMock.acceptDm.mockResolvedValue({ dm: accepted });

    renderView(vi.fn(), vi.fn(), { onOpenInTab });
    await user.click(await screen.findByTestId("chats-dm-request-accept"));
    await user.click(screen.getByTestId("chats-accept-dm-confirm"));

    await waitFor(() =>
      expect(onOpenInTab).toHaveBeenCalledWith({ level: "dm", dm: accepted }),
    );
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
  });

  it("clears the cross-workspace confirmation after the next successful DM refresh", async () => {
    const user = userEvent.setup();
    const request = { shareId: "share-dm-elsewhere", granterEmail: null };
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [],
      pending: [request],
      declined: [],
    });
    bridgeMock.acceptDm.mockResolvedValue({
      dm: dm({ role: "participant", shareId: request.shareId }),
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-request-accept"));
    const personalOption = screen
      .getAllByTestId("chats-accept-dm-workspace-option")
      .find((option) => option.dataset.workspaceId === "workspace-b");
    await user.click(personalOption!);
    await user.click(screen.getByTestId("chats-accept-dm-confirm"));

    expect(
      (await screen.findByTestId("chats-dm-accepted-elsewhere")).textContent,
    ).toContain("Added this conversation to Personal.");
    await waitFor(() => expect(bridgeMock.syncDms.mock.calls.length).toBeGreaterThan(1));
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.queryByTestId("chats-dm-accepted-elsewhere")).toBeNull(),
    );
  });

  it("moves a request through declined and back to pending", async () => {
    const user = userEvent.setup();
    const request = { shareId: "share-dm-request", granterEmail: "bob@example.com" };
    let state: "pending" | "declined" = "pending";
    bridgeMock.syncDms.mockImplementation(() =>
      Promise.resolve({
        available: true,
        dms: [],
        pending: state === "pending" ? [request] : [],
        declined: state === "declined" ? [request] : [],
      }),
    );
    bridgeMock.declineDm.mockImplementation(() => {
      state = "declined";
      return Promise.resolve(undefined);
    });
    bridgeMock.requestDmAgain.mockImplementation(() => {
      state = "pending";
      return Promise.resolve(undefined);
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-request-decline"));
    expect(await screen.findByTestId("chats-dm-declined-item")).toBeTruthy();
    expect(bridgeMock.declineDm).toHaveBeenCalledWith({ shareId: request.shareId });

    await user.click(screen.getByTestId("chats-dm-request-again"));
    expect(await screen.findByTestId("chats-dm-request-item")).toBeTruthy();
    expect(bridgeMock.requestDmAgain).toHaveBeenCalledWith({
      shareId: request.shareId,
    });
  });

  it("shows no DM surface at all for a solo user", async () => {
    // Even a stray dm-kind channel row never leaks into the channel list.
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({ id: "channel-dm-1", name: "bob@example.com", slug: "bob-example-com", kind: "dm" }),
      ],
      fileThreads: [],
    });
    renderView();
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-dms-section")).toBeNull();
    expect(screen.queryByTestId("chats-new-dm")).toBeNull();
    const names = screen.getAllByTestId("chats-channel-name").map((el) => el.textContent);
    expect(names).toEqual(["general"]);
  });

  it("lists DMs by peer label with unread badges when collaboration is on", async () => {
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [
        dm({ peerLabel: "bob@example.com", unreadCount: 2 }),
        dm({
          channelId: "channel-dm-2",
          channelWireId: "wire-dm-2",
          role: "participant",
          peerLabel: "carol@example.com",
          connected: false,
        }),
      ],
    });
    renderView();
    await screen.findByTestId("chats-dms-section");
    const names = screen.getAllByTestId("chats-dm-name").map((el) => el.textContent);
    expect(names).toEqual(["bob@example.com", "carol@example.com"]);
    expect(screen.getByTestId("chats-dm-unread").textContent).toBe("2");
    expect(screen.getByTestId("chats-new-dm")).toBeTruthy();
  });

  it("scrolls and highlights a canonical DM backlink's focused message", async () => {
    const focused = message({
      id: "message-focus",
      threadId: "thread-dm-1",
      body: "Focused DM mention",
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [focused] });
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: {
        level: "dm",
        dm: dm(),
        focusMessageId: focused.id,
      },
    });

    expect(await screen.findByText("Focused DM mention")).toBeTruthy();
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    });
    expect(screen.getByTestId("chats-dm-message").className).toContain("ring-2");
  });

  it("clears focused-message state and refs when a DM is opened normally", async () => {
    const user = userEvent.setup();
    const focused = message({
      id: "message-focus",
      threadId: "thread-dm-1",
      body: "Same id, different navigation",
    });
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm()] })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [focused] });

    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: {
        level: "dm",
        dm: dm(),
        focusMessageId: focused.id,
      },
    });

    const initiallyFocused = await screen.findByTestId("chats-dm-message");
    await waitFor(() => expect(initiallyFocused.className).toContain("ring-2"));

    await user.click(screen.getByTestId("chats-dm-back"));
    await user.click(await screen.findByTestId("chats-dm-item"));
    const normallyOpened = await screen.findByTestId("chats-dm-message");
    expect(normallyOpened.className).not.toContain("ring-2");
  });

  // The main-side shared-channel pass is bounded, so a poll that does not
  // name the DM it is showing can refresh sixteen other channels and leave this
  // conversation stale while the surface looks refreshed. The list poll names
  // nothing (it is showing the list); the open-DM refresh names the DM.
  it("names the open DM on its refresh, and nothing on the list poll", async () => {
    const user = userEvent.setup();
    // A DM whose thread has not replicated yet refreshes the moment it opens,
    // which is the same refreshOpenDm path the 4 s poll runs.
    const pending = dm({ threadId: null });
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [pending] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
    renderView();
    await screen.findByTestId("chats-dm-item");
    expect(
      bridgeMock.syncDms.mock.calls.every(
        ([payload]) => payload.openChannelId === undefined,
      ),
    ).toBe(true);

    const listCalls = bridgeMock.syncDms.mock.calls.length;
    await user.click(await screen.findByTestId("chats-dm-item"));
    await waitFor(() =>
      expect(bridgeMock.syncDms.mock.calls.length).toBeGreaterThan(listCalls),
    );
    expect(
      bridgeMock.syncDms.mock.calls.slice(listCalls).map(([payload]) => payload.openChannelId),
    ).toContain("channel-dm-1");
  });

  it("opens a DM into its single running conversation and sends on Enter", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm({ unreadCount: 2 })] })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({ id: "m-1", threadId: "thread-dm-1", authorDisplayName: "bob@example.com", body: "hey" }),
      ],
    });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "m-2", threadId: "thread-dm-1", body: "hi bob" }),
    });
    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    expect(screen.getByTestId("chats-dm-title").textContent).toBe("bob@example.com");
    const bodies = await screen.findAllByTestId("chats-dm-message-body");
    expect(bodies.map((el) => el.textContent)).toEqual(["hey"]);
    // On-screen == read: the cursor advances like the thread view.
    await waitFor(() =>
      expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
        upToSequence: 1,
      }),
    );
    await user.type(screen.getByTestId("chats-dm-composer"), "hi bob{Enter}");
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
        body: "hi bob",
      }),
    );
    const updated = await screen.findAllByTestId("chats-dm-message-body");
    expect(updated[updated.length - 1].textContent).toBe("hi bob");

    await user.click(screen.getByTestId("chats-dm-back"));
    await screen.findByTestId("chats-dm-item");
    expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
  });

  // The placement a participant picked when they accepted has a
  // visible reverse path. The owner side (shareId null) never accepted a
  // grant into a workspace, so it has nothing to reverse.
  describe("leaving a conversation", () => {
    it("shows Leave only for a participant's accepted DM, never the owner's own", async () => {
      const user = userEvent.setup();
      bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [dm()] });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      await screen.findByTestId("chats-dm-view");
      expect(screen.queryByTestId("chats-dm-leave")).toBeNull();
    });

    it("states the pinned copy and does not end the row on cancel", async () => {
      const user = userEvent.setup();
      const participant = dm({
        role: "participant",
        shareId: "share-dm-1",
        peerLabel: "alice@example.com",
      });
      bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [participant] });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      await user.click(await screen.findByTestId("chats-dm-leave"));

      const dialog = await screen.findByTestId("chats-leave-dm-dialog");
      expect(dialog.textContent).toContain(
        "Leave your conversation with alice@example.com?",
      );
      expect(dialog.textContent).toContain(
        "The conversation leaves Work. It appears again as a message request, so you can add it to a workspace later. Your messages are kept.",
      );

      await user.click(screen.getByTestId("chats-leave-dm-cancel"));
      expect(screen.queryByTestId("chats-leave-dm-dialog")).toBeNull();
      expect(bridgeMock.leaveDm).not.toHaveBeenCalled();
      // Still on the DM, unchanged.
      expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    });

    it("ends the row, drops the conversation from the list, and returns to Chats on confirm", async () => {
      const user = userEvent.setup();
      const participant = dm({ role: "participant", shareId: "share-dm-1" });
      // listDmRecords deliberately keeps an ended participant row
      // readable (connected:false — the same owner-revoked tombstone rule),
      // so main's real post-leave syncDms response carries both this row and
      // the reappeared pending request for the same shareId. Building the
      // mock through the actual withholdDmsInRequestLanes (not a hand-typed
      // `dms: []`) is what makes this a real flow: a no-op filter would leave
      // the ended row in `dms` and this test would go red on "shows only the
      // request" below.
      const endedRow = dm({ role: "participant", shareId: "share-dm-1", connected: false });
      const reappearedRequest = { shareId: "share-dm-1", granterEmail: "alice@example.com" };
      bridgeMock.syncDms
        .mockResolvedValueOnce({ available: true, dms: [participant], pending: [], declined: [] })
        .mockResolvedValue({
          available: true,
          dms: withholdDmsInRequestLanes({
            dms: [endedRow],
            requestShareIds: new Set(["share-dm-1"]),
            holdersByShareId: new Map(),
            holdersByWireId: new Map(),
            workspaceId: "workspace-a",
          }),
          pending: [reappearedRequest],
          declined: [],
        });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      bridgeMock.leaveDm.mockResolvedValue(undefined);
      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      await user.click(await screen.findByTestId("chats-dm-leave"));
      await user.click(await screen.findByTestId("chats-leave-dm-confirm"));

      await waitFor(() =>
        expect(bridgeMock.leaveDm).toHaveBeenCalledWith({
          workspaceId: "workspace-a",
          shareId: "share-dm-1",
        }),
      );
      await waitFor(() => expect(screen.queryByTestId("chats-dm-view")).toBeNull());
      // One identity, one place: the request-lane representation wins.
      await screen.findByTestId("chats-dm-request-item");
      expect(screen.queryByTestId("chats-dm-item")).toBeNull();
    });

    it("clears the composer draft on leave, so the next DM opened starts empty", async () => {
      const user = userEvent.setup();
      const leaving = dm({
        channelId: "channel-dm-1",
        channelWireId: "wire-dm-1",
        role: "participant",
        shareId: "share-dm-1",
        peerLabel: "alice@example.com",
      });
      const other = dm({
        channelId: "channel-dm-2",
        channelWireId: "wire-dm-2",
        threadId: "thread-dm-2",
        peerLabel: "bob@example.com",
        name: "bob@example.com",
      });
      bridgeMock.syncDms
        .mockResolvedValueOnce({
          available: true,
          dms: [leaving, other],
          pending: [],
          declined: [],
        })
        .mockResolvedValue({
          available: true,
          dms: [other],
          pending: [{ shareId: "share-dm-1", granterEmail: "alice@example.com" }],
          declined: [],
        });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      bridgeMock.leaveDm.mockResolvedValue(undefined);
      renderView();

      const items = await screen.findAllByTestId("chats-dm-item");
      await user.click(
        items.find((el) => el.getAttribute("data-channel-id") === "channel-dm-1")!,
      );
      await screen.findByTestId("chats-dm-view");
      await user.type(screen.getByTestId("chats-dm-composer"), "unsent draft for alice");
      expect(
        (screen.getByTestId("chats-dm-composer") as HTMLTextAreaElement).value,
      ).toBe("unsent draft for alice");

      await user.click(await screen.findByTestId("chats-dm-leave"));
      await user.click(await screen.findByTestId("chats-leave-dm-confirm"));
      await waitFor(() => expect(bridgeMock.leaveDm).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByTestId("chats-dm-view")).toBeNull());

      await user.click(await screen.findByTestId("chats-dm-item"));
      await screen.findByTestId("chats-dm-view");
      expect(
        (screen.getByTestId("chats-dm-composer") as HTMLTextAreaElement).value,
      ).toBe("");
    });

    it("gates Leave on a live placement, not merely a shareId", async () => {
      const user = userEvent.setup();
      const live = dm({
        channelId: "channel-dm-1",
        channelWireId: "wire-dm-1",
        role: "participant",
        shareId: "share-dm-1",
        connected: true,
      });
      // An already-ended participant row (owner revoked, or already left):
      // confirming Leave here would re-end a tombstone and promise a request
      // that, for an owner-revoked grant, can never appear.
      const ended = dm({
        channelId: "channel-dm-2",
        channelWireId: "wire-dm-2",
        role: "participant",
        shareId: "share-dm-2",
        connected: false,
      });
      bridgeMock.syncDms.mockResolvedValue({
        available: true,
        dms: [live, ended],
        pending: [],
        declined: [],
      });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      renderView();

      const items = await screen.findAllByTestId("chats-dm-item");
      await user.click(
        items.find((el) => el.getAttribute("data-channel-id") === "channel-dm-1")!,
      );
      await screen.findByTestId("chats-dm-view");
      expect(await screen.findByTestId("chats-dm-leave")).toBeTruthy();

      await user.click(screen.getByTestId("chats-dm-back"));
      const itemsAgain = await screen.findAllByTestId("chats-dm-item");
      await user.click(
        itemsAgain.find((el) => el.getAttribute("data-channel-id") === "channel-dm-2")!,
      );
      await screen.findByTestId("chats-dm-view");
      expect(screen.queryByTestId("chats-dm-leave")).toBeNull();
    });

    it("closes on Escape without navigating away or ending the row", async () => {
      const user = userEvent.setup();
      const participant = dm({ role: "participant", shareId: "share-dm-1" });
      bridgeMock.syncDms.mockResolvedValue({
        available: true,
        dms: [participant],
        pending: [],
        declined: [],
      });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      await user.click(await screen.findByTestId("chats-dm-leave"));
      await screen.findByTestId("chats-leave-dm-dialog");

      // The dialog auto-focuses Cancel, so Escape targets an element inside
      // its own marked subtree — the Chats root's onKeyDownCapture must skip
      // it (data-chat-escape-local), leaving the dialog's own handler to close it.
      await user.keyboard("{Escape}");

      expect(screen.queryByTestId("chats-leave-dm-dialog")).toBeNull();
      // Still on the DM: Escape closed the dialog, it did not walk the view
      // back the way the root's Escape handler otherwise would.
      expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
      expect(bridgeMock.leaveDm).not.toHaveBeenCalled();
    });

    it("clears a stale leave dialog on navigation away, so opening a different DM never shows it", async () => {
      const user = userEvent.setup();
      const leaving = dm({
        channelId: "channel-dm-1",
        channelWireId: "wire-dm-1",
        role: "participant",
        shareId: "share-dm-1",
      });
      const other = dm({
        channelId: "channel-dm-2",
        channelWireId: "wire-dm-2",
        threadId: "thread-dm-2",
      });
      bridgeMock.syncDms.mockResolvedValue({
        available: true,
        dms: [leaving, other],
        pending: [],
        declined: [],
      });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      renderView();

      const items = await screen.findAllByTestId("chats-dm-item");
      await user.click(
        items.find((el) => el.getAttribute("data-channel-id") === "channel-dm-1")!,
      );
      await screen.findByTestId("chats-dm-view");
      await user.click(await screen.findByTestId("chats-dm-leave"));
      await screen.findByTestId("chats-leave-dm-dialog");

      // Navigate away a path other than the dialog's own Escape/Cancel — the
      // header Back button — while the dialog is still open.
      await user.click(screen.getByTestId("chats-dm-back"));
      expect(screen.queryByTestId("chats-leave-dm-dialog")).toBeNull();

      const itemsAgain = await screen.findAllByTestId("chats-dm-item");
      await user.click(
        itemsAgain.find((el) => el.getAttribute("data-channel-id") === "channel-dm-2")!,
      );
      await screen.findByTestId("chats-dm-view");
      expect(screen.queryByTestId("chats-leave-dm-dialog")).toBeNull();
    });

    // An owner revocation mid-dialog leaves the
    // channelId unchanged, so the round-2 belt (keyed only on nav change)
    // would leave the confirmation open — confirming would re-end an
    // already-ended tombstone and promise a request that, for an
    // owner-revoked grant, can never appear.
    it("closes the confirmation the moment the record it was opened for loses connected", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const participant = dm({ role: "participant", shareId: "share-dm-1" });
        const revoked = { ...participant, connected: false };
        bridgeMock.syncDms
          .mockResolvedValueOnce({
            available: true,
            dms: [participant],
            pending: [],
            declined: [],
          })
          .mockResolvedValue({
            available: true,
            dms: [revoked],
            pending: [],
            declined: [],
          });
        bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
        renderView();
        await user.click(await screen.findByTestId("chats-dm-item"));
        await user.click(await screen.findByTestId("chats-dm-leave"));
        await screen.findByTestId("chats-leave-dm-dialog");

        // The per-open-DM refresh interval (refreshOpenDm, every 4s) is what
        // would deliver the owner's revocation while the dialog is open.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_000);
        });

        expect(screen.queryByTestId("chats-leave-dm-dialog")).toBeNull();
        expect(bridgeMock.leaveDm).not.toHaveBeenCalled();
        // Still on the DM — the revocation itself doesn't navigate away, it
        // only makes the conversation read-only.
        expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    // Leave during an in-flight send would end the row
    // before sendChatMessage's revalidation, whose rejection then gets
    // suppressed by goBack's context change — the message
    // vanishes with no warning. Confirm is disabled until the send settles,
    // so the user always sees either the message land or the existing
    // "Could not send" error, never silence.
    it("disables the leave confirm while a send is in flight for this DM, so the message can never silently vanish", async () => {
      const user = userEvent.setup();
      const participant = dm({ role: "participant", shareId: "share-dm-1" });
      bridgeMock.syncDms.mockResolvedValue({
        available: true,
        dms: [participant],
        pending: [],
        declined: [],
      });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
      let resolveSend!: (result: { message: ChatMessageRecord }) => void;
      const sendGate = new Promise<{ message: ChatMessageRecord }>((resolve) => {
        resolveSend = resolve;
      });
      bridgeMock.sendChatMessage.mockReturnValue(sendGate);
      renderView();
      await user.click(await screen.findByTestId("chats-dm-item"));
      await user.type(screen.getByTestId("chats-dm-composer"), "hello{Enter}");
      await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalled());

      await user.click(await screen.findByTestId("chats-dm-leave"));
      await screen.findByTestId("chats-leave-dm-dialog");
      await waitFor(() =>
        expect(
          (screen.getByTestId("chats-leave-dm-confirm") as HTMLButtonElement).disabled,
        ).toBe(true),
      );

      await user.click(screen.getByTestId("chats-leave-dm-confirm"));
      // Disabled: the click must not have reached leaveDm.
      expect(bridgeMock.leaveDm).not.toHaveBeenCalled();

      resolveSend({
        message: message({ id: "m-1", threadId: "thread-dm-1", body: "hello" }),
      });
      await waitFor(() =>
        expect(
          (screen.getByTestId("chats-leave-dm-confirm") as HTMLButtonElement).disabled,
        ).toBe(false),
      );
    });
  });

  it("keeps syncing an open pending DM until its thread arrives", async () => {
    const user = userEvent.setup();
    const pendingDm = dm({ threadId: null });
    const hydratedDm = dm();
    let resolveOpenSync!: (result: {
      available: boolean;
      dms: DmRecord[];
    }) => void;
    const openSync = new Promise<{ available: boolean; dms: DmRecord[] }>(
      (resolve) => {
        resolveOpenSync = resolve;
      },
    );
    const laterRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [pendingDm] })
      .mockImplementationOnce(() => openSync)
      .mockImplementation(() => laterRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({
          id: "message-dm-arrived",
          threadId: "thread-dm-1",
          body: "The conversation arrived",
        }),
      ],
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByTestId("chats-dm-waiting")).toBeTruthy();
    await waitFor(() => expect(bridgeMock.syncDms).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveOpenSync({ available: true, dms: [hydratedDm] });
      await openSync;
    });

    expect(await screen.findByText("The conversation arrived")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-waiting")).toBeNull();
    expect(bridgeMock.syncDms).toHaveBeenCalledTimes(2);
  });

  it("toggles reactions against the open DM thread", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm()] })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        message({
          id: "message-dm-reaction",
          threadId: "thread-dm-1",
          body: "React here",
        }),
      ],
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByText("React here")).toBeTruthy();
    await user.click(screen.getByTestId("chats-dm-add-reaction"));
    const thumbsUp = screen
      .getAllByTestId("chats-dm-reaction-choice")
      .find((button) => button.getAttribute("data-emoji") === "👍");
    expect(thumbsUp).toBeTruthy();
    await user.click(thumbsUp!);

    await waitFor(() =>
      expect(bridgeMock.setChatReaction).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-dm-1",
        messageId: "message-dm-reaction",
        emoji: "👍",
        state: "added",
      }),
    );
  });

  it("drops older DM refreshes after a newer snapshot and local send", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({ available: true, dms: [dm()] })
      .mockImplementation(() => pendingRefresh);

    let resolveOlder!: (result: { messages: ChatMessageRecord[] }) => void;
    let resolveNewer!: (result: { messages: ChatMessageRecord[] }) => void;
    const older = new Promise<{ messages: ChatMessageRecord[] }>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<{ messages: ChatMessageRecord[] }>((resolve) => {
      resolveNewer = resolve;
    });
    bridgeMock.listChatMessages
      .mockResolvedValueOnce({
        messages: [
          message({
            id: "message-dm-baseline",
            threadId: "thread-dm-1",
            body: "Baseline",
          }),
        ],
      })
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({
        id: "message-dm-local",
        threadId: "thread-dm-1",
        body: "Local send",
      }),
    });

    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByText("Baseline")).toBeTruthy();

    act(() => emitWorkspaceActivity());
    act(() => emitWorkspaceActivity());
    await waitFor(() =>
      expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(3),
    );
    await act(async () => {
      resolveNewer({
        messages: [
          message({
            id: "message-dm-newer",
            threadId: "thread-dm-1",
            body: "Newer snapshot",
          }),
        ],
      });
      await newer;
    });
    expect(await screen.findByText("Newer snapshot")).toBeTruthy();

    await user.type(screen.getByTestId("chats-dm-composer"), "Local send{Enter}");
    await waitFor(() => expect(screen.getByText("Local send")).toBeTruthy());

    await act(async () => {
      resolveOlder({
        messages: [
          message({
            id: "message-dm-stale",
            threadId: "thread-dm-1",
            body: "Stale snapshot",
          }),
        ],
      });
      await older;
    });

    expect(screen.queryByText("Stale snapshot")).toBeNull();
    expect(
      screen.getAllByTestId("chats-dm-message-body").map((node) => node.textContent),
    ).toEqual(["Newer snapshot", "Local send"]);
  });

  it("starts a new DM from the recipient step and opens the conversation", async () => {
    const user = userEvent.setup();
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [] });
    bridgeMock.startDm.mockResolvedValue({
      dm: dm(),
      message: message({ id: "m-1", threadId: "thread-dm-1", body: "hello there" }),
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ id: "m-1", threadId: "thread-dm-1", body: "hello there" })],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-new-dm"));
    await user.type(screen.getByTestId("chats-dm-recipients"), "bob@example.com");
    const composer = screen.getByTestId("chats-dm-new-composer");
    fireEvent.change(composer, {
      target: { value: "hello there @[docs/plan.md#scope]" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(bridgeMock.startDm).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        recipients: "bob@example.com",
        body: "hello there @[docs/plan.md#scope]",
        fileReferences: [{ path: "docs/plan.md", headingAnchor: "scope" }],
      }),
    );
    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    const bodies = await screen.findAllByTestId("chats-dm-message-body");
    expect(bodies.map((el) => el.textContent)).toEqual(["hello there"]);
  });

  it("clears a stale recipient/draft when backing out of New message and reopening it", async () => {
    // Backing out of compose without sending must not leave the old recipients
    // pre-filled — a user who reopens compose and types + sends could otherwise
    // misdirect their message to the wrong person.
    const user = userEvent.setup();
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [] });
    renderView();
    await user.click(await screen.findByTestId("chats-new-dm"));
    await user.type(screen.getByTestId("chats-dm-recipients"), "stale@example.com");
    expect((screen.getByTestId("chats-dm-recipients") as HTMLInputElement).value).toBe(
      "stale@example.com",
    );
    // Back out, then reopen: the "To:" field must be empty again.
    await user.click(screen.getByTestId("chats-dm-new-back"));
    await user.click(await screen.findByTestId("chats-new-dm"));
    expect((screen.getByTestId("chats-dm-recipients") as HTMLInputElement).value).toBe("");
  });

  it("closes the composer for an ended DM but keeps the conversation readable", async () => {
    const user = userEvent.setup();
    const pendingRefresh = new Promise<never>(() => undefined);
    bridgeMock.syncDms
      .mockResolvedValueOnce({
        available: true,
        dms: [
          dm({
            role: "participant",
            peerLabel: "alice@example.com",
            connected: false,
            unreadCount: 2,
          }),
        ],
      })
      .mockImplementation(() => pendingRefresh);
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ id: "m-1", threadId: "thread-dm-1", body: "old message" })],
    });
    renderView();
    await user.click(await screen.findByTestId("chats-dm-item"));
    expect(await screen.findByTestId("chats-dm-ended")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-composer")).toBeNull();
    const bodies = await screen.findAllByTestId("chats-dm-message-body");
    expect(bodies.map((el) => el.textContent)).toEqual(["old message"]);
    expect(bridgeMock.markChatThreadRead).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("chats-dm-back"));
    expect((await screen.findByTestId("chats-dm-unread")).textContent).toBe("2");
  });
});
