// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DOHC_SDK_PROTOCOL } from "@dohc/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InvokeSiteSdkResult,
  SitePackageInfo,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";
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
  buildOutputs: [],
  sourceFiles: ["report/index.html"],
  diagnostics: [],
  authority: { kind: "workspace" },
};

const bridgeMock = {
  getSitePackage: vi.fn(async (): Promise<SitePackageInfo | null> => site),
  startSitePreview: vi.fn(async (): Promise<StartSitePreviewResult> => ({
    siteRoot: "report",
    mode: "static" as const,
    url: "http://127.0.0.1:49152/",
    logs: [],
    sdkScopeRoot: null,
  })),
  stopSitePreview: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  invokeSiteSdk: vi.fn(async (): Promise<InvokeSiteSdkResult> => ({
    result: { text: "Quarterly notes", truncated: false },
  })),
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
    expect(frameUrl.searchParams.get("dohcHostOrigin")).toBe(window.location.origin);
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
      sdkScopeRoot: null,
    });

    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByTestId("site-preview-frame");
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "dev",
    });
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

    expect(onShareSite).toHaveBeenCalledWith({ paths: ["report"], label: "Report" });
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
      }),
    ).toEqual({ paths: ["report/dist"], label: "Report" });
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
          "notes/private.md",
          "projects/other/index.html",
        ],
      }),
    ).toEqual({
      paths: ["index.html", "app.js", "assets/logo.png"],
      label: "Report",
    });
  });

  it("refuses to render non-loopback preview URLs", async () => {
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "static",
      url: "https://example.com/preview",
      logs: [],
      sdkScopeRoot: null,
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("Preview URL must be an unauthenticated loopback HTTP URL.")).toBeTruthy();
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
      sdkScopeRoot: null,
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("Preview URL must be an unauthenticated loopback HTTP URL.")).toBeTruthy();
    expect(screen.queryByTestId("site-preview-frame")).toBeNull();
  });

  it("refuses to render authenticated loopback preview URLs", async () => {
    bridgeMock.startSitePreview.mockResolvedValueOnce({
      siteRoot: "report",
      mode: "static",
      url: "http://user:pass@127.0.0.1:49152/",
      logs: [],
      sdkScopeRoot: null,
    });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    expect(await screen.findByText("Preview URL must be an unauthenticated loopback HTTP URL.")).toBeTruthy();
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

  it("removes the SDK message listener when the page unmounts", async () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    view.unmount();

    expect(removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    removeEventListener.mockRestore();
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
      sdkScopeRoot: null,
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

  it("answers SDK file reads from the active preview iframe", async () => {
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    const frame = (await screen.findByTestId("site-preview-frame")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:49152",
        source,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-1",
          method: "files.read",
          params: { path: "notes/q1.md" },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(bridgeMock.invokeSiteSdk).toHaveBeenCalledWith({
        workspaceId: "ws-sites",
        siteRoot: "report",
        method: "files.read",
        params: { path: "notes/q1.md" },
      });
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        protocol: DOHC_SDK_PROTOCOL,
        id: "read-1",
        ok: true,
        result: { text: "Quarterly notes", truncated: false },
      },
      "http://127.0.0.1:49152",
    );
  });

  it("drops stale SDK navigation and responses after the site is replaced", async () => {
    const pendingInvocation = deferred<InvokeSiteSdkResult>();
    bridgeMock.invokeSiteSdk.mockReturnValueOnce(pendingInvocation.promise);
    const onOpenPath = vi.fn();
    const view = render(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="report"
        onOpenPath={onOpenPath}
      />,
    );

    const frame = (await screen.findByTestId("site-preview-frame")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:49152",
        source,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "open-stale",
          method: "ui.open",
          params: { target: "notes/stale.md" },
        },
      }),
    );
    await vi.waitFor(() => expect(bridgeMock.invokeSiteSdk).toHaveBeenCalledTimes(1));

    bridgeMock.getSitePackage.mockResolvedValueOnce({
      ...site,
      root: "replacement",
      title: "Replacement",
      entryPath: "replacement/index.html",
    });
    view.rerender(
      <SitePreviewPage
        workspaceId="ws-sites"
        siteRoot="replacement"
        onOpenPath={onOpenPath}
      />,
    );

    await act(async () => {
      pendingInvocation.resolve({ result: { target: "notes/stale.md" } });
      await pendingInvocation.promise;
    });

    expect(onOpenPath).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("ignores SDK messages from a source that is not the preview iframe", async () => {
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    const frame = (await screen.findByTestId("site-preview-frame")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    const fakeSource = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:49152",
        source: fakeSource,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-wrong-source",
          method: "files.read",
          params: { path: "notes/q1.md" },
        },
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(bridgeMock.invokeSiteSdk).not.toHaveBeenCalled();
  });

  it("returns SDK host errors when workspace file reads fail", async () => {
    bridgeMock.invokeSiteSdk.mockRejectedValueOnce(new Error("Could not read notes/q1.md"));
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    const frame = (await screen.findByTestId("site-preview-frame")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:49152",
        source,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-error",
          method: "files.read",
          params: { path: "notes/q1.md" },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-error",
          ok: false,
          error: {
            code: "DOHC_HOST_ERROR",
            message: "Could not read notes/q1.md",
          },
        },
        "http://127.0.0.1:49152",
      );
    });
  });

  it("ignores SDK file reads from non-loopback origins", async () => {
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    const frame = (await screen.findByTestId("site-preview-frame")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://example.com",
        source,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-untrusted",
          method: "files.read",
          params: { path: "notes/q1.md" },
        },
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(bridgeMock.invokeSiteSdk).not.toHaveBeenCalled();
  });

  it("ignores SDK file reads from different loopback ports", async () => {
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");

    const frame = (await screen.findByTestId("site-preview-frame")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: source,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:8080",
        source,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-wrong-port",
          method: "files.read",
          params: { path: "notes/q1.md" },
        },
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(bridgeMock.invokeSiteSdk).not.toHaveBeenCalled();
  });

  it("ignores SDK messages when no preview is active", async () => {
    bridgeMock.getSitePackage.mockResolvedValueOnce({ ...site, entryPath: null });
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:49152",
        source,
        data: {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-no-preview",
          method: "files.read",
          params: { path: "notes/q1.md" },
        },
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(bridgeMock.invokeSiteSdk).not.toHaveBeenCalled();
  });
});
