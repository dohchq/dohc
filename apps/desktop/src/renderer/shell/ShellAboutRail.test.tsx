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
import {
  WORKSPACE,
  STORED_STATE,
  makeBridge,
  renderShell,
} from "../DesktopWorkspaceShell.testHarness";

describe("About rail (right side)", () => {
  it("toggles from the titlebar and Ctrl+Alt+B, and hides entirely when collapsed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    // Hidden by default (VS Code secondary-sidebar grammar).
    await screen.findByText("a.md");
    expect(screen.queryByTestId("about-rail")).toBeNull();

    const toggle = await screen.findByTestId("titlebar-about-sidebar");
    expect(toggle.getAttribute("aria-label")).toBe("Toggle About");
    await user.click(toggle);
    const rail = await screen.findByTestId("about-rail");
    expect(rail.getAttribute("aria-label")).toBe("About");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await user.click(toggle);
    expect(screen.queryByTestId("about-rail")).toBeNull();

    // Ctrl+Alt+B is VS Code's secondary-sidebar chord.
    await act(async () => {});
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(await screen.findByTestId("about-rail")).toBeTruthy();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    await waitFor(() => expect(screen.queryByTestId("about-rail")).toBeNull());
  });

  it("shows About only: no chat list and no tabs", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect(await within(rail).findByTestId("about-header")).toBeTruthy();
    expect(within(rail).queryByTestId("chats-view")).toBeNull();
    expect(rail.querySelector('[data-testid^="chats-panel"]')).toBeNull();
    expect(within(rail).queryByRole("button", { name: "About" })).toBeNull();
    expect(screen.queryByTestId("chats-open-tab")).toBeNull();
  });

  it("restores the stored width and can be resized from its left edge", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect(rail.style.width).toBe("360px");
    Object.defineProperty(rail, "getBoundingClientRect", {
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

    const handle = screen.getByTestId("about-rail-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 100, pointerId: 1 });

    await waitFor(() => {
      expect(rail.style.width).toBe("900px");
    });
  });

  it("exposes the About resize separator to keyboard users", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    const handle = screen.getByTestId("about-rail-resize");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-label")).toBe("Resize About");
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("2400");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    await waitFor(() => expect(rail.style.width).toBe("376px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("376");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    await waitFor(() => expect(rail.style.width).toBe("360px"));

    fireEvent.keyDown(handle, { key: "PageUp" });
    await waitFor(() => expect(rail.style.width).toBe("488px"));
    fireEvent.keyDown(handle, { key: "PageDown" });
    await waitFor(() => expect(rail.style.width).toBe("360px"));
    fireEvent.keyDown(handle, { key: "Home" });
    await waitFor(() => expect(rail.style.width).toBe("240px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.keyDown(handle, { key: "End" });
    await waitFor(() => expect(rail.style.width).toBe("2400px"));
    expect(handle.getAttribute("aria-valuenow")).toBe("2400");
  });

  it("says what it shows once a file is open", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("titlebar-about-sidebar"));
    await screen.findByTestId("about-rail");

    // No file open yet: About says so honestly.
    expect(
      (await screen.findByTestId("linked-chats-empty")).textContent,
    ).toBe("Open a file to see its chats, history, and access.");
  });

  it("shows the open file's chats and History, and reads access only when opened", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.listFileChats.mockResolvedValue({ fileObjectId: "object-a", threads: [] });
    const getObjectAccess = vi.fn(async () => ({
      ref: { kind: "path" as const, path: "b.md", versionId: null },
      rows: [],
      visibility: "visible" as const,
      coverage: { kind: "granted" as const, complete: true, observation: "interval" as const },
      checkedAtMs: 1_700_000_000_000,
      freshness: "fresh" as const,
      nextCursor: null,
    }));
    const requestAccessRefresh = vi.fn(async () => undefined);
    Object.assign(bridge, { getObjectAccess, requestAccessRefresh });
    const user = userEvent.setup();
    renderShell(bridge);

    const rail = await screen.findByTestId("about-rail");
    expect((await within(rail).findByTestId("about-header")).textContent).toBe("b.md");
    await within(rail).findByTestId("about-history");
    await waitFor(() =>
      expect(bridge.listEngineMoments).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        objectId: "object-a",
        limit: 5,
      }),
    );
    expect(getObjectAccess).not.toHaveBeenCalled();
    expect(requestAccessRefresh).not.toHaveBeenCalled();

    await user.click(within(rail).getByTestId("about-access-toggle"));
    expect((await within(rail).findByTestId("about-access-empty")).textContent).toBe(
      "No share from this workspace includes this file.",
    );
    expect(requestAccessRefresh).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, reason: "access-expand" });
  });
});
