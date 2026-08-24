import {
  DOHC_SDK_PROTOCOL,
  DOHC_THEME_PROTOCOL,
  type DohcSdkEventMessage,
  type DohcSdkResponseMessage,
  type DohcThemeMessage,
} from "@dohc/sdk";
import { AlertTriangle, Plug } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StartPluginPanelResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { THEME_ATTRIBUTES, readDohcTheme } from "./pluginPanelTheme";
import {
  frameUrlWithHostOrigin,
  isActiveFrameOrigin,
  isDohcSdkRequest,
  isLoopbackOrigin,
  sdkErrorResponse,
} from "./sdkFrame";

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      panel: Extract<StartPluginPanelResult, { status: "ok" }>;
    }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export function PluginPanelPage(props: {
  workspaceId: string;
  pluginId: string;
  panelId: string;
  onOpenPath?: (path: string) => void;
  /** The panel asked dohc to open one instance of its plugin's own web app.
   * It runs under the same liveness guards as onOpenPath: a panel that went
   * stale while the request ran never opens a tab. */
  onOpenWebApp?: (
    pluginId: string,
    webAppId: string,
    instanceKey: string,
  ) => void;
  /** Where this panel is mounted, in the manifest's own words. "view" is the
   * side panel, which draws its own header; main refuses a panel the plugin
   * placed elsewhere. */
  placement: "editor" | "view";
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [restart, setRestart] = useState(0);
  const panelRef = useRef<
    Extract<StartPluginPanelResult, { status: "ok" }> | null
  >(null);
  const startRequestRef = useRef(0);
  const sdkGenerationRef = useRef(0);
  const sdkContextRef = useRef("");
  const stoppingRef = useRef(false);
  const invalidatedSurfaceIdsRef = useRef(new Set<number>());
  const sdkContext = `${props.workspaceId}\0${props.pluginId}\0${props.panelId}`;
  sdkContextRef.current = sdkContext;

  useEffect(() => {
    return () => {
      startRequestRef.current += 1;
      sdkGenerationRef.current += 1;
      stoppingRef.current = true;
      panelRef.current = null;
      invalidatedSurfaceIdsRef.current.clear();
      void bridge()
        .stopPluginPanel({
          workspaceId: props.workspaceId,
          pluginId: props.pluginId,
          panelId: props.panelId,
        })
        .catch(() => undefined);
    };
  }, [props.panelId, props.placement, props.pluginId, props.workspaceId]);

  useEffect(() => {
    const request = ++startRequestRef.current;
    const requestContext = sdkContext;
    sdkGenerationRef.current += 1;
    stoppingRef.current = false;
    panelRef.current = null;
    setLoad({ status: "loading" });

    void bridge()
      .startPluginPanel({
        workspaceId: props.workspaceId,
        pluginId: props.pluginId,
        panelId: props.panelId,
        placement: props.placement,
      })
      .then((result) => {
        if (
          request !== startRequestRef.current ||
          requestContext !== sdkContextRef.current ||
          stoppingRef.current
        ) {
          return;
        }
        if (result.status === "not-registered") {
          setLoad({ status: "unavailable" });
          return;
        }
        if (invalidatedSurfaceIdsRef.current.delete(result.surfaceId)) {
          setRestart((value) => value + 1);
          return;
        }
        sdkGenerationRef.current += 1;
        panelRef.current = result;
        setLoad({ status: "ready", panel: result });
      })
      .catch((error: unknown) => {
        if (
          request !== startRequestRef.current ||
          requestContext !== sdkContextRef.current ||
          stoppingRef.current
        ) {
          return;
        }
        setLoad({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "The plugin panel could not start.",
        });
      });

    return () => {
      startRequestRef.current += 1;
      sdkGenerationRef.current += 1;
      panelRef.current = null;
    };
  }, [
    props.panelId,
    props.placement,
    props.pluginId,
    props.workspaceId,
    restart,
    sdkContext,
  ]);

  useEffect(() => {
    return bridge().onPluginPanelInvalidated((event) => {
      const panel = panelRef.current;
      if (
        event.workspaceId !== props.workspaceId ||
        event.pluginId !== props.pluginId ||
        event.panelId !== props.panelId
      ) {
        return;
      }
      if (!panel) {
        invalidatedSurfaceIdsRef.current.add(event.surfaceId);
        return;
      }
      if (event.surfaceId !== panel.surfaceId) return;
      startRequestRef.current += 1;
      sdkGenerationRef.current += 1;
      panelRef.current = null;
      setLoad({ status: "loading" });
      setRestart((value) => value + 1);
    });
  }, [props.panelId, props.pluginId, props.workspaceId]);

  useEffect(() => {
    async function handleSdkRequest(event: MessageEvent) {
      if (stoppingRef.current) return;
      const activePanel = panelRef.current;
      if (!activePanel) return;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (!isActiveFrameOrigin(event.origin, activePanel.url)) return;
      if (!isDohcSdkRequest(event.data)) return;

      const request = event.data;
      // Answered here, not over IPC: the theme is renderer state, and asking
      // main for it would invent a second copy that could disagree with the
      // window the user is looking at. Synchronous, so the liveness guards
      // the awaited path below needs have nothing to race against.
      if (request.method === "ui.theme") {
        frameWindow.postMessage(
          {
            protocol: DOHC_SDK_PROTOCOL,
            id: request.id,
            ok: true,
            result: readDohcTheme(document.documentElement),
          } satisfies DohcSdkResponseMessage,
          event.origin,
        );
        return;
      }
      const requestGeneration = sdkGenerationRef.current;
      const requestContext = sdkContext;
      let response: DohcSdkResponseMessage;
      // What this request asks dohc to open, held until the liveness guard
      // below says the panel that asked is still the one on screen.
      let open: (() => void) | null = null;
      try {
        const invoked = await bridge().invokePluginPanelSdk({
          workspaceId: props.workspaceId,
          pluginId: props.pluginId,
          panelId: props.panelId,
          method: request.method,
          ...(request.params === undefined ? {} : { params: request.params }),
        });
        const opened = invoked.result as
          | { target?: unknown; webAppId?: unknown; instanceKey?: unknown }
          | undefined;
        if (request.method === "ui.open" && typeof opened?.target === "string") {
          const target = opened.target;
          open = () => props.onOpenPath?.(target);
        }
        if (
          request.method === "ui.openWebApp" &&
          typeof opened?.webAppId === "string" &&
          typeof opened.instanceKey === "string"
        ) {
          const { webAppId, instanceKey } = opened;
          open = () => props.onOpenWebApp?.(props.pluginId, webAppId, instanceKey);
        }
        response = {
          protocol: DOHC_SDK_PROTOCOL,
          id: request.id,
          ok: true,
          result: invoked.result,
        };
      } catch (error) {
        response = sdkErrorResponse(
          request.id,
          "DOHC_HOST_ERROR",
          error instanceof Error ? error.message : "dohc host request failed.",
        );
      }

      const currentPanel = panelRef.current;
      if (
        requestGeneration === sdkGenerationRef.current &&
        requestContext === sdkContextRef.current &&
        !stoppingRef.current &&
        currentPanel &&
        iframeRef.current?.contentWindow === frameWindow &&
        isActiveFrameOrigin(event.origin, currentPanel.url)
      ) {
        open?.();
        frameWindow.postMessage(response, event.origin);
      }
    }

    window.addEventListener("message", handleSdkRequest);
    return () => window.removeEventListener("message", handleSdkRequest);
  }, [
    props.onOpenPath,
    props.onOpenWebApp,
    props.panelId,
    props.pluginId,
    props.workspaceId,
    sdkContext,
  ]);

  const panel = load.status === "ready" ? load.panel : null;
  const panelUrlAllowed = panel ? isLoopbackOrigin(panel.url) : false;
  const panelOrigin =
    panel && panelUrlAllowed ? new URL(panel.url).origin : null;

  // The one gate every unsolicited push to the panel goes through: dropped
  // while the panel is stopping or already gone, sent to the exact panel
  // origin, never a wildcard.
  const postToPanel = useCallback(
    (message: DohcSdkEventMessage<unknown> | DohcThemeMessage) => {
      if (!panelOrigin || stoppingRef.current || !panelRef.current) return;
      iframeRef.current?.contentWindow?.postMessage(message, panelOrigin);
    },
    [panelOrigin],
  );

  useEffect(() => {
    if (!panelOrigin) return;
    return bridge().onPluginPanelSdkEvent((event) => {
      if (
        event.workspaceId !== props.workspaceId ||
        event.pluginId !== props.pluginId ||
        event.panelId !== props.panelId
      ) {
        return;
      }
      postToPanel({
        protocol: DOHC_SDK_PROTOCOL,
        type: "event",
        subscriptionId: event.subscriptionId,
        event: event.event,
        data: event.data,
      } satisfies DohcSdkEventMessage<typeof event.data>);
    });
  }, [panelOrigin, postToPanel, props.panelId, props.pluginId, props.workspaceId]);

  // Theme changes reach a mounted panel without a reload. The app's own
  // appearance state is these three attributes, so watching them covers every
  // way a user changes it — settings, the command palette, or the OS flipping
  // while the mode is "system".
  //
  // A layout effect, not a passive one: it arms in the same commit that
  // makes the panel queryable, before anything could observe it un-watched.
  useLayoutEffect(() => {
    if (!panelOrigin) return;
    const root = document.documentElement;
    const push = () =>
      postToPanel({
        protocol: DOHC_THEME_PROTOCOL,
        theme: readDohcTheme(root),
      } satisfies DohcThemeMessage);
    const observer = new MutationObserver(push);
    observer.observe(root, { attributeFilter: [...THEME_ATTRIBUTES] });
    return () => observer.disconnect();
  }, [panelOrigin, postToPanel]);

  return (
    <div
      data-testid="plugin-panel-page"
      className="flex min-h-0 flex-1 flex-col bg-bg"
    >
      {/* The side panel prints the view's name in its own header, so a panel
          shown there would otherwise carry two title bands. */}
      {props.placement === "view" ? null : (
        <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
          <Plug size={14} aria-hidden className="text-subtle" />
          <span className="truncate text-[13px] font-medium text-ink">
            {panel?.title ?? props.panelId}
          </span>
          <span className="truncate font-mono text-[11px] text-subtle">
            {props.pluginId}
          </span>
        </header>
      )}

      {load.status === "loading" ? (
        <div
          data-testid="plugin-panel-loading"
          className="flex flex-1 items-center justify-center text-sm text-subtle"
        >
          Loading plugin panel...
        </div>
      ) : load.status === "error" ? (
        <EmptyState body={load.message} />
      ) : load.status === "unavailable" ? (
        <PluginUnavailable />
      ) : !panelUrlAllowed ? (
        <EmptyState body="The plugin panel URL must use loopback HTTP." />
      ) : panel ? (
        <iframe
          ref={iframeRef}
          key={panel.url}
          data-testid="plugin-panel-frame"
          title={panel.title}
          src={frameUrlWithHostOrigin(panel.url)}
          sandbox="allow-forms allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-0 flex-1 border-0 bg-bg"
        />
      ) : null}
    </div>
  );
}

function EmptyState(props: { body: string }) {
  return (
    <div
      role="alert"
      aria-label="Could not open plugin panel"
      data-testid="plugin-panel-error"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <AlertTriangle size={20} aria-hidden className="text-warning" />
      <span className="text-sm text-ink">Could not open plugin panel</span>
      <span className="max-w-sm text-xs text-muted">{props.body}</span>
      <span className="max-w-sm text-xs text-muted">
        Close this tab and try again.
      </span>
    </div>
  );
}

function PluginUnavailable() {
  return (
    <div
      role="alert"
      aria-label="This plugin is not running yet."
      data-testid="plugin-panel-unavailable"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Plug size={20} aria-hidden className="text-subtle" />
      <span className="text-sm text-ink">This plugin is not running yet.</span>
      <span className="max-w-sm text-xs text-muted">
        Open this panel from the plugin to start it.
      </span>
    </div>
  );
}
