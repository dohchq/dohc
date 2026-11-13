// @vitest-environment jsdom
import "../../testing/legendListMock";
// Collection dependencies read these observers during module evaluation.
// Preload them before tests so an unfinished import cannot clean up a later test's globals.
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] {
      return [];
    }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
});
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import {
  DesktopWorkspaceShell,
  WORKSPACE,
  makeBridge,
  shellBootstrapProps,
} from "../DesktopWorkspaceShell.testHarness";

describe("apps pinned to the sidebar", () => {
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
      setAppPinned: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "stored" as const,
      })),
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
