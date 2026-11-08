// @vitest-environment jsdom
import "../../testing/legendListMock";
// Collection dependencies read these observers during module evaluation.
// Preload them before tests so an unfinished import cannot clean up a later test's globals.
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] { return []; }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
});
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, FileChatThreadRecord, WorkspaceUiState } from "../../ipc/bridgeContract";
import {
  SHARE_VIEW,
  WORKSPACE,
  STORED_STATE,
  STORED_CHATS_STATE,
  makeBridge,
  renderShell,
} from "../DesktopWorkspaceShell.testHarness";
// The shell loads Chats and the open b.md tab's read view and editor lazily.
// Load them here so their first import does not count against a test's wait.
import "../workbench/ChatsView";
import "../markdown/IncrementalMarkdownDocument";
import "../editor/MarkdownEditor";

function channel(id: string, name: string, createdAtMs: number) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    kind: "channel" as const,
    createdAtMs,
    updatedAtMs: createdAtMs,
    threadCount: 0,
    unreadCount: 0,
  };
}

function bridgeWithChannels(state: WorkspaceUiState | null) {
  const bridge = makeBridge(Promise.resolve(state));
  bridge.listChatChannels.mockResolvedValue({
    channels: [channel("channel-1", "General", 1_700_000_000_000), channel("channel-2", "random", 1_700_000_000_001)],
    fileThreads: [],
  });
  Object.assign(bridge, { listChatChannelShares: vi.fn(async () => ({ joined: [], sessionKey: null, relay: { state: "answered", granted: [], received: [], removed: [] } })) });
  return bridge;
}

function lastStoredState(bridge: ReturnType<typeof makeBridge>): WorkspaceUiState | undefined {
  const calls = bridge.setWorkspaceUiState.mock.calls as unknown as [{ state: WorkspaceUiState }][];
  return calls.at(-1)?.[0].state;
}

describe("Chats in the left side panel", () => {
  it.each(["resolution failure", "deleted file"])("opens the file-chat path after %s", async outcome => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(STORED_CHATS_STATE));
    const path = outcome === "deleted file" ? "deleted.md" : "b.md";
    const thread: FileChatThreadRecord = {
      id: "file-thread", title: "File discussion", createdAtMs: 1, updatedAtMs: 2,
      path,
    };
    const message: ChatMessageRecord = {
      presentation: { group: "file-author", hue: null, self: false },
      id: "file-message", threadId: thread.id, authorKind: "human", authorDisplayName: "You",
      body: "Discuss this file", createdAtMs: 1,
    };
    bridge.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [thread] });
    Object.assign(bridge, {
      listPersonalChatFeed: vi.fn(async () => ({ items: [{
        message,
        thread: { id: thread.id, title: thread.title, createdAtMs: 1, updatedAtMs: 2 },
        channel: null, reactions: [],
      }], nextCursor: null })),
    });
    if (outcome === "deleted file") bridge.readWorkspaceText.mockRejectedValue(new Error("File not found"));
    renderShell(bridge);
    await user.click(await screen.findByTestId("chats-feed-link"));
    const item = await screen.findByTestId("chats-feed-item");
    bridge.readWorkspaceText.mockClear();
    await user.click(within(item).getByRole("button", { name: /Discuss this file/ }));
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({ relativePath: path })));
  });

  it("selects Chats from the rail beside Files, and stores the choice", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const rail = await screen.findByTestId("activity-bar");
    const items = within(rail).getAllByRole("button").map((button) => button.dataset.testid);
    expect(items.slice(0, 2)).toEqual(["activity-explorer", "activity-chats"]);
    const chats = screen.getByTestId("activity-chats");
    expect(chats.getAttribute("aria-label")).toBe("Chats");

    await user.click(chats);
    const panel = screen.getByTestId("side-panel");
    expect(await within(panel).findByTestId("chats-view")).toBeTruthy();
    expect(within(panel).getByText("Chats")).toBeTruthy();
    expect(chats.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByTestId("file-tree")).toBeNull();
    await waitFor(() => expect(lastStoredState(bridge)?.activeView).toBe("chats"));

    // Choosing Chats again hides the panel, as every rail view does.
    await user.click(chats);
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("restores Chats as the selected view after a restart", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_CHATS_STATE));
    renderShell(bridge);

    const panel = await screen.findByTestId("side-panel");
    expect(await within(panel).findByTestId("chats-view")).toBeTruthy();
    expect(screen.getByTestId("activity-chats").getAttribute("aria-current")).toBe("page");
    // The About rail is its own surface beside it.
    expect(within(screen.getByTestId("about-rail")).queryByTestId("chats-view")).toBeNull();
  });

  it("reaches the chat list from the keyboard", async () => {
    const bridge = bridgeWithChannels(null);
    const user = userEvent.setup();
    renderShell(bridge);

    const chats = await screen.findByTestId("activity-chats");
    chats.focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByTestId("side-panel");
    const [first] = await within(panel).findAllByTestId("chats-channel");
    // Tab walks the rest of the rail, then the panel header, then the list.
    for (let step = 0; step < 40 && document.activeElement !== first; step += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(first);
    await user.keyboard("{Enter}");
    const tab = await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-1")}`);
    expect(tab.dataset.active).toBe("true");
  });

  it("opens a clicked channel in the Chats tab and keeps the list as the navigator", async () => {
    const bridge = bridgeWithChannels(null);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("activity-chats"));
    const panel = await screen.findByTestId("side-panel");
    const channelButtons = await within(panel).findAllByTestId("chats-channel");
    expect(channelButtons).toHaveLength(2);
    await user.click(channelButtons[0]!);

    // The list is a navigator: the channel opens in the Chats tab and the
    // list stays.
    const tab = await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-1")}`);
    expect(tab.dataset.active).toBe("true");
    expect(tab.textContent).toContain("General");
    const channelView = await screen.findByTestId("chats-channel-view");
    expect(channelView.dataset.variant).toBe("page");
    expect(within(channelView).queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.keyDown(channelView, { key: "Escape" });
    expect(screen.getByTestId("chats-channel-view")).toBe(channelView);
    expect(document.querySelector('main [data-testid="chats-view"]')).toBeNull();
    expect(within(panel).queryByTestId("chats-channel-view")).toBeNull();
    expect(within(panel).getAllByTestId("chats-channel")).toHaveLength(2);
    expect(bridge.listChannelThreads).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      channelId: "channel-1",
    });

    await user.type(screen.getByTestId("chats-new-thread-composer"), "General draft");
    await user.click(within(panel).getAllByTestId("chats-channel")[1]!);
    await waitFor(() => {
      expect(screen.getByTestId("chats-channel-title").textContent).toBe("random");
    });
    expect(tab.textContent).toContain("General");
    expect(screen.getByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-2")}`).textContent).toContain("random");
    expect(within(panel).queryByTestId("chats-channel-view")).toBeNull();
    await user.type(screen.getByTestId("chats-new-thread-composer"), "Random draft");
    await user.click(within(panel).getByTestId("chats-feed-link"));
    await screen.findByTestId("chats-personal-feed");
    expect(screen.getByTestId("tab-dohc://chats").textContent).toContain("Home");
    await user.click(within(panel).getAllByTestId("chats-channel")[0]!);
    await waitFor(() => expect((screen.getByTestId("chats-new-thread-composer") as HTMLTextAreaElement).value).toBe("General draft"));
    await user.click(within(panel).getAllByTestId("chats-channel")[1]!);
    await waitFor(() => expect((screen.getByTestId("chats-new-thread-composer") as HTMLTextAreaElement).value).toBe("Random draft"));
    expect(screen.getAllByTestId(/^tab-dohc:\/\/chats/)).toHaveLength(3);
  });

  it("reads and polls nothing while another view is selected", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await screen.findByTestId("file-tree");
    // Workspace activity is what drives the list's refreshes.
    act(() => bridge.emitWorkspaceActivity());
    await act(async () => {});
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("activity-chats"));
    await within(screen.getByTestId("side-panel")).findByTestId("chats-view");
    await waitFor(() => expect(bridge.listChatChannels).toHaveBeenCalled());
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Back to Files: the list unmounts, so activity reaches nothing of it.
    await user.click(screen.getByTestId("activity-explorer"));
    await screen.findByTestId("file-tree");
    expect(screen.queryByTestId("chats-view")).toBeNull();
    const channelReads = bridge.listChatChannels.mock.calls.length;
    const dmSyncs = bridge.syncDms.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await act(async () => {});
    expect(bridge.listChatChannels.mock.calls.length).toBe(channelReads);
    expect(bridge.syncDms.mock.calls.length).toBe(dmSyncs);
  });

  it("shows Chats from View > Chats and the palette, and never hides it from there", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_CHATS_STATE));
    const user = userEvent.setup();
    renderShell(bridge);
    const panel = await screen.findByTestId("side-panel");
    await within(panel).findByTestId("chats-view");
    await act(async () => {});

    act(() => bridge.emitMenuCommand("show-chats"));
    await act(async () => {});
    expect(within(screen.getByTestId("side-panel")).getByTestId("chats-view")).toBeTruthy();

    await user.keyboard("{Control>}k{/Control}");
    await user.click(within(await screen.findByTestId("command-palette")).getByText("View: Chats"));
    expect(within(screen.getByTestId("side-panel")).getByTestId("chats-view")).toBeTruthy();

    // From Files, the same command switches to Chats.
    await user.click(screen.getByTestId("activity-explorer"));
    await screen.findByTestId("file-tree");
    act(() => bridge.emitMenuCommand("show-chats"));
    expect(await within(screen.getByTestId("side-panel")).findByTestId("chats-view")).toBeTruthy();
    // The rail's own button still toggles.
    await user.click(screen.getByTestId("activity-chats"));
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("stops reading while Files shows and reloads the list once on return; open conversations stay", async () => {
    const bridge = bridgeWithChannels(STORED_STATE);
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    await user.click(screen.getByTestId("activity-chats"));
    const panel = screen.getByTestId("side-panel");
    await within(panel).findAllByTestId("chats-channel");
    await user.click(within(panel).getAllByTestId("chats-channel")[0]!);
    const tab = await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-1")}`);
    // A half-typed group name is the list's own state.
    await user.click(within(panel).getByTestId("chats-new-channel"));
    await user.type(within(panel).getByTestId("chats-new-channel-name"), "draft group");
    // Back to the document, so no conversation page reads either.
    await user.click(screen.getByTestId("tab-b.md"));
    await act(async () => {});
    const firstOpen = bridge.listChatChannels.mock.calls.length;

    await user.click(screen.getByTestId("activity-explorer"));
    await screen.findByTestId("file-tree");
    act(() => bridge.emitWorkspaceActivity());
    await act(async () => {});
    expect(bridge.listChatChannels.mock.calls.length).toBe(firstOpen);

    await user.click(screen.getByTestId("activity-chats"));
    await within(screen.getByTestId("side-panel")).findAllByTestId("chats-channel");
    await waitFor(() => expect(bridge.listChatChannels.mock.calls.length).toBe(firstOpen + 1));
    // The conversation tab lives in the editor and survives; the list
    // remounts, so its unsent group form starts over.
    expect(screen.getByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-1")}`).textContent).toBe(tab.textContent);
    expect(screen.queryByTestId("chats-new-channel-name")).toBeNull();
  });

  it("customizes chats from the panel menu while Chats is selected", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_CHATS_STATE));
    const user = userEvent.setup();
    renderShell(bridge);

    const panel = await screen.findByTestId("side-panel");
    await within(panel).findByTestId("chats-view");
    expect(within(panel).getByTestId("chats-open-tab")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Sidebar actions" }));
    expect(screen.getByRole("menuitem", { name: "Customize…" })).toBeTruthy();
  });

  it("offers no Chats view on a shared view's rail", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge, SHARE_VIEW);
    await screen.findByTestId("activity-explorer");
    expect(screen.queryByTestId("activity-chats")).toBeNull();
  });
});
