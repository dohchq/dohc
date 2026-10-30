import { Globe2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { openLinkExternally } from "./linkActivation";
import { localLaunchUrl, openLocalApp } from "./OwnerAppPublication";
import { PrimaryButton, RetryRow } from "./ui/controls";

type Api = ReturnType<typeof bridge>;
type AppViewEvent = Parameters<Parameters<Api["onAppViewEvent"]>[0]>[0];
type Shortcut = Extract<AppViewEvent, { kind: "shortcut" }>;
type ColorScheme = "light" | "dark";
type ReportError = (fallback: string, error: unknown, retry: (() => void) | null) => void;

/** The shell's Notices, by identity: a report replaces the row of the same identity, and clear takes it back. */
export type AppViewNotices = {
  report(notice: {
    identity: string;
    title?: string;
    message: string;
    cause?: unknown;
    retry?: (() => void) | null;
    action?: { label: string; run: () => void; ends?: boolean };
  }): void;
  clear(identity: string): void;
};

export const APP_OPEN_FAILED = "dohc could not open this app.";
export const APP_CRASHED = "This app stopped working.";
export const APP_LIMIT = "Close another app before opening this one.";
export const APP_SESSION_ENDED = "This app lost its connection to dohc.";
export const APP_DOWNLOAD_BLOCKED = "Apps in dohc can't save files. Open the app in your browser to download it.";
const BROWSER_OPEN_FAILED = "dohc could not open this app in your browser.";
// A load the app replaced before it finished, such as a second click.
const LOAD_ABORTED = -3;

function readTheme(): ColorScheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

type ViewState =
  | { status: "checking" }
  // `ended`: this view had opened the app, so its approval ended since.
  | { status: "unapproved"; ended: boolean }
  // `launch` keys the webview, so each launch gets a new guest.
  | { status: "open"; url: string; partition: string; launch: number }
  | { status: "failed" };

export type AppView = ReturnType<typeof useAppView>;

/**
 * An approved owner app in this tab: one view of it in main, shown in a webview main guards. `approvals` changes after
 * anything that may change this device's approvals. While `holdFocus` is set, such as while the review dialog is open,
 * focus waits to move into the app.
 */
export function useAppView(options: {
  workspaceId: string;
  appRoot: string;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  approvals: number;
  holdFocus: boolean;
  notices?: AppViewNotices | undefined;
  reportError?: ReportError | undefined;
}) {
  const { workspaceId, appRoot, enabled } = options;
  const viewId = useRef(crypto.randomUUID()).current;
  const failureId = `app-view:${viewId}`;
  const sessionId = `app-view-session:${viewId}`;
  const downloadId = `app-view-download:${viewId}`;
  const [state, setState] = useState<ViewState>({ status: "checking" });
  const [loading, setLoading] = useState(false);
  // The first load finished, so the app has painted. Until then the webview shows dohc's paper.
  const [painted, setPainted] = useState(false);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const webview = useRef<Electron.WebviewTag | null>(null);
  const toolbarStart = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;
  const request = useRef(0);
  const launches = useRef(0);
  const alive = useRef(false);
  const opened = useRef(false);
  const sessionEnded = useRef(false);
  const relaunchWhenShown = useRef(false);
  const wantsFocus = useRef(false);

  const tryFocus = useCallback(() => {
    if (!wantsFocus.current || latest.current.holdFocus || !webview.current) return;
    wantsFocus.current = false;
    webview.current.focus();
  }, []);

  const fail = useCallback((message: string, cause: unknown) => {
    setState({ status: "failed" });
    setLoading(false);
    latest.current.notices?.report({ identity: failureId, message, cause, retry: () => void launchRef.current() });
  }, [failureId]);

  const launch = useCallback(async () => {
    if (!alive.current) return;
    const mine = ++request.current;
    const { workspaceId, appRoot, notices } = latest.current;
    const current = () => alive.current && mine === request.current &&
      latest.current.workspaceId === workspaceId && latest.current.appRoot === appRoot;
    sessionEnded.current = false;
    setState({ status: "checking" });
    setLoading(false);
    setPainted(false);
    try {
      const result = await bridge().appView({ action: "open", workspaceId, appRoot, viewId, colorScheme: readTheme() });
      if (!current()) return;
      if (result.kind === "unapproved" && result.viewId === viewId) {
        notices?.clear(failureId);
        setState({ status: "unapproved", ended: opened.current });
        return;
      }
      if (result.kind !== "opened" || result.viewId !== viewId || !localLaunchUrl(result.url)) throw new Error(APP_OPEN_FAILED);
      opened.current = true;
      notices?.clear(failureId);
      notices?.clear(sessionId);
      setPublicationId(result.publicationId);
      setLoading(true);
      setState({ status: "open", url: result.url, partition: result.partition, launch: ++launches.current });
    } catch (error) {
      if (!current()) return;
      fail(ipcErrorMessage(error, "").includes(APP_LIMIT) ? APP_LIMIT : APP_OPEN_FAILED, error);
    }
  }, [fail, failureId, sessionId, viewId]);
  const launchRef = useRef(launch);
  launchRef.current = launch;

  // One view per app this page shows. Closing it, or showing another app, ends the view and its session.
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    opened.current = false;
    relaunchWhenShown.current = false;
    wantsFocus.current = latest.current.focused;
    setPublicationId(null);
    void launch();
    return () => {
      alive.current = false;
      request.current += 1;
      void bridge().appView({ action: "close", workspaceId, viewId }).catch(() => undefined);
      // Their Try again and Reload act on this view.
      latest.current.notices?.clear(failureId);
      latest.current.notices?.clear(sessionId);
    };
  }, [enabled, workspaceId, appRoot, launch, viewId, failureId, sessionId]);

  const reload = useCallback(() => {
    if (stateRef.current.status === "failed" || sessionEnded.current) void launch();
    else webview.current?.reload();
  }, [launch]);

  // Today's path: launch the approved app for the browser and hand it its loopback address.
  const openInBrowser = useCallback(async () => {
    if (!publicationId) return;
    const { workspaceId, reportError } = latest.current;
    const again = () => void openInBrowserRef.current();
    try {
      await openLocalApp(bridge(), workspaceId, publicationId, () => true);
    } catch (cause) {
      reportError?.(BROWSER_OPEN_FAILED, cause, again);
    }
  }, [publicationId]);
  const openInBrowserRef = useRef(openInBrowser);
  openInBrowserRef.current = openInBrowser;

  const navigate = useCallback((direction: "back" | "forward") => {
    const element = webview.current;
    if (!element) return;
    if (direction === "back" && element.canGoBack()) element.goBack();
    if (direction === "forward" && element.canGoForward()) element.goForward();
  }, []);

  // Keys typed in the app never reach dohc's window. Main forwards these, and dohc handles them as if they had.
  const onShortcut = useCallback((event: Shortcut) => {
    const primary = event.ctrlKey || event.metaKey;
    if (event.key === "F5" || (primary && event.key.toLowerCase() === "r")) reload();
    else if (event.altKey && event.key === "ArrowLeft") navigate("back");
    else if (event.altKey && event.key === "ArrowRight") navigate("forward");
    else if (event.key === "F6") toolbarStart.current?.focus();
    else {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
        altKey: event.altKey, metaKey: event.metaKey, bubbles: true, cancelable: true,
      }));
    }
  }, [navigate, reload]);

  useEffect(() => {
    if (!enabled) return;
    return bridge().onAppViewEvent((event) => {
      if (event.viewId !== viewId || !alive.current) return;
      const { notices } = latest.current;
      if (event.kind === "approval-ended") {
        request.current += 1;
        notices?.clear(failureId);
        notices?.clear(sessionId);
        setLoading(false);
        setState({ status: "unapproved", ended: true });
      } else if (event.kind === "session-ended") {
        // Never tear down a page the person is using. A hidden one opens again when it shows.
        if (!latest.current.visible) {
          relaunchWhenShown.current = true;
          return;
        }
        sessionEnded.current = true;
        notices?.report({ identity: sessionId, message: APP_SESSION_ENDED, retry: null,
          action: { label: "Reload", run: () => void launchRef.current(), ends: true } });
      } else if (event.kind === "download-blocked") {
        notices?.report({ identity: downloadId, title: `Didn't download ${event.filename}`, message: APP_DOWNLOAD_BLOCKED, retry: null,
          action: { label: "Open in browser", run: () => void openInBrowserRef.current(), ends: true } });
      } else if (event.kind === "external-link") {
        void openLinkExternally(event.url);
      } else if (event.kind === "shortcut") {
        onShortcut(event);
      }
    });
  }, [enabled, viewId, failureId, sessionId, downloadId, onShortcut]);

  useEffect(() => {
    if (!options.visible || !relaunchWhenShown.current) return;
    relaunchWhenShown.current = false;
    void launch();
  }, [options.visible, launch]);

  const sentTheme = useRef(theme);
  useEffect(() => {
    if (sentTheme.current === theme) return;
    sentTheme.current = theme;
    if (!enabled) return;
    void bridge().appView({ action: "colorScheme", workspaceId, colorScheme: theme }).catch(() => undefined);
  }, [enabled, theme, workspaceId]);

  // Switching to the tab, or clicking it, puts focus in the app.
  const wasFocused = useRef(options.focused);
  useEffect(() => {
    const before = wasFocused.current;
    wasFocused.current = options.focused;
    if (!options.focused || before) return;
    wantsFocus.current = true;
    tryFocus();
  }, [options.focused, tryFocus]);
  useEffect(() => {
    if (!options.holdFocus) tryFocus();
  }, [options.holdFocus, tryFocus]);

  // Approving the app opens it here, and focus follows it in.
  const approvalsSeen = useRef(options.approvals);
  useEffect(() => {
    if (approvalsSeen.current === options.approvals) return;
    approvalsSeen.current = options.approvals;
    if (stateRef.current.status !== "unapproved") return;
    wantsFocus.current = true;
    void launch();
  }, [options.approvals, launch]);

  const attach = useCallback((element: Electron.WebviewTag | null) => {
    if (!element) return;
    webview.current = element;
    const started = () => setLoading(true);
    const stopped = () => {
      setLoading(false);
      setPainted(true);
    };
    const failed = (event: Event) => {
      const { isMainFrame, errorCode, errorDescription } = event as Electron.DidFailLoadEvent;
      if (!isMainFrame || errorCode === LOAD_ABORTED) return;
      fail(APP_OPEN_FAILED, new Error(`${errorDescription} (${errorCode})`));
    };
    const gone = (event: Event) =>
      fail(APP_CRASHED, new Error(`Reason: ${(event as Electron.RenderProcessGoneEvent).details?.reason ?? "unknown"}`));
    element.addEventListener("did-start-loading", started);
    element.addEventListener("did-stop-loading", stopped);
    element.addEventListener("did-fail-load", failed);
    element.addEventListener("render-process-gone", gone);
    tryFocus();
    return () => {
      element.removeEventListener("did-start-loading", started);
      element.removeEventListener("did-stop-loading", stopped);
      element.removeEventListener("did-fail-load", failed);
      element.removeEventListener("render-process-gone", gone);
      if (webview.current === element) webview.current = null;
    };
  }, [fail, tryFocus]);

  return {
    state,
    loading,
    painted,
    attach,
    toolbarStart,
    canReload: state.status === "open" || state.status === "failed",
    canOpenInBrowser: publicationId !== null && (state.status === "open" || state.status === "failed"),
    reload,
    stop: () => webview.current?.stop(),
    relaunch: () => void launch(),
    openInBrowser,
    navigate,
  };
}

/** The tab's body under its toolbar. Only this part changes with the app's state. */
export function AppViewBody(props: { view: AppView; onReview: () => void }) {
  const { view } = props;
  const { state } = view;
  if (state.status === "checking") return <div data-testid="app-view-checking" className="flex-1 bg-bg" />;
  if (state.status === "failed") {
    return <div className="flex flex-1 items-center justify-center px-6"><RetryRow testId="app-view-retry" onRetry={view.relaunch} /></div>;
  }
  if (state.status === "unapproved") {
    return (
      <div data-testid="app-view-unapproved" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Globe2 size={24} aria-hidden className="text-subtle" />
        <p className="m-0 max-w-sm text-sm text-muted">
          {state.ended ? "This app's approval ended. Review it to open it again." : "Review this app to open it here."}
        </p>
        <PrimaryButton onClick={props.onReview}>Review and open app</PrimaryButton>
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Main attaches only this view's loopback address in this view's partition. */}
      <webview key={state.launch} ref={view.attach} data-testid="app-view-webview" src={state.url} partition={state.partition}
        className={`min-h-0 flex-1 bg-bg ${view.painted ? "" : "opacity-0"}`} />
      {view.loading ? (
        <div data-testid="app-view-loading" role="progressbar" aria-label="Loading app"
          className="dohc-reveal-if-slow pointer-events-none absolute inset-x-0 top-0 h-0.5">
          <div className="size-full animate-pulse bg-accent" />
        </div>
      ) : null}
    </div>
  );
}
