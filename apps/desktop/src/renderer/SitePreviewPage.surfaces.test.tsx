// @vitest-environment jsdom
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SitePackageInfo,
  SitePackagePayload,
  SitePreviewReplacedEvent,
  StartSitePreviewPayload,
  StopSitePreviewPayload,
} from "../ipc/bridgeContract";
import type { SitePreviewResultBody } from "../ipc/sitePreviewIpc";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { createSitePreviewLifecycle } from "../workspaces/sitePreviewLifecycle";
import type { StaticSitePreview } from "../workspaces/siteRunner";
import { SitePreviewPage } from "./SitePreviewPage";

// These wait on async bridge answers and userEvent settles. On a loaded
// machine they can take longer than Testing Library's 1000 ms default, and a
// wait that gives up first fails a test that was about to pass. Every wait
// here runs until the condition holds, within the test's own budget.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

// An app's tab and its pinned panel, side by side in one window, against
// main's real preview lifecycle.

const app: SitePackageInfo = {
  root: "report",
  title: "Report",
  kind: "package",
  confidence: "high",
  entryPath: "report/index.html",
  configPath: null,
  packagePath: "report/package.json",
  packageManager: "pnpm",
  scripts: { dev: "vite", build: "vite build" },
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["report/index.html", "report/package.json"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
};

function mainProcess() {
  const handles: StaticSitePreview[] = [];
  const listeners = new Set<(event: SitePreviewReplacedEvent) => void>();
  const lifecycle = createSitePreviewLifecycle<SitePreviewResultBody>({
    allowOrigin: () => () => undefined,
    // Main sends the event to the window; here both surfaces share one.
    notifyReplaced: (_senderId, replacement) => {
      queueMicrotask(() => {
        for (const listener of listeners) listener(replacement);
      });
    },
  });
  const built = { ...app, shareManifest: { ok: true as const, manifest: { entryPath: "report/dist/index.html", assets: [] } } };
  const bridge = {
    getSitePackage: vi.fn(async (payload: SitePackagePayload) =>
      payload.effectivePreviewMode === "build" ? built : app),
    getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
    startSitePreview: vi.fn((payload: StartSitePreviewPayload) =>
      lifecycle.acquire({
        ...payload,
        senderId: 1,
        isCurrent: () => true,
        prepare: async () => async () => {
          const handle: StaticSitePreview = {
            url: `http://127.0.0.1:${49300 + handles.length}/`,
            root: "/workspace/report",
            stop: vi.fn(async () => undefined),
          };
          handles.push(handle);
          return { handle, result: { siteRoot: payload.siteRoot, mode: payload.mode, logs: [] } };
        },
      })),
    stopSitePreview: vi.fn((payload: StopSitePreviewPayload) =>
      lifecycle.release({ ...payload, getActiveWorkspaceId: () => "ws-sites" })),
    getSitePreviewLogs: vi.fn(async () => ({ logs: [], exited: false })),
    onSitePreviewReplaced: vi.fn((listener: (event: SitePreviewReplacedEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    openExternalUrl: vi.fn(async () => undefined),
  };
  return { lifecycle, handles, bridge };
}

function frameUrl(surface: HTMLElement): string | null {
  return within(surface).queryByTestId("site-preview-frame")?.getAttribute("src") ?? null;
}

async function renderSurfaces() {
  const main = mainProcess();
  vi.stubGlobal("dohcDesktop", main.bridge);
  const onShareSite = vi.fn();
  render(
    <>
      <div data-testid="tab">
        <SitePreviewPage workspaceId="ws-sites" siteRoot="report" onShareSite={onShareSite} />
      </div>
      <div data-testid="pin">
        <SitePreviewPage workspaceId="ws-sites" siteRoot="report" variant="panel" onShareSite={onShareSite} />
      </div>
    </>,
  );
  const tab = screen.getByTestId("tab");
  const pin = screen.getByTestId("pin");
  await waitFor(() => expect(frameUrl(tab)).not.toBeNull());
  await waitFor(() => expect(frameUrl(pin)).toBe(frameUrl(tab)));
  return { ...main, tab, pin, onShareSite };
}

async function runAgain(surface: HTMLElement, mode: "dev" | "build") {
  const user = userEvent.setup();
  await user.click(within(surface).getByTestId("site-preview-options"));
  await user.click(within(surface).getByTestId(`site-preview-${mode}`));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an app's tab and its pinned panel", () => {
  it("share one preview, and each follows when the other starts it again", async () => {
    const s = await renderSurfaces();
    expect(s.handles).toHaveLength(1);

    await runAgain(s.pin, "dev");
    await waitFor(() => expect(frameUrl(s.tab)).toBe(s.handles[1]!.url));
    expect(frameUrl(s.pin)).toBe(s.handles[1]!.url);
    expect(s.handles[0]!.stop).toHaveBeenCalledOnce();

    await runAgain(s.tab, "dev");
    await waitFor(() => expect(frameUrl(s.pin)).toBe(s.handles[2]!.url));
    expect(frameUrl(s.tab)).toBe(s.handles[2]!.url);
    expect(s.handles[1]!.stop).toHaveBeenCalledOnce();
  });

  it("moves the tab to the build Share starts from the pinned panel", async () => {
    const s = await renderSurfaces();
    await userEvent.setup().click(within(s.pin).getByTestId("site-preview-share"));
    await waitFor(() => expect(s.onShareSite).toHaveBeenCalledOnce());
    await waitFor(() => expect(frameUrl(s.tab)).toBe(s.handles[1]!.url));
    expect(within(s.tab).getByTestId("site-preview-mode").textContent).toBe("Build");
    expect(frameUrl(s.pin)).toBe(s.handles[1]!.url);
    expect(s.handles[0]!.stop).toHaveBeenCalledOnce();
  });
});
