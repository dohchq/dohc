// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SetPluginWebAppBoundsPayload,
  StartPluginWebAppResult,
} from "../ipc/bridgeContract";
import { PluginWebAppPage } from "./PluginWebAppPage";

const bridgeMock = {
  startPluginWebApp: vi.fn(async (): Promise<StartPluginWebAppResult> => ({
    status: "ok",
    title: "T3 Code",
    origin: "http://127.0.0.1:49160",
  })),
  setPluginWebAppBounds: vi.fn(
    async (_payload: SetPluginWebAppBoundsPayload) => undefined,
  ),
  stopPluginWebApp: vi.fn(async () => undefined),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const RECT = {
  x: 10,
  y: 20,
  width: 640,
  height: 480,
  top: 20,
  left: 10,
  right: 650,
  bottom: 500,
  toJSON: () => ({}),
} as DOMRect;

describe("PluginWebAppPage", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", bridgeMock);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("starts the app, shows the starting state, then reports its placeholder bounds", async () => {
    const start = deferred<StartPluginWebAppResult>();
    bridgeMock.startPluginWebApp.mockReturnValueOnce(start.promise);

    render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );

    expect(screen.getByTestId("plugin-web-app-starting")).toBeTruthy();
    expect(bridgeMock.startPluginWebApp).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "t3-code",
      webAppId: "app",
    });

    await act(async () => {
      start.resolve({
        status: "ok",
        title: "T3 Code",
        origin: "http://127.0.0.1:49160",
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId("plugin-web-app-frame")).toBeTruthy();
    expect(screen.getByText("T3 Code")).toBeTruthy();
    expect(bridgeMock.setPluginWebAppBounds).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "t3-code",
      webAppId: "app",
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      visible: true,
    });
  });

  it("reports the guest hidden while an overlay covers it, and visible again after", async () => {
    const lastReport = () =>
      bridgeMock.setPluginWebAppBounds.mock.calls.at(-1)?.[0];
    const view = render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );
    await screen.findByTestId("plugin-web-app-frame");
    expect(lastReport()?.visible).toBe(true);

    // MUTATION (ignore the overlay signal): the guest keeps compositing over
    // the dialog and keeps the clicks aimed at it.
    await act(async () => {
      view.rerender(
        <PluginWebAppPage
          workspaceId="ws-1"
          pluginId="t3-code"
          webAppId="app"
          hiddenByOverlay
        />,
      );
      await Promise.resolve();
    });
    expect(lastReport()?.visible).toBe(false);
    // The placeholder has not moved: only visibility changed.
    expect(lastReport()?.bounds).toEqual({ x: 10, y: 20, width: 640, height: 480 });

    await act(async () => {
      view.rerender(
        <PluginWebAppPage
          workspaceId="ws-1"
          pluginId="t3-code"
          webAppId="app"
          hiddenByOverlay={false}
        />,
      );
      await Promise.resolve();
    });
    expect(lastReport()?.visible).toBe(true);
  });

  it("never receives the guest URL: the start result carries only title and origin", async () => {
    render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );
    await screen.findByTestId("plugin-web-app-frame");
    const results = await Promise.all(
      bridgeMock.startPluginWebApp.mock.results.map((entry) => entry.value),
    );
    for (const result of results) {
      expect(Object.keys(result as object).sort()).toEqual([
        "origin",
        "status",
        "title",
      ]);
    }
  });

  it("drops a start response that resolves after unmount and stops the app", async () => {
    const start = deferred<StartPluginWebAppResult>();
    bridgeMock.startPluginWebApp.mockReturnValueOnce(start.promise);
    const { unmount } = render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );

    unmount();
    await act(async () => {
      start.resolve({
        status: "ok",
        title: "T3 Code",
        origin: "http://127.0.0.1:49160",
      });
      await Promise.resolve();
    });

    expect(bridgeMock.setPluginWebAppBounds).not.toHaveBeenCalled();
    expect(bridgeMock.stopPluginWebApp).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "t3-code",
      webAppId: "app",
    });
  });

  it("never paints one app's slow start onto another app's mounted tab", async () => {
    const slowStart = deferred<StartPluginWebAppResult>();
    const laterStart = deferred<StartPluginWebAppResult>();
    bridgeMock.startPluginWebApp
      .mockReturnValueOnce(slowStart.promise)
      .mockReturnValueOnce(laterStart.promise);
    const view = render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );

    view.rerender(
      <PluginWebAppPage workspaceId="ws-2" pluginId="t3-code" webAppId="app" />,
    );
    await act(async () => {
      slowStart.resolve({
        status: "ok",
        title: "Stale App",
        origin: "http://127.0.0.1:1",
      });
      await Promise.resolve();
    });

    // The slow response belongs to the previous mount context: the tab must
    // stay in its starting state and report no bounds for it.
    expect(screen.getByTestId("plugin-web-app-starting")).toBeTruthy();
    expect(screen.queryByText("Stale App")).toBeNull();
    expect(bridgeMock.setPluginWebAppBounds).not.toHaveBeenCalled();

    await act(async () => {
      laterStart.resolve({
        status: "ok",
        title: "Live App",
        origin: "http://127.0.0.1:2",
      });
      await Promise.resolve();
    });
    expect(screen.getByText("Live App")).toBeTruthy();
  });

  it("shows the unavailable state when the plugin is not registered", async () => {
    bridgeMock.startPluginWebApp.mockResolvedValueOnce({
      status: "not-registered",
    });
    render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );
    await screen.findByTestId("plugin-web-app-unavailable");
    expect(bridgeMock.setPluginWebAppBounds).not.toHaveBeenCalled();
  });

  it("shows the start error and the retry instruction", async () => {
    bridgeMock.startPluginWebApp.mockRejectedValueOnce(
      new Error("The t3 server did not become ready within the 60000 ms readiness deadline."),
    );
    render(
      <PluginWebAppPage workspaceId="ws-1" pluginId="t3-code" webAppId="app" />,
    );
    const error = await screen.findByTestId("plugin-web-app-error");
    expect(error.textContent).toContain("60000 ms");
    expect(error.textContent).toContain("Close this tab and try again.");
  });
});
