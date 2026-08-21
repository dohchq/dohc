// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SitePackageInfo,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { shareTargetForSite, SitePreviewPage } from "./SitePreviewPage";

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
  buildOutputs: [],
  sourceFiles: ["report/index.html"],
  shareManifest: { entryPath: "report/index.html", assets: [] },
  diagnostics: [],
  authority: { kind: "workspace" },
};

const workspaceSettingsResult = {
  settings: DEFAULT_WORKSPACE_SETTINGS,
  source: "default" as const,
};

const bridgeMock = {
  getSitePackage: vi.fn(async (): Promise<SitePackageInfo | null> => site),
  getWorkspaceSettings: vi.fn(async () => workspaceSettingsResult),
  startSitePreview: vi.fn(async (): Promise<StartSitePreviewResult> => ({
    siteRoot: "report",
    mode: "static" as const,
    url: "http://127.0.0.1:49152/",
    logs: [],
  })),
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
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "dev",
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

  it("keeps a stored preview mode over the workspace default", async () => {
    window.localStorage.setItem("dohc.site-preview-mode.v1:ws-sites:report", "static");
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
      shareManifest: { entryPath: "report/dist/index.html", assets: [] },
    });

    render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        sharedView
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
      shareManifest: { entryPath: `${sharedRoot}/dist/index.html`, assets: [] },
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

  it("does not open a stale share dialog when build refresh finishes after site replacement", async () => {
    const pendingRefresh = deferred<SitePackageInfo | null>();
    const buildableSite: SitePackageInfo = {
      ...site,
      kind: "package",
      packagePath: "report/package.json",
      scripts: { dev: "vite", build: "vite build" },
      buildOutputs: ["dist"],
      sourceFiles: ["report/package.json", "report/src/main.tsx"],
      shareManifest: null,
    };
    const replacementSite: SitePackageInfo = {
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      sourceFiles: ["replacement/index.html"],
      shareManifest: { entryPath: "replacement/index.html", assets: [] },
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
      })
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "build",
        url: "http://127.0.0.1:49154/",
        logs: [],
      })
      .mockResolvedValueOnce({
        siteRoot: "replacement",
        mode: "static",
        url: "http://127.0.0.1:49153/",
        logs: [],
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
        shareManifest: { entryPath: "report/dist/index.html", assets: [] },
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
      shareManifest: null,
    };
    const replacementSite: SitePackageInfo = {
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
      sourceFiles: ["replacement/index.html"],
      shareManifest: { entryPath: "replacement/index.html", assets: [] },
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
      })
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "build",
        url: "http://127.0.0.1:49154/",
        logs: [],
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
        shareManifest: {
          entryPath: "report/dist/index.html",
          assets: ["report/dist/assets/main.js"],
        },
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
        shareManifest: {
          entryPath: "report/index.html",
          assets: ["report/app.js", "report/vendor/dohc-sdk/dist/index.js"],
        },
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
        shareManifest: {
          entryPath: "index.html",
          assets: [
            "app.js",
            "assets/logo.png",
            "vendor/dohc-sdk/dist/index.js",
          ],
        },
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
        shareManifest: null,
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
      })
      .mockResolvedValueOnce({
        siteRoot: "report",
        mode: "static",
        url: "http://127.0.0.1:49153/",
        logs: [],
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
      shareManifest: { entryPath: "replacement/index.html", assets: [] },
    });
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "replacement",
      mode: "static",
      url: "http://127.0.0.1:49153/",
      logs: [],
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
