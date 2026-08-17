// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { DOHC_SDK_PROTOCOL, DOHC_THEME_PROTOCOL } from "@dohc/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InvokePluginPanelSdkResult,
  StartPluginPanelResult,
} from "../ipc/bridgeContract";
import { PluginPanelPage } from "./PluginPanelPage";
import { THEME_ATTRIBUTES } from "./pluginPanelTheme";
import { palette } from "./tokens";

const bridgeMock = {
  startPluginPanel: vi.fn(async (): Promise<StartPluginPanelResult> => ({
    status: "ok",
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
  method = "files.read",
  params: unknown = { path: "notes.txt" },
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source,
      data: {
        protocol: DOHC_SDK_PROTOCOL,
        id: "request-1",
        method,
        params,
      },
    }),
  );
}

function uiOpenMessage(source: Window, origin = "http://127.0.0.1:49160") {
  sdkMessage(source, origin, "ui.open", { target: "notes/today.md" });
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

  it("opens the target a panel asked for through ui.open", async () => {
    const onOpenPath = vi.fn();
    bridgeMock.invokePluginPanelSdk.mockResolvedValueOnce({
      result: { target: "notes/today.md" },
    });
    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
        onOpenPath={onOpenPath}
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

    uiOpenMessage(source);
    await vi.waitFor(() =>
      expect(onOpenPath).toHaveBeenCalledWith("notes/today.md"),
    );
    expect(onOpenPath).toHaveBeenCalledTimes(1);
  });

  // A panel is the only caller that can name an instance, so this hand-off is
  // the whole open path for a per-instance web app.
  it("opens the web app instance a panel asked for through ui.openWebApp", async () => {
    const onOpenWebApp = vi.fn();
    bridgeMock.invokePluginPanelSdk.mockResolvedValueOnce({
      result: { webAppId: "preview", instanceKey: "sites/marketing" },
    });
    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
        onOpenWebApp={onOpenWebApp}
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

    sdkMessage(source, "http://127.0.0.1:49160", "ui.openWebApp", {
      webAppId: "preview",
      instanceKey: "sites/marketing",
    });
    // MUTATION (take the plugin id from the panel's own message): a panel
    // could open another plugin's web app. It comes from the mounted panel.
    await vi.waitFor(() =>
      expect(onOpenWebApp).toHaveBeenCalledWith(
        "hello-plugin",
        "preview",
        "sites/marketing",
      ),
    );
    expect(onOpenWebApp).toHaveBeenCalledTimes(1);
  });

  it("does not open a ui.open target the panel is no longer live for", async () => {
    const onOpenPath = vi.fn();
    const pending = deferred<InvokePluginPanelSdkResult>();
    bridgeMock.invokePluginPanelSdk.mockReturnValueOnce(pending.promise);
    const view = render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
        onOpenPath={onOpenPath}
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
    uiOpenMessage(source);
    await vi.waitFor(() =>
      expect(bridgeMock.invokePluginPanelSdk).toHaveBeenCalledTimes(1),
    );

    bridgeMock.startPluginPanel.mockResolvedValueOnce({
      status: "ok",
      url: "http://127.0.0.1:49161/",
      title: "Other",
    });
    view.rerender(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="other"
        onOpenPath={onOpenPath}
      />,
    );
    await screen.findByTitle("Other");
    await act(async () => {
      pending.resolve({ result: { target: "notes/today.md" } });
      await pending.promise;
    });
    expect(onOpenPath).not.toHaveBeenCalled();
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
      status: "ok",
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

  it("drops a stale panel start after the panel identity changes", async () => {
    const pending = deferred<StartPluginPanelResult>();
    bridgeMock.startPluginPanel
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        status: "ok",
        url: "http://127.0.0.1:49162/",
        title: "Other",
      });
    const view = render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );
    await vi.waitFor(() =>
      expect(bridgeMock.startPluginPanel).toHaveBeenCalledTimes(1),
    );

    view.rerender(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="other"
      />,
    );
    await screen.findByTitle("Other");
    await act(async () => {
      pending.resolve({
        status: "ok",
        url: "http://127.0.0.1:49163/",
        title: "Stale",
      });
      await pending.promise;
    });

    expect(screen.queryByTitle("Stale")).toBeNull();
    expect(screen.getAllByTestId("plugin-panel-frame")).toHaveLength(1);
  });

  it("shows a stable placeholder when a restored panel has no registration", async () => {
    bridgeMock.startPluginPanel.mockResolvedValueOnce(
      { status: "not-registered" },
    );

    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );

    expect(
      (await screen.findByTestId("plugin-panel-unavailable")).textContent,
    ).toContain("This plugin is not running yet.");
    expect(screen.queryByTestId("plugin-panel-error")).toBeNull();
    expect(bridgeMock.startPluginPanel).toHaveBeenCalledTimes(1);
  });

  it("announces an unavailable restored panel", async () => {
    bridgeMock.startPluginPanel.mockResolvedValueOnce(
      { status: "not-registered" },
    );

    render(
      <PluginPanelPage
        workspaceId="ws-plugins"
        pluginId="hello-plugin"
        panelId="main"
      />,
    );

    expect(
      await screen.findByRole("alert", {
        name: "This plugin is not running yet.",
      }),
    ).toBeTruthy();
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
    expect(
      screen.getByRole("alert", { name: /Could not open plugin panel/i }),
    ).toBeTruthy();
    expect(screen.queryByTestId("plugin-panel-unavailable")).toBeNull();
    expect(screen.getByText("Close this tab and try again.")).toBeTruthy();
    first.unmount();

    bridgeMock.startPluginPanel.mockResolvedValueOnce({
      status: "ok",
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

  describe("theme tokens", () => {
    afterEach(() => {
      for (const name of THEME_ATTRIBUTES) {
        document.documentElement.removeAttribute(name);
      }
    });

    async function mountWithFrame() {
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
      return { view, source, postMessage };
    }

    it("answers ui.theme in the renderer without reaching main", async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      const { source, postMessage } = await mountWithFrame();

      sdkMessage(source, "http://127.0.0.1:49160", "ui.theme", undefined);

      await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
      // The theme is renderer state; routing it over IPC would invent a
      // second copy that could disagree with the window on screen.
      expect(bridgeMock.invokePluginPanelSdk).not.toHaveBeenCalled();
      const [message, targetOrigin] = postMessage.mock.calls[0]!;
      expect(targetOrigin).toBe("http://127.0.0.1:49160");
      expect(message.protocol).toBe(DOHC_SDK_PROTOCOL);
      expect(message.id).toBe("request-1");
      expect(message.ok).toBe(true);
      expect(message.result.mode).toBe("dark");
      expect(message.result.tokens["--dohc-ink"]).toBe(palette.dark.ink);
    });

    it("pushes the new theme to a mounted panel when the user switches", async () => {
      const { postMessage } = await mountWithFrame();
      expect(postMessage).not.toHaveBeenCalled();

      await act(async () => {
        document.documentElement.setAttribute("data-theme", "dark");
      });

      await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
      const [message, targetOrigin] = postMessage.mock.calls.at(-1)!;
      expect(targetOrigin).toBe("http://127.0.0.1:49160");
      expect(message.protocol).toBe(DOHC_THEME_PROTOCOL);
      expect(message.theme.mode).toBe("dark");
      expect(message.theme.tokens["--dohc-bg"]).toBe(palette.dark.bg);
    });

    it("pushes a reduced-motion change too", async () => {
      const { postMessage } = await mountWithFrame();

      await act(async () => {
        document.documentElement.setAttribute("data-reduce-motion", "true");
      });

      await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
      const [message] = postMessage.mock.calls.at(-1)!;
      expect(message.theme.reduceMotion).toBe(true);
    });

    // The liveness refs already refuse a stale push, so they would hide a
    // leaked observer. This watches the observer itself: one panel open must
    // not leave something watching <html> for the rest of the session.
    it("releases its observer when the panel unmounts", async () => {
      const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
      const { view } = await mountWithFrame();
      const before = disconnect.mock.calls.length;
      view.unmount();
      expect(disconnect.mock.calls.length).toBeGreaterThan(before);
      disconnect.mockRestore();
    });

    it("stops pushing after the panel unmounts", async () => {
      const { view, postMessage } = await mountWithFrame();
      view.unmount();

      await act(async () => {
        document.documentElement.setAttribute("data-theme", "dark");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(postMessage).not.toHaveBeenCalled();
    });
  });
});
