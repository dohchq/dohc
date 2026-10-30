// @vitest-environment jsdom
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SitePackageInfo } from "../ipc/bridgeContract";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "../ipc/ownerAppPublicationContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { deferred } from "../testing/deferred";
import { APP_CRASHED, APP_DOWNLOAD_BLOCKED, APP_LIMIT, APP_OPEN_FAILED, APP_SESSION_ENDED } from "./AppView";
import { KEYBOARD_NAV_ATTRIBUTE } from "./keyboardNavigation";
import { SitePreviewPage } from "./SitePreviewPage";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

type OpenRequest = { action: "open"; workspaceId: string; appRoot: string; viewId: string; colorScheme: "light" | "dark" };
type AppViewRequest = OpenRequest
  | { action: "close"; workspaceId: string; viewId: string }
  | { action: "colorScheme"; workspaceId: string; colorScheme: "light" | "dark" };
type AppViewResult =
  | { kind: "opened"; viewId: string; publicationId: string; url: string; partition: string }
  | { kind: "unapproved"; viewId: string }
  | { kind: "closed"; viewId: string }
  | { kind: "colorScheme" };
type AppViewEvent =
  | { viewId: string; kind: "approval-ended" }
  | { viewId: string; kind: "session-ended" }
  | { viewId: string; kind: "download-blocked"; filename: string }
  | { viewId: string; kind: "external-link"; url: string }
  | { viewId: string; kind: "shortcut"; key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };

// An owner app with no standalone preview: it opens through approval.
const ownerApp: SitePackageInfo = {
  root: "preorders", title: "Preorders", kind: "static", confidence: "high", entryPath: null, configPath: null,
  packagePath: null, packageManager: null, scripts: {}, configuredScripts: {}, configuredPreviewMode: null,
  configuredBuildOutput: null, buildOutputs: [], sourceFiles: ["preorders/dohc.json", "preorders/app.publish.json", "preorders/frontend.js"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" }, diagnostics: [], authority: { kind: "workspace" },
};
const staticApp: SitePackageInfo = {
  ...ownerApp, root: "report", title: "Report", entryPath: "report/index.html", sourceFiles: ["report/index.html"],
  shareManifest: { ok: true, manifest: { entryPath: "report/index.html", assets: [] } },
};
const publicationId = "d".repeat(64);
const prepared: Extract<OwnerAppPublicationResult, { kind: "prepared" }> = {
  kind: "prepared", approvalId: "af28e679-fb6e-4b69-b852-c6f643e5d7ac", candidateDigest: "a".repeat(64), appRoot: "preorders",
  versionId: "main", sourceRevision: "b".repeat(64), sourcePaths: ["preorders/frontend.js"], capabilities: [], externalNetwork: true, local: true,
};

let approved = true;
let launches = 0;
const opened = (request: OpenRequest): AppViewResult => ({
  kind: "opened", viewId: request.viewId, publicationId, url: `http://127.0.0.1:4310${++launches}/`, partition: `dohc-app-view-${request.viewId}`,
});
const appView = vi.fn(async (request: AppViewRequest): Promise<AppViewResult> => {
  if (request.action === "open") return approved ? opened(request) : { kind: "unapproved", viewId: request.viewId };
  if (request.action === "close") return { kind: "closed", viewId: request.viewId };
  return { kind: "colorScheme" };
});
const eventListeners = new Set<(event: AppViewEvent) => void>();
function emit(event: AppViewEvent) {
  act(() => { for (const listener of eventListeners) listener(event); });
}
async function publication(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> {
  if (request.action === "listLocal") return { kind: "localListed", publications: [] };
  if (request.action === "list") return { kind: "listed", publications: [], nextCursor: null };
  if (request.action === "prepareLocal") return prepared;
  if (request.action === "approve") { approved = true; return { kind: "published", publicationId, authorityRevision: 1, local: true }; }
  if (request.action === "launchLocal") return { kind: "localLaunched", publicationId, url: "http://127.0.0.1:43123/" };
  return { kind: "cancelled" };
}
const publishOwnerApp = vi.fn(publication);
const api = {
  getSitePackage: vi.fn(async ({ path }: { path: string }) => (path === "report" ? staticApp : { ...ownerApp, root: path })),
  getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
  startSitePreview: vi.fn(async () => ({ siteRoot: "report", mode: "static" as const, url: "http://127.0.0.1:49152/", logs: [], exited: false, generation: 1 })),
  getSitePreviewLogs: vi.fn(async () => ({ logs: [], exited: false })),
  stopSitePreview: vi.fn(async () => undefined),
  onSitePreviewReplaced: vi.fn(() => () => undefined),
  readWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: true })),
  onWorkspaceTrustChanged: vi.fn(() => () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  appView,
  onAppViewEvent: vi.fn((listener: (event: AppViewEvent) => void) => {
    eventListeners.add(listener);
    return () => { eventListeners.delete(listener); };
  }),
  publishOwnerApp,
  listRelayShareLinks: vi.fn(async () => ({ supportedLinkAccess: ["view"], links: [], independentGrants: [] })),
  cloudStatus: vi.fn(async () => ({ connected: false, workspaceSynced: false })),
};

// jsdom has no <webview>: it renders as an unknown element, so these stand in for Electron's methods.
const guest = {
  reload: vi.fn(), stop: vi.fn(), goBack: vi.fn(), goForward: vi.fn(),
  canGoBack: vi.fn(() => true), canGoForward: vi.fn(() => true), focus: vi.fn(),
};
const prototype = HTMLUnknownElement.prototype as unknown as Record<string, unknown>;
function webview() {
  return screen.getByTestId("app-view-webview");
}
function fire(type: string, fields: Record<string, unknown> = {}) {
  act(() => { webview().dispatchEvent(Object.assign(new Event(type), fields)); });
}
async function openedView() {
  await screen.findByTestId("app-view-webview");
  fire("did-stop-loading");
}
const viewIdOf = () => (appView.mock.calls.find(([request]) => request.action === "open")![0] as OpenRequest).viewId;
const opens = () => appView.mock.calls.filter(([request]) => request.action === "open").length;
const toolbar = () => within(screen.getByTestId("site-preview-page").querySelector("header")!);

const notices = { report: vi.fn(), clear: vi.fn() };
function Page(props: Partial<ComponentProps<typeof SitePreviewPage>>) {
  return <SitePreviewPage workspaceId="ws-shop" siteRoot="preorders" notices={notices} focused onShowSource={() => undefined}
    onShareSite={() => undefined} {...props} />;
}

describe("an owner app in its tab", () => {
  beforeEach(() => {
    approved = true;
    launches = 0;
    vi.stubGlobal("dohcDesktop", api);
    Object.assign(prototype, guest);
    document.documentElement.dataset.theme = "light";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const name of Object.keys(guest)) delete prototype[name];
    guest.canGoBack.mockReturnValue(true);
    guest.canGoForward.mockReturnValue(true);
    publishOwnerApp.mockImplementation(publication);
  });

  it("lays out the toolbar, and keeps Reload and Open in browser in place but disabled until the app is approved", async () => {
    approved = false;
    render(<Page />);
    expect(await screen.findByText("Review this app to open it here.")).toBeTruthy();
    const header = screen.getByTestId("site-preview-page").querySelector("header")!;
    expect([...header.querySelectorAll("button")].map(button => button.dataset.testid))
      .toEqual(["app-view-reload", "site-preview-show-source", "site-preview-share", "app-view-review", "app-view-open-browser"]);
    expect(header.textContent).toContain("Preorders");
    expect(header.querySelector(".font-mono")).toBeNull();
    expect((screen.getByTestId("app-view-reload") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("app-view-open-browser") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Open in browser" })).toBe(screen.getByTestId("app-view-open-browser"));
    expect(screen.getByRole("button", { name: "Review and open app" })).toBeTruthy();
    expect(screen.queryByTestId("app-view-webview")).toBeNull();
  });

  it("gives a plain preview the same placement", async () => {
    render(<Page siteRoot="report" />);
    await screen.findByTestId("site-preview-frame");
    const header = screen.getByTestId("site-preview-page").querySelector("header")!;
    // The toolbar's own controls, not the rows of the Preview options menu.
    expect([...header.querySelectorAll<HTMLElement>("button, summary")].filter(control => !control.closest("details > div")).map(control => control.dataset.testid))
      .toEqual(["site-preview-reload", "site-preview-show-source", "site-preview-share", "site-preview-review", "site-preview-open-external", "site-preview-options", "site-preview-stop"]);
    expect(screen.getByTestId("site-preview-open-external").getAttribute("aria-label")).toBe("Open in browser");
    expect(screen.queryByTestId("site-preview-publish")).toBeNull();
    expect(appView).not.toHaveBeenCalled();
  });

  it("shows dohc's paper while it checks, then loads the app in a guarded webview", async () => {
    const answer = deferred<AppViewResult>();
    appView.mockImplementationOnce(() => answer.promise);
    render(<Page />);
    expect(await screen.findByTestId("app-view-checking")).toBeTruthy();
    expect((screen.getByTestId("app-view-reload") as HTMLButtonElement).disabled).toBe(true);
    const request = appView.mock.calls[0]![0] as OpenRequest;
    expect(request).toEqual({ action: "open", workspaceId: "ws-shop", appRoot: "preorders", viewId: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), colorScheme: "light" });
    await act(async () => answer.resolve(opened(request)));
    const view = webview();
    expect(view.getAttribute("src")).toBe("http://127.0.0.1:43101/");
    expect(view.getAttribute("partition")).toBe(`dohc-app-view-${request.viewId}`);
    // Until the app paints, the webview shows dohc's paper, not white.
    expect(view.className).toContain("bg-bg");
    expect(view.className).toContain("opacity-0");
    expect(screen.getByTestId("app-view-loading").className).toContain("dohc-reveal-if-slow");
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop loading" }));
    expect(guest.stop).toHaveBeenCalledOnce();
    fire("did-stop-loading");
    expect(webview().className).not.toContain("opacity-0");
    expect(screen.queryByTestId("app-view-loading")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload app" }));
    expect(guest.reload).toHaveBeenCalledOnce();
    fire("did-start-loading");
    expect(screen.getByRole("button", { name: "Stop loading" })).toBe(screen.getByTestId("app-view-reload"));
  });

  it("opens the app here once it is approved, and moves focus into it when the review closes", async () => {
    approved = false;
    const user = userEvent.setup();
    render(<Page />);
    await user.click(await screen.findByRole("button", { name: "Review and open app" }));
    await user.click(await screen.findByRole("button", { name: "Prepare for this device" }));
    await user.click(await screen.findByRole("button", { name: "Approve for this device" }));
    await screen.findByTestId("app-view-webview");
    expect(opens()).toBe(2);
    // The dialog is still open, so focus waits.
    expect(guest.focus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close publication" }));
    await waitFor(() => expect(guest.focus).toHaveBeenCalled());
    expect(guest.focus.mock.contexts.at(-1)).toBe(webview());
  });

  it("reports a failed open once, offers Try again in the body, and takes the notice back when the app opens", async () => {
    const cause = new Error("engine stopped");
    appView.mockRejectedValueOnce(cause);
    render(<Page />);
    const retry = await screen.findByTestId("app-view-retry");
    expect(screen.getByTestId("site-preview-page").textContent).not.toContain(APP_OPEN_FAILED);
    expect(notices.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: APP_OPEN_FAILED, cause, retry: expect.any(Function) }));
    const identity = notices.report.mock.calls[0]![0].identity as string;
    await userEvent.setup().click(within(retry).getByRole("button", { name: "Try again" }));
    await openedView();
    expect(notices.clear).toHaveBeenCalledWith(identity);
  });

  it("uses main's words when too many apps are open", async () => {
    appView.mockRejectedValueOnce(new Error(APP_LIMIT));
    render(<Page />);
    await screen.findByTestId("app-view-retry");
    expect(notices.report).toHaveBeenCalledWith(expect.objectContaining({ message: APP_LIMIT }));
  });

  it("fails on a main-frame load error or a crash, and ignores aborts and subframes", async () => {
    render(<Page />);
    await openedView();
    fire("did-fail-load", { isMainFrame: true, errorCode: -3, errorDescription: "ERR_ABORTED" });
    fire("did-fail-load", { isMainFrame: false, errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED" });
    expect(notices.report).not.toHaveBeenCalled();
    fire("did-fail-load", { isMainFrame: true, errorCode: -102, errorDescription: "ERR_CONNECTION_REFUSED" });
    expect(screen.getByTestId("app-view-retry")).toBeTruthy();
    expect(screen.queryByTestId("app-view-webview")).toBeNull();
    expect(notices.report).toHaveBeenLastCalledWith(expect.objectContaining({ message: APP_OPEN_FAILED }));
    // Reload in the toolbar relaunches a failed app.
    await userEvent.setup().click(screen.getByTestId("app-view-reload"));
    await openedView();
    expect(opens()).toBe(2);
    fire("render-process-gone", { details: { reason: "crashed", exitCode: 1 } });
    expect(notices.report).toHaveBeenLastCalledWith(expect.objectContaining({ message: APP_CRASHED }));
    expect(screen.getByTestId("app-view-retry")).toBeTruthy();
  });

  it("closes the app when its approval ends, and says so after a relaunch finds it unapproved", async () => {
    render(<Page />);
    await openedView();
    emit({ viewId: viewIdOf(), kind: "approval-ended" });
    expect(screen.getByText("This app's approval ended. Review it to open it again.")).toBeTruthy();
    expect(screen.queryByTestId("app-view-webview")).toBeNull();
    expect((screen.getByTestId("app-view-reload") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("app-view-open-browser") as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    render(<Page />);
    await openedView();
    fire("render-process-gone", { details: { reason: "crashed", exitCode: 1 } });
    approved = false;
    await userEvent.setup().click(within(screen.getByTestId("app-view-retry")).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This app's approval ended. Review it to open it again.")).toBeTruthy();
  });

  it("keeps a visible page when its session ends, and offers Reload in Notices", async () => {
    render(<Page />);
    await openedView();
    emit({ viewId: viewIdOf(), kind: "session-ended" });
    expect(webview()).toBeTruthy();
    expect(opens()).toBe(1);
    const notice = notices.report.mock.calls[0]![0];
    expect(notice).toEqual(expect.objectContaining({ message: APP_SESSION_ENDED, retry: null, action: expect.objectContaining({ label: "Reload" }) }));
    act(() => notice.action.run());
    await waitFor(() => expect(opens()).toBe(2));
    await openedView();
    expect(notices.clear).toHaveBeenCalledWith(notice.identity);
  });

  it("opens a hidden app again when its tab shows, without a notice", async () => {
    const view = render(<Page visible={false} focused={false} />);
    await openedView();
    emit({ viewId: viewIdOf(), kind: "session-ended" });
    expect(notices.report).not.toHaveBeenCalled();
    expect(opens()).toBe(1);
    view.rerender(<Page visible focused />);
    await waitFor(() => expect(opens()).toBe(2));
  });

  it("files one download notice per tab, replaced by the next, with Open in browser", async () => {
    render(<Page />);
    await openedView();
    emit({ viewId: viewIdOf(), kind: "download-blocked", filename: "receipt.pdf" });
    emit({ viewId: viewIdOf(), kind: "download-blocked", filename: "invoice.pdf" });
    const [first, second] = notices.report.mock.calls.map(([notice]) => notice);
    expect(first).toEqual(expect.objectContaining({ title: "dohc didn't download receipt.pdf", message: APP_DOWNLOAD_BLOCKED, retry: null }));
    expect(second).toEqual(expect.objectContaining({ title: "dohc didn't download invoice.pdf", identity: first.identity }));
    expect(second.action.label).toBe("Open in browser");
    expect(screen.getByTestId("site-preview-page").textContent).not.toContain("download");
    await act(async () => second.action.run());
    expect(publishOwnerApp).toHaveBeenCalledWith({ action: "launchLocal", workspaceId: "ws-shop", publicationId });
    expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "http://127.0.0.1:43123/" });
  });

  it("opens outside links through dohc's link path, and ignores another view's events", async () => {
    render(<Page />);
    await openedView();
    emit({ viewId: "another-view", kind: "external-link", url: "https://example.com/other" });
    emit({ viewId: viewIdOf(), kind: "external-link", url: "https://example.com/terms" });
    await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "https://example.com/terms" }));
  });

  it("handles keys typed in the app as dohc would", async () => {
    render(<Page />);
    await openedView();
    const key = (key: string, code: string, modifiers: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) =>
      emit({ viewId: viewIdOf(), kind: "shortcut", key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });
    key("F5", "F5");
    key("r", "KeyR", { ctrlKey: true });
    expect(guest.reload).toHaveBeenCalledTimes(2);
    key("ArrowLeft", "ArrowLeft", { altKey: true });
    expect(guest.goBack).toHaveBeenCalledOnce();
    guest.canGoForward.mockReturnValue(false);
    key("ArrowRight", "ArrowRight", { altKey: true });
    expect(guest.goForward).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute(KEYBOARD_NAV_ATTRIBUTE)).toBe(false);
    key("F6", "F6");
    expect(document.activeElement).toBe(screen.getByTestId("app-view-reload"));
    expect(document.documentElement.hasAttribute(KEYBOARD_NAV_ATTRIBUTE)).toBe(true);
    document.documentElement.removeAttribute(KEYBOARD_NAV_ATTRIBUTE);
    const seen: KeyboardEvent[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event);
    window.addEventListener("keydown", listen);
    key("p", "KeyP", { ctrlKey: true });
    window.removeEventListener("keydown", listen);
    expect(seen.map(event => [event.key, event.code, event.ctrlKey, event.shiftKey, event.altKey, event.metaKey]))
      .toEqual([["p", "KeyP", true, false, false, false]]);
  });

  it("puts focus in the app when its tab becomes the focused one", async () => {
    const view = render(<Page focused={false} />);
    await openedView();
    expect(guest.focus).not.toHaveBeenCalled();
    view.rerender(<Page focused />);
    expect(guest.focus).toHaveBeenCalledOnce();
    expect(guest.focus.mock.contexts[0]).toBe(webview());
  });

  it("leaves focus where it went if the tab lost focus before the app opened", async () => {
    const slow = deferred<AppViewResult>();
    appView.mockImplementationOnce(() => slow.promise);
    const view = render(<Page focused />);
    await waitFor(() => expect(opens()).toBe(1));
    view.rerender(<Page focused={false} />);
    await act(async () => slow.resolve(opened(appView.mock.calls[0]![0] as OpenRequest)));
    await openedView();
    expect(guest.focus).not.toHaveBeenCalled();
  });

  it("passes dohc's theme to the app and follows it", async () => {
    document.documentElement.dataset.theme = "dark";
    render(<Page />);
    await openedView();
    expect(appView.mock.calls[0]![0]).toEqual(expect.objectContaining({ colorScheme: "dark" }));
    act(() => { document.documentElement.dataset.theme = "light"; });
    await waitFor(() => expect(appView).toHaveBeenCalledWith({ action: "colorScheme", workspaceId: "ws-shop", colorScheme: "light" }));
  });

  it("opens the app in the browser from the toolbar, and refuses an address off this device", async () => {
    const reportError = vi.fn();
    render(<Page reportError={reportError} />);
    await openedView();
    await userEvent.setup().click(screen.getByTestId("app-view-open-browser"));
    expect(publishOwnerApp).toHaveBeenCalledWith({ action: "launchLocal", workspaceId: "ws-shop", publicationId });
    expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "http://127.0.0.1:43123/" });
    publishOwnerApp.mockResolvedValueOnce({ kind: "localLaunched", publicationId, url: "http://localhost:43123/" });
    await userEvent.setup().click(screen.getByTestId("app-view-open-browser"));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not open this app in your browser.", expect.any(Error), expect.any(Function)));
    expect(api.openExternalUrl).toHaveBeenCalledOnce();
  });

  it("drops a browser open that answers after its tab closed or moved to another workspace", async () => {
    const reportError = vi.fn();
    let launch = deferred<OwnerAppPublicationResult>();
    publishOwnerApp.mockImplementation((request) => (request.action === "launchLocal" ? launch.promise : publication(request)));
    const view = render(<Page workspaceId="ws-old" reportError={reportError} />);
    await openedView();
    await userEvent.setup().click(screen.getByTestId("app-view-open-browser"));
    view.rerender(<Page workspaceId="ws-shop" reportError={reportError} />);
    await waitFor(() => expect(appView).toHaveBeenCalledWith(expect.objectContaining({ action: "open", workspaceId: "ws-shop" })));
    await act(async () => launch.reject(new Error("engine stopped")));
    await openedView();
    launch = deferred<OwnerAppPublicationResult>();
    await userEvent.setup().click(screen.getByTestId("app-view-open-browser"));
    view.unmount();
    await act(async () => launch.resolve({ kind: "localLaunched", publicationId, url: "http://127.0.0.1:43123/" }));
    expect(reportError).not.toHaveBeenCalled();
    expect(api.openExternalUrl).not.toHaveBeenCalled();
  });

  it("ends the view and its notices when the tab closes", async () => {
    appView.mockRejectedValueOnce(new Error("engine stopped"));
    const view = render(<Page />);
    await screen.findByTestId("app-view-retry");
    const identity = notices.report.mock.calls[0]![0].identity as string;
    view.unmount();
    expect(appView).toHaveBeenLastCalledWith({ action: "close", workspaceId: "ws-shop", viewId: viewIdOf() });
    expect(notices.clear).toHaveBeenCalledWith(identity);
  });

  it("never paints a slow answer for another workspace's app", async () => {
    const slow = deferred<AppViewResult>();
    appView.mockImplementationOnce(() => slow.promise);
    const view = render(<Page workspaceId="ws-old" />);
    await waitFor(() => expect(opens()).toBe(1));
    const stale = appView.mock.calls[0]![0] as OpenRequest;
    view.rerender(<Page workspaceId="ws-shop" />);
    await waitFor(() => expect(appView).toHaveBeenCalledWith(expect.objectContaining({ action: "open", workspaceId: "ws-shop" })));
    await screen.findByTestId("app-view-webview");
    const fresh = webview().getAttribute("src");
    expect(appView).toHaveBeenCalledWith({ action: "close", workspaceId: "ws-old", viewId: stale.viewId });
    await act(async () => slow.resolve({ kind: "opened", viewId: stale.viewId, publicationId, url: "http://127.0.0.1:49999/", partition: "stale" }));
    expect(webview().getAttribute("src")).toBe(fresh);
    expect(toolbar().getByText("Preorders")).toBeTruthy();
  });
});
