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
import {
  WORKSPACE,
  STORED_STATE,
  makeBridge,
  renderShell,
} from "../DesktopWorkspaceShell.testHarness";

describe("chats panel (right side)", () => {
  it("toggles from the titlebar and hides entirely when collapsed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    // Hidden by default (VS Code secondary-sidebar grammar).
    await screen.findByText("a.md");
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    expect(screen.queryByTestId("activity-chats")).toBeNull();

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();

    await user.click(screen.getByTestId("chats-panel-collapse"));
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    // Collapsed means gone — no 36px stub squatting on the right edge.
    expect(screen.queryByTestId("history-restore")).toBeNull();

    await user.click(screen.getByTestId("titlebar-chats-sidebar"));
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
  });

  it("opens a clicked channel in the Chats tab and keeps the panel as the navigator", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listChatChannels.mockResolvedValue({
      channels: [
        {
          id: "channel-1",
          name: "General",
          slug: "general",
          kind: "channel" as const,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          threadCount: 0,
          unreadCount: 0,
        },
        {
          id: "channel-2",
          name: "random",
          slug: "random",
          kind: "channel" as const,
          createdAtMs: 1_700_000_000_001,
          updatedAtMs: 1_700_000_000_001,
          threadCount: 0,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    });
    Object.assign(bridge, { listChatChannelShares: vi.fn(async () => ({ joined: [], sessionKey: null, relay: { state: "answered", granted: [], received: [], removed: [] } })) });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    const panel = await screen.findByTestId("chats-panel");
    const channelButtons = await within(panel).findAllByTestId("chats-channel");
    expect(channelButtons).toHaveLength(2);
    await user.click(channelButtons[0]!);

    // The panel is a navigator: the channel opens in the Chats tab and the
    // panel keeps its list.
    const tab = await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-1")}`);
    expect(tab.dataset.active).toBe("true");
    expect(tab.textContent).toContain("#General");
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
    expect(tab.textContent).toContain("#General");
    expect(screen.getByTestId(`tab-dohc://chats/channel/${encodeURIComponent("channel-2")}`).textContent).toContain("#random");
    expect(within(panel).queryByTestId("chats-channel-view")).toBeNull();
    expect(bridge.listChannelThreads).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      channelId: "channel-2",
    });
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

  it("restores the stored width and can be resized from its left edge", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const panel = await screen.findByTestId("chats-panel");
    expect(panel.style.width).toBe("360px");
    Object.defineProperty(panel, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 640,
        y: 0,
        left: 640,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 360,
        height: 800,
        toJSON: () => {},
      }),
    });

    const handle = screen.getByTestId("chats-panel-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 100, pointerId: 1 });

    await waitFor(() => {
      expect(panel.style.width).toBe("900px");
    });
  });

  it("exposes the chats resize separator to keyboard users", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const panel = await screen.findByTestId("chats-panel");
    const handle = screen.getByTestId("chats-panel-resize");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("2400");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    await waitFor(() => expect(panel.style.width).toBe("376px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("376");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    await waitFor(() => expect(panel.style.width).toBe("360px"));

    fireEvent.keyDown(handle, { key: "PageUp" });
    await waitFor(() => expect(panel.style.width).toBe("488px"));
    fireEvent.keyDown(handle, { key: "PageDown" });
    await waitFor(() => expect(panel.style.width).toBe("360px"));
    fireEvent.keyDown(handle, { key: "Home" });
    await waitFor(() => expect(panel.style.width).toBe("240px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.keyDown(handle, { key: "End" });
    await waitFor(() => expect(panel.style.width).toBe("2400px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("2400");
  });

  it("the 'This file' tab shows the active file's chats surface", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    await screen.findByTestId("chats-panel");
    await user.click(screen.getByTestId("chats-panel-tab-file"));

    // No file open yet: the linked-chats surface says so honestly.
    expect(
      (await screen.findByTestId("linked-chats-empty")).textContent,
    ).toContain("No file open");
  });
});
