import {
  DOHC_SDK_PROTOCOL,
  type DohcSdkRequestMessage,
  type DohcSdkResponseMessage,
} from "@dohc/sdk";
import {
  AlertTriangle,
  Box,
  ExternalLink,
  Globe2,
  Hammer,
  Play,
  RefreshCcw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SitePackageInfo,
  SitePreviewMode,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; site: SitePackageInfo }
  | { status: "missing" }
  | { status: "error"; message: string };

function modeLabel(mode: SitePreviewMode): string {
  if (mode === "dev") return "Dev";
  if (mode === "build") return "Build";
  return "Static";
}

function availableModes(site: SitePackageInfo): SitePreviewMode[] {
  const modes: SitePreviewMode[] = [];
  if (site.entryPath) modes.push("static");
  if (site.scripts.dev || site.scripts.start) modes.push("dev");
  if (site.scripts.build || site.buildOutputs.length > 0) modes.push("build");
  return modes;
}

function normalizeLoopbackHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(
        normalizeLoopbackHostname(url.hostname),
      )
    );
  } catch {
    return false;
  }
}

function isActivePreviewOrigin(origin: string, previewUrl: string): boolean {
  if (!isLoopbackOrigin(origin)) return false;
  try {
    return new URL(origin).origin === new URL(previewUrl).origin;
  } catch {
    return false;
  }
}

function isDohcSdkRequest(value: unknown): value is DohcSdkRequestMessage {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<DohcSdkRequestMessage>;
  return (
    request.protocol === DOHC_SDK_PROTOCOL &&
    typeof request.id === "string" &&
    request.id.length > 0 &&
    typeof request.method === "string" &&
    request.method.length > 0
  );
}

function sdkErrorResponse(
  id: string,
  code: string,
  message: string,
): DohcSdkResponseMessage {
  return {
    protocol: DOHC_SDK_PROTOCOL,
    id,
    ok: false,
    error: { code, message },
  };
}

function isSafeWorkspaceRelativePath(path: string): boolean {
  // `files.read` is intentionally workspace-relative, not site-root-relative:
  // dohc sites are workspace-native and may read files such as notes/today.md.
  // Main-process IPC still enforces the registered workspace boundary and
  // filesystem containment before any bytes are read.
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function siteFrameUrl(url: string): string {
  const framed = new URL(url);
  framed.searchParams.set("dohcHostOrigin", window.location.origin);
  return framed.href;
}

export function SitePreviewPage(props: {
  workspaceId: string;
  siteRoot: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [preview, setPreview] = useState<StartSitePreviewResult | null>(null);
  const previewRef = useRef<StartSitePreviewResult | null>(null);
  const [runningMode, setRunningMode] = useState<SitePreviewMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  previewRef.current = preview;

  const reloadSite = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const site = await bridge().getSitePackage({
        workspaceId: props.workspaceId,
        path: props.siteRoot,
      });
      setLoad(site ? { status: "ready", site } : { status: "missing" });
      setActionError(null);
    } catch (error) {
      setLoad({
        status: "error",
        message: error instanceof Error ? error.message : "Could not load this site.",
      });
    }
  }, [props.workspaceId, props.siteRoot]);

  useEffect(() => {
    void reloadSite();
  }, [reloadSite]);

  useEffect(() => {
    return () => {
      void bridge()
        .stopSitePreview({ workspaceId: props.workspaceId, siteRoot: props.siteRoot })
        .catch(() => undefined);
    };
  }, [props.workspaceId, props.siteRoot]);

  useEffect(() => {
    async function handleSdkRequest(event: MessageEvent) {
      const activePreview = previewRef.current;
      if (!activePreview) return;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (!isActivePreviewOrigin(event.origin, activePreview.url)) return;
      if (!isDohcSdkRequest(event.data)) return;

      const request = event.data;
      let response: DohcSdkResponseMessage;
      try {
        if (request.method === "capabilities") {
          response = {
            protocol: DOHC_SDK_PROTOCOL,
            id: request.id,
            ok: true,
            result: {
              files: { read: true, write: false },
              collections: { read: false },
              provenance: { record: false },
            },
          };
        } else if (request.method === "files.read") {
          const params = request.params as { path?: unknown } | undefined;
          if (typeof params?.path !== "string" || !isSafeWorkspaceRelativePath(params.path)) {
            response = sdkErrorResponse(
              request.id,
              "DOHC_BAD_REQUEST",
              "files.read requires a safe workspace-relative path.",
            );
          } else {
            const result = await bridge().readWorkspaceText({
              workspaceId: props.workspaceId,
              relativePath: params.path,
            });
            response = {
              protocol: DOHC_SDK_PROTOCOL,
              id: request.id,
              ok: true,
              result,
            };
          }
        } else {
          response = sdkErrorResponse(
            request.id,
            "DOHC_UNSUPPORTED_METHOD",
            `${request.method} is not available in this dohc preview yet.`,
          );
        }
      } catch (error) {
        response = sdkErrorResponse(
          request.id,
          "DOHC_HOST_ERROR",
          error instanceof Error ? error.message : "dohc host request failed.",
        );
      }

      frameWindow.postMessage(response, event.origin);
    }

    window.addEventListener("message", handleSdkRequest);
    return () => window.removeEventListener("message", handleSdkRequest);
  }, [props.workspaceId, props.siteRoot]);

  const modes = useMemo(
    () => (load.status === "ready" ? availableModes(load.site) : []),
    [load],
  );

  async function start(mode: SitePreviewMode) {
    setRunningMode(mode);
    setActionError(null);
    try {
      const result = await bridge().startSitePreview({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
        mode,
      });
      setPreview(result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not start ${modeLabel(mode)} preview.`);
    } finally {
      setRunningMode(null);
    }
  }

  async function stop() {
    setActionError(null);
    try {
      await bridge().stopSitePreview({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
      });
      setPreview(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not stop preview.");
    }
  }

  const site = load.status === "ready" ? load.site : null;

  return (
    <div data-testid="site-preview-page" className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
        <Globe2 size={14} aria-hidden className="text-subtle" />
        <span className="truncate text-[13px] font-medium text-ink">
          {site?.title ?? props.siteRoot}
        </span>
        <span className="truncate font-mono text-[11px] text-subtle">{props.siteRoot}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`site-preview-${mode}`}
              disabled={runningMode !== null}
              onClick={() => void start(mode)}
              className="inline-flex h-7 items-center gap-1 rounded border border-line bg-panel-2 px-2 text-[11px] text-muted hover:text-ink disabled:cursor-wait disabled:opacity-60"
            >
              {mode === "build" ? (
                <Hammer size={12} aria-hidden />
              ) : mode === "dev" ? (
                <Play size={12} aria-hidden />
              ) : (
                <Box size={12} aria-hidden />
              )}
              {runningMode === mode ? "Starting" : modeLabel(mode)}
            </button>
          ))}
          {preview ? (
            <>
              <button
                type="button"
                data-testid="site-preview-reload"
                aria-label="Reload preview"
                title="Reload preview"
                onClick={() => {
                  const url = new URL(preview.url);
                  url.searchParams.set("t", String(Date.now()));
                  setPreview({ ...preview, url: url.href });
                }}
                className="grid size-7 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
              >
                <RefreshCcw size={13} aria-hidden />
              </button>
              <button
                type="button"
                data-testid="site-preview-stop"
                aria-label="Stop preview"
                title="Stop preview"
                onClick={() => void stop()}
                className="grid size-7 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
              >
                <Square size={13} aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      </header>

      {load.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-subtle">
          Loading site...
        </div>
      ) : load.status === "missing" ? (
        <EmptyState title="Site not detected" body="The folder no longer looks like a website." />
      ) : load.status === "error" ? (
        <EmptyState title="Could not load site" body={load.message} />
      ) : site ? (
        <>
          {site.diagnostics.length > 0 || actionError ? (
            <div className="border-b border-line bg-panel px-4 py-2">
              {site.diagnostics.map((diagnostic) => (
                <div
                  key={`${diagnostic.path ?? site.root}:${diagnostic.code}`}
                  className="flex items-center gap-1.5 text-[12px] text-warning"
                >
                  <AlertTriangle size={12} aria-hidden />
                  <span className="font-mono">{diagnostic.code}</span>
                  <span>{diagnostic.message}</span>
                </div>
              ))}
              {actionError ? (
                <div data-testid="site-preview-error" className="flex items-center gap-1.5 text-[12px] text-danger">
                  <AlertTriangle size={12} aria-hidden />
                  <span>{actionError}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {preview ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-3">
                <span data-testid="site-preview-mode" className="text-[11px] text-muted">
                  {modeLabel(preview.mode)} preview
                </span>
                <span className="truncate font-mono text-[11px] text-subtle">{preview.url}</span>
                <button
                  type="button"
                  data-testid="site-preview-open-external"
                  aria-label="Open preview externally"
                  title="Open preview externally"
                  onClick={() => void bridge().openExternalUrl({ url: preview.url })}
                  className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <ExternalLink size={12} aria-hidden />
                </button>
              </div>
              {/* allow-same-origin keeps localhost previews on their loopback
                  origin; without it sandboxed frames send "null" origins and
                  the SDK bridge cannot enforce exact active-preview matching.
                  Main registers loopback preview origins, SDK reads compare
                  event.origin to the active URL, and the frame uses no-referrer. */}
              <iframe
                ref={iframeRef}
                key={preview.url}
                data-testid="site-preview-frame"
                title={site.title}
                src={siteFrameUrl(preview.url)}
                sandbox="allow-forms allow-same-origin allow-scripts"
                referrerPolicy="no-referrer"
                className="min-h-0 flex-1 border-0 bg-white"
              />
              {preview.logs.length > 0 ? (
                <details className="max-h-36 shrink-0 overflow-auto border-t border-line bg-panel px-3 py-2 text-[11px]">
                  <summary className="cursor-pointer text-muted">Logs</summary>
                  <pre className="m-0 mt-2 whitespace-pre-wrap font-mono text-subtle">
                    {preview.logs.map((log) => `[${log.stream}] ${log.text}`).join("\n")}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <Globe2 size={24} aria-hidden className="text-subtle" />
              <div className="max-w-sm text-sm text-muted">
                {modes.length > 0
                  ? "Choose a preview mode to run this website inside dohc."
                  : "This site has no previewable entry, dev script, or build output yet."}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <AlertTriangle size={20} aria-hidden className="text-warning" />
      <span className="text-sm text-ink">{props.title}</span>
      <span className="max-w-sm text-xs text-muted">{props.body}</span>
    </div>
  );
}
