import {
  DOHC_SDK_PROTOCOL,
  type DohcSdkResponseMessage,
} from "@dohc/sdk";
import { AlertTriangle, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StartPluginPanelResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import {
  frameUrlWithHostOrigin,
  isActiveFrameOrigin,
  isDohcSdkRequest,
  isLoopbackOrigin,
  sdkErrorResponse,
} from "./sdkFrame";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; panel: StartPluginPanelResult }
  | { status: "unavailable" }
  | { status: "error"; message: string };

function isMissingPluginRegistration(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Plugin ".+" is not registered\./.test(error.message)
  );
}

export function PluginPanelPage(props: {
  workspaceId: string;
  pluginId: string;
  panelId: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const panelRef = useRef<StartPluginPanelResult | null>(null);
  const startRequestRef = useRef(0);
  const sdkGenerationRef = useRef(0);
  const sdkContextRef = useRef("");
  const stoppingRef = useRef(false);
  const sdkContext = `${props.workspaceId}\0${props.pluginId}\0${props.panelId}`;
  sdkContextRef.current = sdkContext;

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
      })
      .then((panel) => {
        if (
          request !== startRequestRef.current ||
          requestContext !== sdkContextRef.current ||
          stoppingRef.current
        ) {
          return;
        }
        sdkGenerationRef.current += 1;
        panelRef.current = panel;
        setLoad({ status: "ready", panel });
      })
      .catch((error: unknown) => {
        if (
          request !== startRequestRef.current ||
          requestContext !== sdkContextRef.current ||
          stoppingRef.current
        ) {
          return;
        }
        if (isMissingPluginRegistration(error)) {
          setLoad({ status: "unavailable" });
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
      stoppingRef.current = true;
      panelRef.current = null;
      void bridge()
        .stopPluginPanel({
          workspaceId: props.workspaceId,
          pluginId: props.pluginId,
          panelId: props.panelId,
        })
        .catch(() => undefined);
    };
  }, [props.panelId, props.pluginId, props.workspaceId, sdkContext]);

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
      const requestGeneration = sdkGenerationRef.current;
      const requestContext = sdkContext;
      let response: DohcSdkResponseMessage;
      try {
        const invoked = await bridge().invokePluginPanelSdk({
          workspaceId: props.workspaceId,
          pluginId: props.pluginId,
          panelId: props.panelId,
          method: request.method,
          ...(request.params === undefined ? {} : { params: request.params }),
        });
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
        frameWindow.postMessage(response, event.origin);
      }
    }

    window.addEventListener("message", handleSdkRequest);
    return () => window.removeEventListener("message", handleSdkRequest);
  }, [props.panelId, props.pluginId, props.workspaceId, sdkContext]);

  const panel = load.status === "ready" ? load.panel : null;
  const panelUrlAllowed = panel ? isLoopbackOrigin(panel.url) : false;

  return (
    <div
      data-testid="plugin-panel-page"
      className="flex min-h-0 flex-1 flex-col bg-bg"
    >
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
        <Plug size={14} aria-hidden className="text-subtle" />
        <span className="truncate text-[13px] font-medium text-ink">
          {panel?.title ?? props.panelId}
        </span>
        <span className="truncate font-mono text-[11px] text-subtle">
          {props.pluginId}
        </span>
      </header>

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
