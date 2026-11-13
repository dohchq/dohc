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
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUiState } from "../../ipc/bridgeContract";
import { WORKSPACE, makeBridge, renderShell } from "../DesktopWorkspaceShell.testHarness";
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


describe("Chats in the left side panel", () => {

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

});
