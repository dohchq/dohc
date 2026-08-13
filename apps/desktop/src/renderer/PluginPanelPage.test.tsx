// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { DOHC_SDK_PROTOCOL } from "@dohc/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InvokePluginPanelSdkResult,
  StartPluginPanelResult,
} from "../ipc/bridgeContract";
import { PluginPanelPage } from "./PluginPanelPage";

const bridgeMock = {
  startPluginPanel: vi.fn(async (): Promise<StartPluginPanelResult> => ({
    url: "http://127.0.0.1:49160/",
    title: "Hello",
  })),
  stopPluginPanel: vi.fn(async () => undefined),
  invokePluginPanelSdk: vi.fn(
    async (): Promise<InvokePluginPanelSdkResult> => ({
      result: { text: "Plugin data" },
    }),
  ),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function sdkMessage(
  source: Window,
  origin = "http://127.0.0.1:49160",
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source,
      data: {
        protocol: DOHC_SDK_PROTOCOL,
        id: "request-1",
        method: "files.read",
        params: { path: "notes.txt" },
      },
    }),
  );
}

describe("PluginPanelPage", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts the panel and embeds its loopback URL with the required sandbox", async () => {
    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );

    const frame = await screen.findByTestId("plugin-panel-frame");
    expect(bridgeMock.startPluginPanel).toHaveBeenCalledWith({
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
    });
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-forms allow-same-origin allow-scripts",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const url = new URL(frame.getAttribute("src") ?? "");
    expect(url.origin).toBe("http://127.0.0.1:49160");
    expect(url.searchParams.get("dohcHostOrigin")).toBe(window.location.origin);
  });

  it("stops the panel when the page unmounts", async () => {
    const view = render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );
    await screen.findByTestId("plugin-panel-frame");
    view.unmount();
    expect(bridgeMock.stopPluginPanel).toHaveBeenCalledWith({
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
    });
  });

  it("answers SDK requests only from the active frame and exact origin", async () => {
    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );
    const frame = (await screen.findByTestId(
      "plugin-panel-frame",
    )) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    const wrongSource = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    sdkMessage(wrongSource);
    sdkMessage(source, "http://127.0.0.1:49161");
    expect(bridgeMock.invokePluginPanelSdk).not.toHaveBeenCalled();

    sdkMessage(source);
    await vi.waitFor(() => {
      expect(bridgeMock.invokePluginPanelSdk).toHaveBeenCalledWith({
        workspaceId: "ws-plugins",
        pluginId: "hello-plugin",
        panelId: "main",
        method: "files.read",
        params: { path: "notes.txt" },
      });
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        protocol: DOHC_SDK_PROTOCOL,
        id: "request-1",
        ok: true,
        result: { text: "Plugin data" },
      },
      "http://127.0.0.1:49160",
    );
  });

  it("drops an SDK response after the panel context changes", async () => {
    const pending = deferred<InvokePluginPanelSdkResult>();
    bridgeMock.invokePluginPanelSdk.mockReturnValueOnce(pending.promise);
    const view = render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );
    const frame = (await screen.findByTestId(
      "plugin-panel-frame",
    )) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });
    sdkMessage(source);
    await vi.waitFor(() =>
      expect(bridgeMock.invokePluginPanelSdk).toHaveBeenCalledTimes(1),
    );

    bridgeMock.startPluginPanel.mockResolvedValueOnce({
      url: "http://127.0.0.1:49161/",
      title: "Other",
    });
    view.rerender(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="other"
      />,
    );
    await screen.findByTitle("Other");
    await act(async () => {
      pending.resolve({ result: { text: "stale" } });
      await pending.promise;
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("shows start failures and refuses non-loopback panel URLs", async () => {
    bridgeMock.startPluginPanel.mockRejectedValueOnce(
      new Error("Plugin panel entry was not found."),
    );
    const first = render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );
    expect(await screen.findByText("Plugin panel entry was not found.")).toBeTruthy();
    expect(screen.getByText("Close this tab and try again.")).toBeTruthy();
    first.unmount();

    bridgeMock.startPluginPanel.mockResolvedValueOnce({
      url: "https://example.com/",
      title: "Remote",
    });
    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="remote"
      />,
    );
    expect(
      await screen.findByText("The plugin panel URL must use loopback HTTP."),
    ).toBeTruthy();
    expect(screen.queryByTestId("plugin-panel-frame")).toBeNull();
  });
});
