// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTrustAnswer, SitePreviewReplacedEvent, StartSitePreviewAnswer, GetSitePreviewLogsResult, SitePackageInfo, SitePackagePayload, StartSitePreviewResult } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { shareTargetForSite, SitePreviewPage } from "./SitePreviewPage";
import { deferred } from "../testing/deferred";

// These wait on async bridge answers and userEvent settles. On a loaded
// machine they can take longer than Testing Library's 1000 ms default, and a
// wait that gives up first fails a test that was about to pass. Every wait
// here runs until the condition holds, within the test's own budget.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

function readyShare(
  entryPath: string,
  assets: string[] = [],
): SitePackageInfo["shareManifest"] {
  return { ok: true, manifest: { entryPath, assets } };
}

const noRunnableArtifact = {
  ok: false,
  reason: "no-runnable-artifact",
} as const;

const site: SitePackageInfo = {
  root: "report",
  title: "Report",
  kind: "static",
  confidence: "high",
  entryPath: "report/index.html",
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["report/index.html"],
  shareManifest: readyShare("report/index.html"),
  diagnostics: [],
  authority: { kind: "workspace" },
};

const workspaceSettingsResult = {
  settings: DEFAULT_WORKSPACE_SETTINGS,
  source: "default" as const,
};

const bridgeMock = {
  getSitePackage: vi.fn(async (_payload: SitePackagePayload): Promise<SitePackageInfo | null> => site),
  getWorkspaceSettings: vi.fn(async () => workspaceSettingsResult),
  startSitePreview: vi.fn(async (_payload: { holderId: string; mode: string }): Promise<StartSitePreviewAnswer> => ({
    siteRoot: "report",
    mode: "static" as const,
    url: "http://127.0.0.1:49152/",
    logs: [],
    exited: false,
    generation: 1,
  })),
  getSitePreviewLogs: vi.fn(
    async (): Promise<GetSitePreviewLogsResult> => ({ logs: [], exited: false }),
  ),
  stopSitePreview: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  onSitePreviewReplaced: vi.fn((listener: (event: SitePreviewReplacedEvent) => void) => {
    replacedListeners.add(listener);
    return () => { replacedListeners.delete(listener); };
  }),
  // Main's trust. The person's answer in main's dialog is `answer`.
  readWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }): Promise<WorkspaceTrustAnswer> =>
    ({ workspaceId, trusted: trust.trusted })),
  requestWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }): Promise<WorkspaceTrustAnswer> => {
    trust.trusted ||= trust.answer;
    return { workspaceId, trusted: trust.trusted };
  }),
  restrictWorkspace: vi.fn(async ({ workspaceId }: { workspaceId: string }): Promise<WorkspaceTrustAnswer> => {
    trust.trusted = false;
    return { workspaceId, trusted: false };
  }),
  onWorkspaceTrustChanged: vi.fn((listener: (event: WorkspaceTrustAnswer) => void) => {
    trustListeners.add(listener);
    return () => { trustListeners.delete(listener); };
  }),
};
const trust = { trusted: true, answer: true };
const trustListeners = new Set<(event: WorkspaceTrustAnswer) => void>();
const replacedListeners = new Set<(event: SitePreviewReplacedEvent) => void>();
function replace(event: SitePreviewReplacedEvent) {
  act(() => { for (const listener of replacedListeners) listener(event); });
}

describe("SitePreviewPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    trust.trusted = true;
    trust.answer = true;
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("runs a pinned app in the side panel inside the same sandbox as its tab", async () => {
    const tab = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);
    const tabFrame = await screen.findByTestId("site-preview-frame");
    const tabAttributes = ["sandbox", "referrerpolicy", "src"].map((name) => tabFrame.getAttribute(name));
    tab.unmount();

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" variant="panel" />);
    const frame = await screen.findByTestId("site-preview-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-forms allow-same-origin allow-scripts");
    expect(["sandbox", "referrerpolicy", "src"].map((name) => frame.getAttribute(name)))
      .toEqual(tabAttributes);
    // The side panel's header already names the folder.
    expect(screen.getByText("Report")).toBeTruthy();
    expect(screen.queryByText("report")).toBeNull();
  });

  it("follows a preview another surface started again, and ignores an older one", async () => {
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);
    const frame = await screen.findByTestId("site-preview-frame");
    expect(new URL(frame.getAttribute("src") ?? "").port).toBe("49152");
    const { holderId } = bridgeMock.startSitePreview.mock.calls[0]![0];
    const next = (generation: number, port: number): SitePreviewReplacedEvent => ({
      workspaceId: "ws-sites",
      siteRoot: "report",
      holderId,
      generation,
      preview: { siteRoot: "report", mode: "build", url: `http://127.0.0.1:${port}/`, logs: [], exited: false, generation },
    });

    replace(next(3, 49160));
    expect(new URL(screen.getByTestId("site-preview-frame").getAttribute("src") ?? "").port).toBe("49160");
    expect(screen.getByTestId("site-preview-mode").textContent).toBe("Build");
    // An older start, or one meant for another surface, changes nothing.
    replace(next(2, 49170));
    replace({ ...next(4, 49180), holderId: "another-surface" });
    expect(new URL(screen.getByTestId("site-preview-frame").getAttribute("src") ?? "").port).toBe("49160");

    // A restart that failed after stopping the preview leaves nothing to show.
    replace({ ...next(5, 49190), preview: null });
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
    expect(screen.getByText("Preview stopped. Use Preview options to run it again.")).toBeTruthy();
  });

  it("starts the best available preview automatically and embeds the local URL", async () => {
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    const frame = await screen.findByTestId("site-preview-frame");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).not.toContain("allow-modals");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(frame.style.colorScheme).toBe("light");
    expect(frame.style.backgroundColor).toBe("canvas");
    const frameUrl = new URL(frame.getAttribute("src") ?? "");
    expect(frameUrl.origin).toBe("http://127.0.0.1:49152");
    expect(frameUrl.searchParams.has("dohcHostOrigin")).toBe(false);
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
      holderId: expect.any(String),
      restart: false,
    });
    expect(screen.getByTestId("site-preview-static")).toBeTruthy();
  });

  describe("in Restricted Mode", () => {
    const packageApp: SitePackageInfo = {
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite", build: "vite build" },
    };
    const answer = (mode: "static" | "dev" | "build", generation = 1): StartSitePreviewAnswer => ({
      siteRoot: "report", mode, url: `http://127.0.0.1:${49160 + generation}/`, logs: [], exited: false, generation,
    });
    const starts = () => bridgeMock.startSitePreview.mock.calls.map(([payload]) => payload.mode);

    it("shows the static preview in place of Dev, and runs Dev once the person trusts the workspace", async () => {
      trust.trusted = false;
      bridgeMock.getSitePackage.mockResolvedValue(packageApp);
      bridgeMock.startSitePreview.mockResolvedValueOnce(answer("static")).mockResolvedValueOnce(answer("dev", 2));
      render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

      const state = await screen.findByTestId("restricted-mode-state");
      expect(state.dataset.variant).toBe("band");
      expect(state.textContent).toContain("In Restricted Mode, dohc does not run this app's code.");
      await screen.findByTestId("site-preview-frame");
      expect(starts()).toEqual(["static"]);
      // The static preview stands in; the person's mode is still Dev.
      expect(window.localStorage.getItem("dohc.site-preview-mode.v1:ws-sites:report")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Trust workspace" }));

      expect(bridgeMock.requestWorkspaceTrust).toHaveBeenCalledWith({ workspaceId: "ws-sites" });
      await waitFor(() => expect(starts()).toEqual(["static", "dev"]));
      await waitFor(() => expect(screen.queryByTestId("restricted-mode-state")).toBeNull());
      bridgeMock.getSitePackage.mockResolvedValue(site);
    });

    it("starts nothing for an app with no static preview, and stays put when the person stays restricted", async () => {
      trust.trusted = false;
      trust.answer = false;
      bridgeMock.getSitePackage.mockResolvedValue({ ...packageApp, entryPath: null });
      render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

      const state = await screen.findByTestId("restricted-mode-state");
      expect(state.dataset.variant).toBe("page");
      await userEvent.click(screen.getByRole("button", { name: "Trust workspace" }));
      await waitFor(() => expect(bridgeMock.requestWorkspaceTrust).toHaveBeenCalledTimes(1));
      expect(bridgeMock.startSitePreview).not.toHaveBeenCalled();
      expect(screen.getByTestId("restricted-mode-state")).toBeTruthy();
      bridgeMock.getSitePackage.mockResolvedValue(site);
    });

    it("holds Dev back while the read failed, and runs it once Try again reads trust", async () => {
      bridgeMock.getSitePackage.mockResolvedValue(packageApp);
      bridgeMock.readWorkspaceTrust.mockRejectedValueOnce(new Error("busy"));
      bridgeMock.startSitePreview.mockResolvedValueOnce(answer("static")).mockResolvedValueOnce(answer("dev", 2));
      const reportError = vi.fn();
      render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" reportError={reportError} />);
      await screen.findByTestId("restricted-mode-state");
      await screen.findByTestId("site-preview-frame");
      expect(starts()).toEqual(["static"]);

      await waitFor(() => expect(reportError).toHaveBeenCalled());
      act(() => { (reportError.mock.calls[0]![2] as () => void)(); });

      await waitFor(() => expect(starts()).toEqual(["static", "dev"]));
      await waitFor(() => expect(screen.queryByTestId("restricted-mode-state")).toBeNull());
      bridgeMock.getSitePackage.mockResolvedValue(site);
    });

    it("builds nothing for Share, and shares once the person trusts the workspace", async () => {
      trust.trusted = false;
      const needsBuild: SitePackageInfo = {
        ...packageApp, entryPath: null, shareManifest: noRunnableArtifact,
      };
      const built: SitePackageInfo = { ...needsBuild, shareManifest: readyShare("report/dist/index.html") };
      bridgeMock.getSitePackage.mockImplementation(async (payload) =>
        payload.effectivePreviewMode === "build" ? built : needsBuild);
      bridgeMock.startSitePreview.mockResolvedValue(answer("build"));
      const onShareSite = vi.fn();
      render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" onShareSite={onShareSite} />);
      await screen.findByTestId("restricted-mode-state");

      await userEvent.click(screen.getByTestId("site-preview-share"));
      await waitFor(() => expect(bridgeMock.getSitePackage).toHaveBeenCalledTimes(2));
      expect(bridgeMock.startSitePreview).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("button", { name: "Trust workspace" }));
      await waitFor(() => expect(onShareSite).toHaveBeenCalledWith({ paths: ["report/dist/index.html"], label: "Report" }));
      expect(starts()).toEqual(["build"]);
      bridgeMock.getSitePackage.mockReset();
      bridgeMock.getSitePackage.mockResolvedValue(site);
      bridgeMock.startSitePreview.mockReset();
    });
  });

  it("keeps a stored preview mode over the workspace default", async () => {
    window.localStorage.setItem("dohc.site-preview-mode.v1:ws-sites:report", "static");
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite", build: "vite build" },
      configuredPreviewMode: "dev",
      buildOutputs: ["dist"],
    });
    bridgeMock.getWorkspaceSettings.mockResolvedValueOnce({
      ...workspaceSettingsResult,
      settings: {
        ...workspaceSettingsResult.settings,
        sites: { defaultPreviewMode: "build" },
      },
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
      holderId: expect.any(String),
      restart: false,
    });
  });

  it("only offers and auto-starts static preview in a relay shared-view workspace", async () => {
    window.localStorage.setItem("dohc.site-preview-mode.v1:ws-sites:report", "dev");
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite", build: "vite build" },
      buildOutputs: ["dist"],
      sourceFiles: [
        "report/package.json",
        "report/src/main.tsx",
        "report/dist/index.html",
      ],
      shareManifest: readyShare("report/dist/index.html"),
    });
    const onShareSite = vi.fn();

    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        sharedView
        onShareSite={onShareSite}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
      holderId: expect.any(String),
      restart: false,
    });
    expect(screen.getByTestId("site-preview-static")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-dev")).toBeNull();
    expect(screen.queryByTestId("site-preview-build")).toBeNull();
    expect(screen.queryByTestId("site-preview-share")).toBeNull();
    expect(screen.queryByTestId("site-preview-review")).toBeNull();
  });

  it("refreshes the site manifest before preparing a share", async () => {
    const freshSite: SitePackageInfo = {
      ...site,
      sourceFiles: ["report/index.html", "report/fresh.js"],
      shareManifest: readyShare("report/index.html", ["report/fresh.js"]),
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(site)
      .mockResolvedValueOnce(freshSite);
    const onShareSite = vi.fn();
    const user = userEvent.setup();
    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={onShareSite}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));

    expect(onShareSite).toHaveBeenCalledWith({
      paths: ["report/index.html", "report/fresh.js"],
      label: "Report",
    });
  });

  it("aborts a share when the post-build refresh returns a different site's root than the tab's own", async () => {
    const needsBuildSite: SitePackageInfo = {
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { build: "vite build" },
      shareManifest: noRunnableArtifact,
    };
    const mismatchedRootSite: SitePackageInfo = { ...site, root: "report/legacy" };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(site)
      .mockResolvedValueOnce(needsBuildSite)
      .mockResolvedValueOnce(mismatchedRootSite);
    const onShareSite = vi.fn();
    const user = userEvent.setup();
    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={onShareSite}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));

    expect(onShareSite).not.toHaveBeenCalled();
    expect((await screen.findByTestId("site-preview-error")).textContent).toContain(
      "This app is no longer part of the workspace.",
    );
  });

  it("clears a crashed dev preview and keeps its final logs visible", async () => {
    const exitedLogs = deferred<GetSitePreviewLogsResult>();
    const devSite: SitePackageInfo = {
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
    };
    bridgeMock.getSitePackage.mockResolvedValueOnce(devSite);
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "dev",
      url: "http://127.0.0.1:49152/",
      logs: [{ stream: "stdout", text: "ready", at: 1 }],
      exited: false,
      generation: 1,
    });
    bridgeMock.getSitePreviewLogs.mockReturnValueOnce(exitedLogs.promise);
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await waitFor(() =>
      expect(bridgeMock.getSitePreviewLogs).toHaveBeenCalled(),
    );
    await act(async () => {
      exitedLogs.resolve({
        logs: [
          { stream: "stdout", text: "ready", at: 1 },
          { stream: "stderr", text: "fatal: address became unavailable", at: 2 },
        ],
        exited: true,
      });
      await exitedLogs.promise;
    });

    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
    expect(screen.queryByTestId("site-preview-stop")).toBeNull();
    expect(
      await screen.findByText(/fatal: address became unavailable/),
    ).toBeTruthy();
  });

  it("does not apply a stale dev-log response after the site context changes", async () => {
    const pendingLogs = deferred<GetSitePreviewLogsResult>();
    const devSite: SitePackageInfo = {
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
    };
    const replacementSite: SitePackageInfo = {
      ...devSite,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      packagePath: "replacement/package.json",
      sourceFiles: ["replacement/index.html", "replacement/package.json"],
      shareManifest: readyShare("replacement/index.html"),
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(devSite)
      .mockResolvedValueOnce(replacementSite);
    bridgeMock.startSitePreview
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "dev",
        url: "http://127.0.0.1:49152/",
        logs: [{ stream: "stdout", text: "report ready", at: 1 }],
        exited: false,
        generation: 1,
      })
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "dev",
        url: "http://127.0.0.1:49153/",
        logs: [{ stream: "stdout", text: "replacement ready", at: 2 }],
        exited: false,
        generation: 1,
      });
    bridgeMock.getSitePreviewLogs
      .mockReturnValueOnce(pendingLogs.promise)
      .mockResolvedValueOnce({
        logs: [{ stream: "stdout", text: "replacement ready", at: 2 }],
        exited: false,
      });
    const user = userEvent.setup();
    const view = render(
      <SitePreviewPage workspaceId="ws-sites" siteRoot="report" />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByText("Logs"));
    await waitFor(() =>
      expect(bridgeMock.getSitePreviewLogs).toHaveBeenCalledTimes(1),
    );

    view.rerender(
      <SitePreviewPage workspaceId="ws-sites" siteRoot="replacement" />,
    );
    await screen.findByText("Replacement");
    await screen.findByText(/replacement ready/);

    await act(async () => {
      pendingLogs.resolve({
        logs: [{ stream: "stdout", text: "stale report output", at: 3 }],
        exited: false,
      });
      await pendingLogs.promise;
    });

    expect(screen.queryByText(/stale report output/)).toBeNull();
    expect(screen.getByText(/replacement ready/)).toBeTruthy();
  });

  it("does not re-render every second when the dev-log ring is unchanged", async () => {
    vi.useFakeTimers();
    try {
      const devSite: SitePackageInfo = {
        ...site,
        kind: "package",
        packagePath: "report/package.json",
        scripts: { dev: "vite" },
      };
      bridgeMock.getSitePackage.mockResolvedValueOnce(devSite);
      bridgeMock.startSitePreview.mockResolvedValueOnce({
        siteRoot: "report",
        mode: "dev",
        url: "http://127.0.0.1:49152/",
        logs: [{ stream: "stdout", text: "ready", at: 1 }],
        exited: false,
        generation: 1,
      });
      // Every poll returns a content-equal but reference-DIFFERENT ring: only
      // the sameLogs bailout keeps the previous state and skips the commit.
      bridgeMock.getSitePreviewLogs.mockImplementation(
        async (): Promise<GetSitePreviewLogsResult> => ({
          logs: [{ stream: "stdout", text: "ready", at: 1 }],
          exited: false,
        }),
      );

      let renders = 0;
      render(
        <Profiler id="site-preview" onRender={() => (renders += 1)}>
          <SitePreviewPage workspaceId="ws-sites" siteRoot="report" />
        </Profiler>,
      );
      // Let load -> auto-start -> first log poll settle, then one more poll so
      // React's first bailed-out set has flushed and renders are steady.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("site-preview-frame")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const settledRenders = renders;
      const settledPolls = bridgeMock.getSitePreviewLogs.mock.calls.length;

      // Three more unchanged polls: zero renders.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(bridgeMock.getSitePreviewLogs.mock.calls.length).toBe(settledPolls + 3);
      expect(renders).toBe(settledRenders);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open a stale share dialog when manifest refresh finishes after site replacement", async () => {
    const pendingRefresh = deferred<SitePackageInfo | null>();
    const buildableSite: SitePackageInfo = {
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite", build: "vite build" },
      buildOutputs: ["dist"],
      sourceFiles: ["report/package.json", "report/src/main.tsx"],
      shareManifest: noRunnableArtifact,
    };
    const replacementSite: SitePackageInfo = {
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      sourceFiles: ["replacement/index.html"],
      shareManifest: readyShare("replacement/index.html"),
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(buildableSite)
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockResolvedValueOnce(replacementSite);
    bridgeMock.startSitePreview
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "dev",
        url: "http://127.0.0.1:49152/",
        logs: [],
        exited: false,
        generation: 1,
      })
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "static",
        url: "http://127.0.0.1:49153/",
        logs: [],
        exited: false,
        generation: 1,
      });
    const onShareSite = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={onShareSite}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));
    await waitFor(() => expect(bridgeMock.getSitePackage).toHaveBeenCalledTimes(2));

    view.rerender(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="replacement"
        onShareSite={onShareSite}
      />,
    );
    await screen.findByText("Replacement");

    await act(async () => {
      pendingRefresh.resolve({
        ...buildableSite,
        sourceFiles: [...buildableSite.sourceFiles, "report/dist/index.html"],
        shareManifest: readyShare("report/dist/index.html"),
      });
      await pendingRefresh.promise;
    });

    expect(onShareSite).not.toHaveBeenCalled();
  });

  it("does not repaint the new site with a stale preview-start response after switching sites mid-start", async () => {
    const pendingStart = deferred<StartSitePreviewResult>();
    const replacementSite: SitePackageInfo = {
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      sourceFiles: ["replacement/index.html"],
      shareManifest: readyShare("replacement/index.html"),
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(site)
      .mockResolvedValueOnce(replacementSite);
    bridgeMock.startSitePreview
      .mockReturnValueOnce(pendingStart.promise)
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "static",
        url: "http://127.0.0.1:49999/",
        logs: [],
        exited: false,
        generation: 1,
      });

    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);
    await waitFor(() => expect(bridgeMock.startSitePreview).toHaveBeenCalledTimes(1));

    view.rerender(<SitePreviewPage workspaceId="ws-sites" siteRoot="replacement" />);
    const frame = await screen.findByTestId("site-preview-frame");
    expect(new URL(frame.getAttribute("src") ?? "").origin).toBe("http://127.0.0.1:49999");

    await act(async () => {
      pendingStart.resolve({
        siteRoot: "report",
        mode: "static",
        url: "http://127.0.0.1:49152/",
        logs: [],
        exited: false,
        generation: 1,
      });
      await pendingStart.promise;
    });

    const frameAfter = screen.getByTestId("site-preview-frame");
    expect(new URL(frameAfter.getAttribute("src") ?? "").origin).toBe("http://127.0.0.1:49999");
  });

  it("shares explicit root-site browser assets without selecting the workspace", () => {
    expect(
      shareTargetForSite({
        ...site,
        root: ".",
        entryPath: "index.html",
        sourceFiles: [
          "index.html",
          "app.js",
          "assets/logo.png",
          "vendor/chart-lib/dist/index.js",
          "vendor/chart-lib/dist/index.d.ts",
          "notes/private.md",
          "projects/other/index.html",
        ],
        shareManifest: readyShare("index.html", [
          "app.js",
          "assets/logo.png",
          "vendor/chart-lib/dist/index.js",
        ]),
      }),
    ).toEqual({
      paths: [
        "index.html",
        "app.js",
        "assets/logo.png",
        "vendor/chart-lib/dist/index.js",
      ],
      label: "Report",
    });
  });

  it("fails closed when the authoritative package has no safe share manifest", () => {
    expect(
      shareTargetForSite({
        ...site,
        shareManifest: noRunnableArtifact,
        sourceFiles: [
          "report/index.html",
          "report/app.js",
          "report/private/secret.json",
        ],
      }),
    ).toBeNull();
  });

  it("refuses to render non-loopback preview URLs", async () => {
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "static",
      url: "https://example.com/preview",
      logs: [],
      exited: false,
      generation: 1,
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("This app tried to preview from an address dohc does not trust. Reload the preview.")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
    // Disabled, not hidden, so nothing in the toolbar moves.
    expect((screen.getByTestId("site-preview-reload") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("site-preview-open-external") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("site-preview-stop")).toBeTruthy();
  });

  it("does not let a stale stop completion clear a replacement site", async () => {
    const pendingStop = deferred<undefined>();
    bridgeMock.stopSitePreview.mockReturnValueOnce(pendingStop.promise);
    const user = userEvent.setup();
    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-stop"));

    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
    });
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "replacement",
      mode: "static",
      url: "http://127.0.0.1:49153/",
      logs: [],
      exited: false,
      generation: 1,
    });
    view.rerender(<SitePreviewPage workspaceId="ws-sites" siteRoot="replacement" />);

    const replacementFrame = await screen.findByTestId("site-preview-frame");
    expect(new URL(replacementFrame.getAttribute("src") ?? "").port).toBe("49153");

    await act(async () => {
      pendingStop.resolve(undefined);
      await pendingStop.promise;
    });

    expect(screen.getByTestId("site-preview-frame")).toBe(replacementFrame);
  });

});
