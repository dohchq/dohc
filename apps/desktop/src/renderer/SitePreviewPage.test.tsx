// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GetSitePreviewLogsResult,
  SitePackageInfo,
  SitePackagePayload,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { shareTargetForSite, SitePreviewPage } from "./SitePreviewPage";

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
  startSitePreview: vi.fn(async (): Promise<StartSitePreviewResult> => ({
    siteRoot: "report",
    mode: "static" as const,
    url: "http://127.0.0.1:49152/",
    logs: [],
    exited: false,
  })),
  getSitePreviewLogs: vi.fn(
    async (): Promise<GetSitePreviewLogsResult> => ({ logs: [], exited: false }),
  ),
  stopSitePreview: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("SitePreviewPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
    const frameUrl = new URL(frame.getAttribute("src") ?? "");
    expect(frameUrl.origin).toBe("http://127.0.0.1:49152");
    expect(frameUrl.searchParams.has("dohcHostOrigin")).toBe(false);
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
    });
    expect(screen.getByTestId("site-preview-static")).toBeTruthy();
  });

  it("prefers a development preview for an owned package site", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
    });
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "dev",
      url: "http://127.0.0.1:49152/",
      logs: [],
      exited: false,
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "dev",
    });
  });

  it("prefers the site's configured preview mode when Auto is selected", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
      configuredPreviewMode: "static",
    });
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "static",
      url: "http://127.0.0.1:49152/",
      logs: [],
      exited: false,
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
    });
  });

  it("uses the workspace default for the initial preview mode", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite", build: "vite build" },
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
      mode: "build",
    });
  });

  it("offers a present configured output as build mode without a build script", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "configured",
      entryPath: null,
      configuredBuildOutput: "public",
      sourceFiles: ["report/public/index.html"],
      shareManifest: readyShare("report/public/index.html"),
    });
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "build",
      url: "http://127.0.0.1:49152/",
      logs: [],
      exited: false,
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(screen.getByTestId("site-preview-build")).toBeTruthy();
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "build",
    });
  });

  it("offers no mode when a site has no entry, script, or present output", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      entryPath: null,
      shareManifest: noRunnableArtifact,
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText(
      "This site has no previewable entry, dev script, or build output yet.",
    );
    expect(screen.queryByTestId("site-preview-options")).toBeNull();
    expect(bridgeMock.startSitePreview).not.toHaveBeenCalled();
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
    });
    expect(screen.getByTestId("site-preview-static")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-dev")).toBeNull();
    expect(screen.queryByTestId("site-preview-build")).toBeNull();
    expect(screen.queryByTestId("site-preview-share")).toBeNull();
  });

  it("reuses the last successful preview mode when it remains available", async () => {
    window.localStorage.setItem("dohc.site-preview-mode.v1:ws-sites:report", "static");
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
    });
  });

  it("labels shared sites, auto-starts static, and withholds owned-site sharing", async () => {
    const sharedRoot = "shared-with-me/alex/report";
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      root: sharedRoot,
      entryPath: `${sharedRoot}/index.html`,
      scripts: {},
      buildOutputs: ["dist"],
      sourceFiles: [
        `${sharedRoot}/index.html`,
        `${sharedRoot}/dist/index.html`,
      ],
      shareManifest: readyShare(`${sharedRoot}/dist/index.html`),
      authority: { kind: "share", mountRoot: "shared-with-me/alex" },
    });
    const onShareSite = vi.fn();

    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot={sharedRoot}
        onShareSite={onShareSite}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    expect(screen.getByTestId("site-preview-shared-label").textContent).toBe("Shared");
    expect(screen.queryByTestId("site-preview-share")).toBeNull();
    expect(screen.queryByTestId("site-preview-dev")).toBeNull();
    expect(screen.queryByTestId("site-preview-build")).toBeNull();
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: sharedRoot,
      mode: "static",
    });
  });

  it("offers owned sites through the shell share callback", async () => {
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
      paths: ["report/index.html"],
      label: "Report",
    });
  });

  it("shares the mode actually running, not whatever prepareShare's callback closed over before auto-start", async () => {
    const onShareSite = vi.fn();
    const user = userEvent.setup();
    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={onShareSite}
      />,
    );

    // By the time the frame appears, auto-start has already set preview to
    // the "static" mode startSitePreview's mock reports. If prepareShare's
    // useCallback is missing preview/runningMode from its deps, its
    // memoized closure still reads them as they were at MOUNT — both
    // null — so the refetch below asks for effectivePreviewMode: null
    // instead of the mode that's actually running.
    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));

    expect(onShareSite).toHaveBeenCalled();
    const refetchCall = bridgeMock.getSitePackage.mock.calls.at(-1)?.[0];
    expect(refetchCall).toMatchObject({ effectivePreviewMode: "static" });
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

  it("does not share a site that disappeared before preparation", async () => {
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(site)
      .mockResolvedValueOnce(null);
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
      "This site is no longer part of the workspace.",
    );
  });

  it("aborts a share when the pre-share refresh returns a different site's root than the tab's own", async () => {
    // getSitePackage returns the deepest CONTAINING site for a path, so a
    // stale tab whose own root stopped being a detected site can still get
    // back a detected ancestor above it — sharing that ancestor would offer
    // a different site than the one this tab names.
    const mismatchedRootSite: SitePackageInfo = { ...site, root: "report/legacy" };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(site)
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
      "This site is no longer part of the workspace.",
    );
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
      "This site is no longer part of the workspace.",
    );
  });

  it("shows dev logs written after the preview becomes ready", async () => {
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
    });
    bridgeMock.getSitePreviewLogs.mockResolvedValueOnce({
      logs: [
        { stream: "stdout", text: "ready", at: 1 },
        { stream: "stderr", text: "compiler warning after readiness", at: 2 },
      ],
      exited: false,
    });
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByText("Logs"));

    expect(
      await screen.findByText(/compiler warning after readiness/),
    ).toBeTruthy();
  });

  it("shows retained logs when a dev server exits before start responds", async () => {
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
      logs: [
        { stream: "stdout", text: "ready", at: 1 },
        {
          stream: "stderr",
          text: "fatal: address became unavailable",
          at: 2,
        },
        {
          stream: "system",
          text: "Dev server exited unexpectedly.",
          at: 3,
        },
      ],
      exited: true,
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    expect(
      await screen.findByText("Dev server exited. Use Preview options to run it again."),
    ).toBeTruthy();
    expect(
      await screen.findByText(/fatal: address became unavailable/),
    ).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
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
    });
    bridgeMock.getSitePreviewLogs.mockReturnValueOnce(exitedLogs.promise);
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await vi.waitFor(() =>
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
      })
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "dev",
        url: "http://127.0.0.1:49153/",
        logs: [{ stream: "stdout", text: "replacement ready", at: 2 }],
        exited: false,
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
    await vi.waitFor(() =>
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

  it("names the byte budget and observed scan size when sharing is refused", async () => {
    const refusedSite: SitePackageInfo = {
      ...site,
      shareManifest: {
        ok: false,
        reason: "byte-budget",
        limitBytes: 4 * 1024 * 1024,
        observedBytes: 5 * 1024 * 1024,
      },
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(refusedSite)
      .mockResolvedValueOnce(refusedSite);
    const user = userEvent.setup();
    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={vi.fn()}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));

    expect(
      await screen.findByText(
        "dohc scanned 5 MiB for sharing. The configured limit is 4 MiB. Reduce the site's referenced files and try again.",
      ),
    ).toBeTruthy();
  });

  it("names the file limit and observed count when sharing is refused", async () => {
    const refusedSite: SitePackageInfo = {
      ...site,
      shareManifest: {
        ok: false,
        reason: "file-count",
        limitFiles: 100,
        observedFiles: 101,
      },
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(refusedSite)
      .mockResolvedValueOnce(refusedSite);
    const user = userEvent.setup();
    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={vi.fn()}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));

    expect(
      await screen.findByText(
        "dohc found 101 files for sharing. The configured limit is 100 files. Remove referenced files and try again.",
      ),
    ).toBeTruthy();
  });

  it.each([
    [
      { ok: false, reason: "unreadable", path: "report/app.js" } as const,
      "dohc could not read report/app.js. Check that the file is readable, then try again.",
    ],
    [
      {
        ok: false,
        reason: "non-file-reference",
        path: "report/assets",
      } as const,
      "dohc found a shared reference that is not a file: report/assets. Replace the reference, then try again.",
    ],
    [
      noRunnableArtifact,
      "This site does not have a runnable static artifact to share.",
    ],
  ])("renders the share refusal reason %#", async (shareManifest, message) => {
    const refusedSite: SitePackageInfo = {
      ...site,
      shareManifest,
    };
    bridgeMock.getSitePackage
      .mockResolvedValueOnce(refusedSite)
      .mockResolvedValueOnce(refusedSite);
    const user = userEvent.setup();
    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={vi.fn()}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));

    expect(await screen.findByText(message)).toBeTruthy();
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
      })
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "static",
        url: "http://127.0.0.1:49153/",
        logs: [],
        exited: false,
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
    await vi.waitFor(() => expect(bridgeMock.getSitePackage).toHaveBeenCalledTimes(2));

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

  it("does not show a stale share-preparation error after site replacement", async () => {
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
      })
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "static",
        url: "http://127.0.0.1:49153/",
        logs: [],
        exited: false,
      });
    const user = userEvent.setup();
    const view = render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onShareSite={vi.fn()}
      />,
    );

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-share"));
    await vi.waitFor(() => expect(bridgeMock.getSitePackage).toHaveBeenCalledTimes(2));

    view.rerender(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="replacement"
        onShareSite={vi.fn()}
      />,
    );
    await screen.findByText("Replacement");

    await act(async () => {
      pendingRefresh.reject(new Error("Stale share refresh failed"));
      await pendingRefresh.promise.catch(() => undefined);
    });

    expect(screen.queryByText("Stale share refresh failed")).toBeNull();
  });

  it("does not repaint the new site with a stale site-load response after switching sites mid-load", async () => {
    const pendingLoad = deferred<SitePackageInfo | null>();
    const replacementSite: SitePackageInfo = {
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      sourceFiles: ["replacement/index.html"],
      shareManifest: readyShare("replacement/index.html"),
    };
    bridgeMock.getSitePackage
      .mockReturnValueOnce(pendingLoad.promise)
      .mockResolvedValueOnce(replacementSite);

    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);
    await vi.waitFor(() => expect(bridgeMock.getSitePackage).toHaveBeenCalledTimes(1));

    view.rerender(<SitePreviewPage workspaceId="ws-sites" siteRoot="replacement" />);
    await screen.findByText("Replacement");

    await act(async () => {
      pendingLoad.resolve(site);
      await pendingLoad.promise;
    });

    expect(screen.queryByText("Report")).toBeNull();
    expect(screen.getByText("Replacement")).toBeTruthy();
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
      });

    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);
    await vi.waitFor(() => expect(bridgeMock.startSitePreview).toHaveBeenCalledTimes(1));

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
      });
      await pendingStart.promise;
    });

    const frameAfter = screen.getByTestId("site-preview-frame");
    expect(new URL(frameAfter.getAttribute("src") ?? "").origin).toBe("http://127.0.0.1:49999");
  });

  it("shares only a package's built browser artifact", () => {
    expect(
      shareTargetForSite({
        ...site,
        kind: "package",
        packagePath: "report/package.json",
        scripts: { build: "vite build" },
        buildOutputs: ["dist"],
        sourceFiles: [
          "report/index.html",
          "report/package.json",
          "report/src/main.tsx",
          "report/dist/index.html",
          "report/dist/assets/main.js",
        ],
        shareManifest: readyShare("report/dist/index.html", [
          "report/dist/assets/main.js",
        ]),
      }),
    ).toEqual({
      paths: ["report/dist/index.html", "report/dist/assets/main.js"],
      label: "Report",
    });
  });

  it("keeps a plain static site shareable when it carries vendored SDK files", () => {
    expect(
      shareTargetForSite({
        ...site,
        packagePath: "report/package.json",
        sourceFiles: [
          "report/index.html",
          "report/app.js",
          "report/package.json",
          "report/vendor/dohc-sdk/dist/index.js",
        ],
        shareManifest: readyShare("report/index.html", [
          "report/app.js",
          "report/vendor/dohc-sdk/dist/index.js",
        ]),
      }),
    ).toEqual({
      paths: [
        "report/index.html",
        "report/app.js",
        "report/vendor/dohc-sdk/dist/index.js",
      ],
      label: "Report",
    });
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
          "vendor/dohc-sdk/dist/index.js",
          "vendor/dohc-sdk/dist/index.d.ts",
          "notes/private.md",
          "projects/other/index.html",
        ],
        shareManifest: readyShare("index.html", [
          "app.js",
          "assets/logo.png",
          "vendor/dohc-sdk/dist/index.js",
        ]),
      }),
    ).toEqual({
      paths: [
        "index.html",
        "app.js",
        "assets/logo.png",
        "vendor/dohc-sdk/dist/index.js",
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
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("This site tried to preview from an address dohc does not trust. Reload the preview.")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
    expect(screen.queryByTestId("site-preview-reload")).toBeNull();
    expect(screen.queryByTestId("site-preview-open-external")).toBeNull();
    expect(screen.getByTestId("site-preview-stop")).toBeTruthy();
  });

  it("refuses to render HTTPS loopback preview URLs", async () => {
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "static",
      url: "https://127.0.0.1:49152/",
      logs: [],
      exited: false,
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("This site tried to preview from an address dohc does not trust. Reload the preview.")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
  });

  it("refuses to render authenticated loopback preview URLs", async () => {
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "static",
      url: "http://user:pass@127.0.0.1:49152/",
      logs: [],
      exited: false,
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("This site tried to preview from an address dohc does not trust. Reload the preview.")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
  });

  it("stops the preview when the page unmounts", async () => {
    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);
    await screen.findByText("Report");
    view.unmount();

    expect(bridgeMock.stopSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
    });
  });

  it("keeps the preview visible and reports stop failures", async () => {
    bridgeMock.stopSitePreview.mockRejectedValueOnce(new Error("Could not stop dev server"));
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-stop"));

    expect(await screen.findByText("Could not stop dev server")).toBeTruthy();
    expect(screen.getByTestId("site-preview-frame")).toBeTruthy();
  });

  it("shows an intentional stopped state after stopping a preview", async () => {
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-stop"));

    expect(await screen.findByText("Preview stopped. Use Preview options to run it again.")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
  });

  it("stays stopped after the user switched preview modes", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
    });
    bridgeMock.startSitePreview
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "dev",
        url: "http://127.0.0.1:49152/",
        logs: [],
        exited: false,
      })
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "static",
        url: "http://127.0.0.1:49153/",
        logs: [],
        exited: false,
      });
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-static"));
    await vi.waitFor(() => expect(bridgeMock.startSitePreview).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("site-preview-stop"));

    expect(await screen.findByText("Preview stopped. Use Preview options to run it again.")).toBeTruthy();
    await act(async () => Promise.resolve());
    expect(bridgeMock.startSitePreview).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
  });

  it("clears a stopped preview when its replacement fails", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite" },
    });
    bridgeMock.startSitePreview
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "dev",
        url: "http://127.0.0.1:49152/",
        logs: [{ stream: "stdout", text: "ready", at: 1 }],
        exited: false,
      })
      .mockRejectedValueOnce(new Error("Replacement preview failed"));
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-static"));

    expect(await screen.findByText("Replacement preview failed")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
    expect(screen.queryByTestId("site-preview-stop")).toBeNull();
  });

  it("resets a manual stop when navigating to a different site", async () => {
    const user = userEvent.setup();
    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-stop"));
    expect(await screen.findByText("Preview stopped. Use Preview options to run it again.")).toBeTruthy();

    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      sourceFiles: ["replacement/index.html"],
      shareManifest: readyShare("replacement/index.html"),
    });
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "replacement",
      mode: "static",
      url: "http://127.0.0.1:49153/",
      logs: [],
      exited: false,
    });
    view.rerender(<SitePreviewPage workspaceId="ws-sites" siteRoot="replacement" />);

    const replacementFrame = await screen.findByTestId("site-preview-frame");
    expect(new URL(replacementFrame.getAttribute("src") ?? "").port).toBe("49153");
    expect(bridgeMock.startSitePreview).toHaveBeenLastCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "replacement",
      mode: "static",
    });
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
