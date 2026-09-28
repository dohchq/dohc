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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { DesktopWorkspaceShell } from "../DesktopWorkspaceShell";
import { VIEW_IDS } from "../workbench/workbenchState";
import {
  WORKSPACE,
  STORED_STATE,
  makeBridge,
  shellBootstrapProps,
} from "../DesktopWorkspaceShell.testHarness";

describe("apps pinned to the sidebar", () => {
  it("opens a view hidden from the rail from a command, and moves off it only when the rail changes", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const withSidebar = (hidden: typeof VIEW_IDS[number][], zoomLevel = 0) => ({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel },
        sidebar: { ...DEFAULT_USER_SETTINGS.sidebar, hidden },
      },
      source: "stored" as const,
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const shellWith = (userSettings: ReturnType<typeof withSidebar>) => (
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        userSettings={userSettings}
        onSwitchWorkspace={() => {}}
      />
    );
    const view = render(shellWith(withSidebar(["history"])));
    const shell = await screen.findByTestId("workspace-shell");
    await waitFor(() => expect(shell.dataset.ready).toBe("true"));
    expect(screen.queryByTestId("activity-history")).toBeNull();

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await within(await screen.findByTestId("command-palette")).findByText("View: History"));
    const panel = await screen.findByTestId("side-panel");
    expect(within(panel).getByText("History")).toBeTruthy();

    // Another settings change, or hiding another view, leaves it open.
    view.rerender(shellWith(withSidebar(["history"], 1)));
    await act(async () => { await Promise.resolve(); });
    expect(within(screen.getByTestId("side-panel")).getByText("History")).toBeTruthy();
    view.rerender(shellWith(withSidebar(["history", "explorer"])));
    await act(async () => { await Promise.resolve(); });
    expect(within(screen.getByTestId("side-panel")).getByText("History")).toBeTruthy();

    // Hiding the selected view is what moves the selection, to the first
    // view on the rail.
    await user.click(screen.getByTestId("activity-search"));
    await waitFor(() =>
      expect(within(screen.getByTestId("side-panel")).getByText("Search")).toBeTruthy());
    view.rerender(shellWith(withSidebar(["history", "explorer", "search"])));
    await waitFor(() =>
      expect(within(screen.getByTestId("side-panel")).getByText("Graph")).toBeTruthy());
  });

  it("never opens a hidden view, even when the sidebar is toggled back on", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: { ...DEFAULT_USER_SETTINGS.sidebar, hidden: [...VIEW_IDS] },
    };
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        userSettings={{ settings, source: "stored" }}
        onSwitchWorkspace={() => {}}
      />,
    );
    const shell = await screen.findByTestId("workspace-shell");
    await waitFor(() => expect(shell.dataset.ready).toBe("true"));
    for (const view of VIEW_IDS) expect(screen.queryByTestId(`activity-${view}`)).toBeNull();
    expect(screen.queryByTestId("side-panel")).toBeNull();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(screen.queryByTestId("file-tree")).toBeNull();
  });

  it("opens a pinned app in the side panel inside the preview's sandbox, and unpins it from its menu", async () => {
    const user = userEvent.setup();
    const site: SitePackageInfo = {
      root: "apps/trip",
      title: "Trip planner",
      kind: "static",
      confidence: "high",
      entryPath: "apps/trip/index.html",
      configPath: null,
      packagePath: null,
      packageManager: null,
      scripts: {},
      configuredScripts: {},
      configuredPreviewMode: null,
      configuredBuildOutput: null,
      buildOutputs: [],
      sourceFiles: ["apps/trip/index.html"],
      shareManifest: { ok: true, manifest: { entryPath: "apps/trip/index.html", assets: [] } },
      diagnostics: [],
      authority: { kind: "workspace" },
    };
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      getSitePackage: vi.fn(async () => site),
      startSitePreview: vi.fn(async () => ({
        siteRoot: "apps/trip",
        mode: "static" as const,
        url: "http://127.0.0.1:49152/",
        logs: [],
        exited: false,
        generation: 1,
      })),
      stopSitePreview: vi.fn(async () => undefined),
      onSitePreviewReplaced: vi.fn(() => () => undefined),
      getSitePreviewLogs: vi.fn(async () => ({ logs: [], exited: false })),
      setAppPinned: vi.fn(async () => ({ settings: DEFAULT_USER_SETTINGS, source: "stored" as const })),
    });
    bridge.showWorkbenchMenu.mockResolvedValue("unpin-app");
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: {
        ...DEFAULT_USER_SETTINGS.sidebar,
        hidden: ["graph" as const],
        pinnedApps: { [WORKSPACE.workspaceId]: ["apps/trip"] },
      },
    };
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        userSettings={{ settings, source: "stored" }}
        onSwitchWorkspace={() => {}}
      />,
    );

    const shell = await screen.findByTestId("workspace-shell");
    await waitFor(() => expect(shell.dataset.ready).toBe("true"));
    expect(screen.queryByTestId("activity-graph")).toBeNull();
    // The pin carries its app's title once dohc has read the app.
    const pinned = await screen.findByRole("button", { name: "Trip planner" });
    await user.click(pinned);

    const panel = screen.getByTestId("side-panel");
    const frame = await within(panel).findByTestId("site-preview-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-forms allow-same-origin allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(bridge.startSitePreview).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      siteRoot: "apps/trip",
      mode: "static",
      holderId: expect.any(String),
      restart: false,
    });

    fireEvent.contextMenu(pinned);
    await waitFor(() =>
      expect(bridge.setAppPinned).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        appRoot: "apps/trip",
        pinned: false,
      }),
    );
    expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      context: "pinned-app",
      path: "apps/trip",
    });
  });
});
