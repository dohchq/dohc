import { AlertTriangle, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";

// The tab surface for a wrapper plugin's embedded web app. The app itself
// renders in a main-process WebContentsView layered over this page, so this
// component never receives the guest URL — it starts the app, then keeps
// main told where the placeholder is. Every response and bounds report is
// guarded by the mount's own request token: a slow response for one
// workspace must never repaint or reposition another's view.

type LoadState =
  | { status: "starting" }
  | { status: "ready"; title: string }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export function PluginWebAppPage(props: {
  workspaceId: string;
  pluginId: string;
  webAppId: string;
  /** True while the shell paints a full-screen overlay — a dialog, the
   * command palette, quick open. The guest is a main-process view layered
   * over this page, so it composites above every overlay and would take the
   * clicks meant for one. Nothing in the renderer can cover it; only main can
   * hide it, and this is how main is told. */
  hiddenByOverlay?: boolean;
  /** Reports the manifest title this app started under, so the tab can carry
   * the name the user installed instead of the raw web app id. */
  onTitle?: (pluginId: string, webAppId: string, title: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "starting" });
  const startRequestRef = useRef(0);
  // Held in a ref so a new callback identity never restarts the app.
  const onTitleRef = useRef(props.onTitle);
  onTitleRef.current = props.onTitle;
  const contextRef = useRef("");
  const context = `${props.workspaceId}\0${props.pluginId}\0${props.webAppId}`;
  contextRef.current = context;

  useEffect(() => {
    const request = ++startRequestRef.current;
    const requestContext = context;
    setLoad({ status: "starting" });
    const isCurrent = () =>
      request === startRequestRef.current &&
      requestContext === contextRef.current;

    void bridge()
      .startPluginWebApp({
        workspaceId: props.workspaceId,
        pluginId: props.pluginId,
        webAppId: props.webAppId,
      })
      .then((result) => {
        if (!isCurrent()) return;
        if (result.status === "not-registered") {
          setLoad({ status: "unavailable" });
          return;
        }
        setLoad({ status: "ready", title: result.title });
        onTitleRef.current?.(props.pluginId, props.webAppId, result.title);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setLoad({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "The plugin app could not start.",
        });
      });

    return () => {
      startRequestRef.current += 1;
      void bridge()
        .stopPluginWebApp({
          workspaceId: props.workspaceId,
          pluginId: props.pluginId,
          webAppId: props.webAppId,
        })
        .catch(() => undefined);
    };
  }, [props.pluginId, props.webAppId, props.workspaceId, context]);

  // While ready, keep main told where the placeholder sits. The container
  // resizes with every layout change that moves it (sidebar, group splits),
  // so a ResizeObserver plus window resize covers repositioning.
  const ready = load.status === "ready";
  const hiddenByOverlay = props.hiddenByOverlay ?? false;
  useEffect(() => {
    if (!ready) return;
    const request = startRequestRef.current;
    const requestContext = contextRef.current;
    let frame: number | null = null;

    const report = (): void => {
      frame = null;
      if (
        request !== startRequestRef.current ||
        requestContext !== contextRef.current
      ) {
        return;
      }
      const element = containerRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      void bridge()
        .setPluginWebAppBounds({
          workspaceId: props.workspaceId,
          pluginId: props.pluginId,
          webAppId: props.webAppId,
          bounds,
          visible: !hiddenByOverlay && bounds.width > 0 && bounds.height > 0,
        })
        .catch(() => undefined);
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(report);
    };

    report();
    const observer = new ResizeObserver(schedule);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [props.pluginId, props.webAppId, props.workspaceId, ready, hiddenByOverlay]);

  return (
    <div
      data-testid="plugin-web-app-page"
      className="flex min-h-0 flex-1 flex-col bg-bg"
    >
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
        <Plug size={14} aria-hidden className="text-subtle" />
        <span className="truncate text-[13px] font-medium text-ink">
          {load.status === "ready" ? load.title : props.webAppId}
        </span>
        <span className="truncate font-mono text-[11px] text-subtle">
          {props.pluginId}
        </span>
      </header>

      {load.status === "starting" ? (
        <div
          data-testid="plugin-web-app-starting"
          className="flex flex-1 items-center justify-center text-sm text-subtle"
        >
          Starting the app. The first start can take a minute.
        </div>
      ) : load.status === "error" ? (
        <div
          role="alert"
          aria-label="dohc could not open the plugin app"
          data-testid="plugin-web-app-error"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <AlertTriangle size={20} aria-hidden className="text-warning" />
          <span className="text-sm text-ink">dohc could not open the plugin app</span>
          <span className="max-w-sm text-xs text-muted">{load.message}</span>
          <span className="max-w-sm text-xs text-muted">
            Close this tab and try again.
          </span>
        </div>
      ) : load.status === "unavailable" ? (
        <div
          role="alert"
          aria-label="This plugin is not running yet."
          data-testid="plugin-web-app-unavailable"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <Plug size={20} aria-hidden className="text-subtle" />
          <span className="text-sm text-ink">This plugin is not running yet.</span>
          <span className="max-w-sm text-xs text-muted">
            Open the app from the plugin settings to start it.
          </span>
        </div>
      ) : (
        <div
          ref={containerRef}
          data-testid="plugin-web-app-frame"
          className="min-h-0 flex-1 bg-bg"
        />
      )}
    </div>
  );
}
