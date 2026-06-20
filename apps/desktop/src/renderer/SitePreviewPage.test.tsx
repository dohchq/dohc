// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DOHC_SDK_PROTOCOL } from "@dohc/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../ipc/bridgeContract";
import { SitePreviewPage } from "./SitePreviewPage";

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
};

const bridgeMock = {
  getSitePackage: vi.fn(async () => site),
  startSitePreview: vi.fn(async () => ({
    siteRoot: "report",
    mode: "static" as const,
    url: "http://127.0.0.1:49152/",
    logs: [],
  })),
  stopSitePreview: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  readWorkspaceText: vi.fn(async () => ({ text: "Quarterly notes", truncated: false })),
};

describe("SitePreviewPage", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts static previews and embeds the local URL", async () => {
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    await user.click(screen.getByTestId("site-preview-static"));

    const frame = await screen.findByTestId("site-preview-frame");
    const frameUrl = new URL(frame.getAttribute("src") ?? "");
    expect(frameUrl.origin).toBe("http://127.0.0.1:49152");
    expect(frameUrl.searchParams.get("dohcHostOrigin")).toBe(window.location.origin);
    expect(bridgeMock.startSitePreview).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      siteRoot: "report",
      mode: "static",
    });
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
    await user.click(screen.getByTestId("site-preview-static"));
    await screen.findByTestId("site-preview-frame");
    await user.click(screen.getByTestId("site-preview-stop"));

    expect(await screen.findByText("Could not stop dev server")).toBeTruthy();
    expect(screen.getByTestId("site-preview-frame")).toBeTruthy();
  });

  it("answers SDK file reads from the active preview iframe", async () => {
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    await user.click(screen.getByTestId("site-preview-static"));

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
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-sites",
        relativePath: "notes/q1.md",
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

  it("rejects SDK file reads with unsafe workspace paths", async () => {
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    await user.click(screen.getByTestId("site-preview-static"));

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
          id: "read-bad",
          method: "files.read",
          params: { path: "../secret.md" },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          protocol: DOHC_SDK_PROTOCOL,
          id: "read-bad",
          ok: false,
          error: {
            code: "DOHC_BAD_REQUEST",
            message: "files.read requires a safe workspace-relative path.",
          },
        },
        "http://127.0.0.1:49152",
      );
    });
    expect(bridgeMock.readWorkspaceText).not.toHaveBeenCalled();
  });

  it("ignores SDK file reads from non-loopback origins", async () => {
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    await user.click(screen.getByTestId("site-preview-static"));

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
    expect(bridgeMock.readWorkspaceText).not.toHaveBeenCalled();
  });

  it("ignores SDK file reads from different loopback ports", async () => {
    const user = userEvent.setup();
    render(<SitePreviewPage workspaceId="ws-sites" siteRoot="report" />);

    await screen.findByText("Report");
    await user.click(screen.getByTestId("site-preview-static"));

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
    expect(bridgeMock.readWorkspaceText).not.toHaveBeenCalled();
  });
});
