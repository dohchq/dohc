import {
  DOHC_SDK_PROTOCOL,
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
  Settings2,
  Share2,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "./ui/controls";
import type {
  SitePackageInfo,
  SitePreviewMode,
  StartSitePreviewResult,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { openLinkExternally } from "./editor/linkMenu";
import {
  frameUrlWithHostOrigin,
  isActiveFrameOrigin,
  isDohcSdkRequest,
  isLoopbackOrigin,
  sdkErrorResponse,
} from "./sdkFrame";

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

function availableModes(
  site: SitePackageInfo,
  sharedView = false,
): SitePreviewMode[] {
  const modes: SitePreviewMode[] = [];
  const sharedStaticEntry = presentBuildOutput(site) ??
    (!needsBuiltArtifact(site)
      ? site.entryPath
      : null);
  if (sharedView || site.authority.kind === "share") {
    return sharedStaticEntry ? ["static"] : [];
  }
  if (site.entryPath) modes.push("static");
  if (site.scripts.dev || site.scripts.start) modes.push("dev");
  if (site.scripts.build || site.buildOutputs.length > 0) modes.push("build");
  return modes;
}

const SITE_PREVIEW_MODE_STORAGE_PREFIX = "dohc.site-preview-mode.v1";

function storedModeKey(workspaceId: string, siteRoot: string): string {
  return `${SITE_PREVIEW_MODE_STORAGE_PREFIX}:${workspaceId}:${siteRoot}`;
}

function readStoredMode(
  workspaceId: string,
  siteRoot: string,
  modes: SitePreviewMode[],
): SitePreviewMode | null {
  try {
    const stored = window.localStorage.getItem(storedModeKey(workspaceId, siteRoot));
    return modes.includes(stored as SitePreviewMode) ? (stored as SitePreviewMode) : null;
  } catch {
    return null;
  }
}

function rememberMode(workspaceId: string, siteRoot: string, mode: SitePreviewMode) {
  try {
    window.localStorage.setItem(storedModeKey(workspaceId, siteRoot), mode);
  } catch {
    // Preview startup must not depend on storage being available.
  }
}

function preferredMode(
  site: SitePackageInfo,
  modes: SitePreviewMode[],
  workspaceId: string,
  sharedView = false,
): SitePreviewMode | null {
  const stored = readStoredMode(workspaceId, site.root, modes);
  if (stored) return stored;
  if (sharedView || site.authority.kind === "share") {
    return modes.includes("static") ? "static" : null;
  }
  if (modes.includes("dev")) return "dev";
  if (site.kind !== "static" && modes.includes("build")) return "build";
  if (modes.includes("static")) return "static";
  return modes.includes("build") ? "build" : null;
}

export interface SiteShareTarget {
  paths: string[];
  label: string;
}

function presentBuildOutput(site: SitePackageInfo): string | null {
  for (const output of site.buildOutputs) {
    const entry = site.root === "."
      ? `${output}/index.html`
      : `${site.root}/${output}/index.html`;
    if (site.sourceFiles.includes(entry)) return output;
  }
  return null;
}

function needsBuiltArtifact(site: SitePackageInfo): boolean {
  return Boolean(
    site.scripts.dev ||
    site.scripts.start ||
    site.scripts.build ||
    site.configuredScripts?.dev ||
    site.configuredScripts?.start ||
    site.configuredScripts?.build ||
    site.configuredScripts?.preview ||
    site.buildOutputs.length > 0
  );
}

/** Produces a relay selector containing the runnable browser artifact only. */
export function shareTargetForSite(site: SitePackageInfo): SiteShareTarget | null {
  if (site.authority.kind === "share") return null;
  const manifest = site.shareManifest;
  if (!manifest) return null;
  const paths = [manifest.entryPath, ...manifest.assets];
  if (paths.length === 0 || paths.length > 100 || new Set(paths).size !== paths.length) {
    return null;
  }
  return { paths, label: site.title };
}

export function SitePreviewPage(props: {
  workspaceId: string;
  siteRoot: string;
  sharedView?: boolean;
  onShareSite?: (target: SiteShareTarget) => void;
  onOpenPath?: (path: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [preview, setPreview] = useState<StartSitePreviewResult | null>(null);
  const previewRef = useRef<StartSitePreviewResult | null>(null);
  const [runningMode, setRunningMode] = useState<SitePreviewMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stoppedByUser, setStoppedByUser] = useState(false);
  const autoStartKeyRef = useRef<string | null>(null);
  const loadRequestRef = useRef(0);
  const previewStartRequestRef = useRef(0);
  const shareRequestRef = useRef(0);
  const sdkGenerationRef = useRef(0);
  const sdkContextRef = useRef("");
  const stoppingRef = useRef(false);
  const sdkContext = `${props.workspaceId}\0${props.siteRoot}`;
  sdkContextRef.current = sdkContext;
  previewRef.current = preview;

  const reloadSite = useCallback(async () => {
    const request = ++loadRequestRef.current;
    shareRequestRef.current += 1;
    setLoad({ status: "loading" });
    setPreview(null);
    previewRef.current = null;
    previewStartRequestRef.current += 1;
    sdkGenerationRef.current += 1;
    stoppingRef.current = false;
    setRunningMode(null);
    setStoppedByUser(false);
    autoStartKeyRef.current = null;
    try {
      const site = await bridge().getSitePackage({
        workspaceId: props.workspaceId,
        path: props.siteRoot,
      });
      if (request !== loadRequestRef.current) return;
      setLoad(site ? { status: "ready", site } : { status: "missing" });
      setActionError(null);
    } catch (error) {
      if (request !== loadRequestRef.current) return;
      setLoad({
        status: "error",
        message: error instanceof Error ? error.message : "Could not load this site.",
      });
    }
  }, [props.workspaceId, props.siteRoot]);

  useEffect(() => {
    void reloadSite();
    return () => {
      loadRequestRef.current += 1;
      shareRequestRef.current += 1;
    };
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
      if (stoppingRef.current) return;
      const activePreview = previewRef.current;
      if (!activePreview) return;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (!isActiveFrameOrigin(event.origin, activePreview.url)) return;
      if (!isDohcSdkRequest(event.data)) return;

      const request = event.data;
      const requestGeneration = sdkGenerationRef.current;
      const requestContext = sdkContext;
      let response: DohcSdkResponseMessage;
      let openedTarget: string | null = null;
      try {
        const invoked = await bridge().invokeSiteSdk({
          workspaceId: props.workspaceId,
          siteRoot: props.siteRoot,
          method: request.method,
          ...(request.params === undefined ? {} : { params: request.params }),
        });
        if (request.method === "ui.open") {
          const opened = invoked.result as { target?: unknown } | undefined;
          if (typeof opened?.target === "string") openedTarget = opened.target;
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

      const currentPreview = previewRef.current;
      if (
        requestGeneration === sdkGenerationRef.current &&
        requestContext === sdkContextRef.current &&
        !stoppingRef.current &&
        currentPreview &&
        iframeRef.current?.contentWindow === frameWindow &&
        isActiveFrameOrigin(event.origin, currentPreview.url)
      ) {
        if (openedTarget) props.onOpenPath?.(openedTarget);
        frameWindow.postMessage(response, event.origin);
      }
    }

    window.addEventListener("message", handleSdkRequest);
    return () => window.removeEventListener("message", handleSdkRequest);
  }, [props.onOpenPath, props.siteRoot, props.workspaceId]);

  const modes = useMemo(
    () => (load.status === "ready" ? availableModes(load.site, props.sharedView) : []),
    [load, props.sharedView],
  );
  const previewUrlAllowed = preview ? isLoopbackOrigin(preview.url) : false;

  const start = useCallback(async (mode: SitePreviewMode) => {
    const request = ++previewStartRequestRef.current;
    sdkGenerationRef.current += 1;
    stoppingRef.current = false;
    setRunningMode(mode);
    setActionError(null);
    setStoppedByUser(false);
    try {
      const result = await bridge().startSitePreview({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
        mode,
      });
      if (request !== previewStartRequestRef.current) return;
      sdkGenerationRef.current += 1;
      setPreview(result);
      rememberMode(props.workspaceId, props.siteRoot, mode);
      return result;
    } catch (error) {
      if (request !== previewStartRequestRef.current) return;
      setActionError(
        error instanceof Error
          ? error.message
          : `Could not start ${modeLabel(mode)} preview.`,
      );
      return null;
    } finally {
      if (request === previewStartRequestRef.current) setRunningMode(null);
    }
  }, [props.siteRoot, props.workspaceId]);

  const prepareShare = useCallback(async (site: SitePackageInfo) => {
    const request = ++shareRequestRef.current;
    const requestContext = sdkContext;
    const isCurrent = () =>
      request === shareRequestRef.current &&
      requestContext === sdkContextRef.current;
    try {
      let latest = site;
      let target = shareTargetForSite(latest);
      if (
        !target &&
        needsBuiltArtifact(latest)
      ) {
        if (!latest.scripts.build) {
          if (isCurrent()) {
            setActionError("This package needs a static build before it can be shared.");
          }
          return;
        }
        const built = await start("build");
        if (!built || !isCurrent()) return;
        const refreshed = await bridge().getSitePackage({
          workspaceId: props.workspaceId,
          path: props.siteRoot,
        });
        if (!isCurrent()) return;
        if (refreshed) latest = refreshed;
        target = shareTargetForSite(latest);
      }
      if (!target) {
        if (isCurrent()) {
          setActionError(
            latest.root === "."
              ? "This root site has too many or no identifiable browser assets. Move it into its own folder before sharing."
              : "This site does not have a runnable static artifact to share.",
          );
        }
        return;
      }
      if (isCurrent()) props.onShareSite?.(target);
    } catch (error) {
      if (isCurrent()) {
        setActionError(error instanceof Error ? error.message : "Could not prepare this site for sharing.");
      }
    }
  }, [props.onShareSite, props.siteRoot, props.workspaceId, sdkContext, start]);

  useEffect(() => {
    if (
      load.status !== "ready" ||
      load.site.root !== props.siteRoot ||
      preview ||
      stoppedByUser
    ) return;
    const mode = preferredMode(load.site, modes, props.workspaceId, props.sharedView);
    if (!mode) return;

    const autoStartKey = `${props.workspaceId}:${props.siteRoot}:${mode}`;
    if (autoStartKeyRef.current === autoStartKey) return;
    autoStartKeyRef.current = autoStartKey;
    void start(mode);
  }, [
    load,
    modes,
    preview,
    props.sharedView,
    props.siteRoot,
    props.workspaceId,
    start,
    stoppedByUser,
  ]);

  async function stop() {
    const request = ++previewStartRequestRef.current;
    sdkGenerationRef.current += 1;
    stoppingRef.current = true;
    setActionError(null);
    try {
      await bridge().stopSitePreview({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
      });
      if (request !== previewStartRequestRef.current) return;
      setPreview(null);
      setStoppedByUser(true);
    } catch (error) {
      if (request !== previewStartRequestRef.current) return;
      setActionError(error instanceof Error ? error.message : "Could not stop preview.");
    } finally {
      if (request === previewStartRequestRef.current) stoppingRef.current = false;
    }
  }

  const site = load.status === "ready" ? load.site : null;
  const canShare = site?.authority.kind === "workspace" && !!props.onShareSite;

  return (
    <div data-testid="site-preview-page" className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
        <Globe2 size={14} aria-hidden className="text-subtle" />
        <span className="truncate text-[13px] font-medium text-ink">
          {site?.title ?? props.siteRoot}
        </span>
        {site?.authority.kind === "share" ? (
          <span data-testid="site-preview-shared-label" className="shrink-0 text-[11px] text-muted">
            Shared
          </span>
        ) : null}
        <span className="truncate font-mono text-[11px] text-subtle">{props.siteRoot}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {preview ? (
            <>
              {previewUrlAllowed ? (
                <>
                  <span
                    data-testid="site-preview-mode"
                    className="hidden text-[11px] text-subtle sm:inline"
                  >
                    {modeLabel(preview.mode)}
                  </span>
                  <IconButton
                    data-testid="site-preview-reload"
                    aria-label="Reload preview"
                    title="Reload preview"
                    onClick={() => {
                      const url = new URL(preview.url);
                      url.searchParams.set("t", String(Date.now()));
                      sdkGenerationRef.current += 1;
                      setPreview({ ...preview, url: url.href });
                    }}
                    className="size-7"
                  >
                    <RefreshCcw size={13} aria-hidden />
                  </IconButton>
                  <IconButton
                    data-testid="site-preview-open-external"
                    aria-label="Open preview externally"
                    title="Open preview externally"
                    onClick={() => void openLinkExternally(preview.url)}
                    className="size-7"
                  >
                    <ExternalLink size={13} aria-hidden />
                  </IconButton>
                </>
              ) : null}
            </>
          ) : null}
          {canShare ? (
            <IconButton
              data-testid="site-preview-share"
              aria-label="Share site"
              title="Share site"
              disabled={runningMode !== null}
              onClick={() => site && void prepareShare(site)}
              className="size-7"
            >
              <Share2 size={13} aria-hidden />
            </IconButton>
          ) : null}
          {modes.length > 0 ? (
            <details className="group relative">
              <summary
                data-testid="site-preview-options"
                aria-label="Preview options"
                title="Preview options"
                className="grid size-7 cursor-pointer list-none place-items-center rounded-md text-subtle transition-colors hover:bg-panel-2 hover:text-ink [&::-webkit-details-marker]:hidden"
              >
                <Settings2 size={13} aria-hidden />
              </summary>
              <div
                className="absolute right-0 top-8 z-20 w-40 rounded-lg border border-line bg-panel p-1 shadow-lg"
              >
                <div className="px-2 py-1 text-[11px] text-subtle">Run preview as</div>
                {modes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`site-preview-${mode}`}
                    disabled={runningMode !== null}
                    onClick={() => void start(mode)}
                    className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:cursor-wait disabled:opacity-60"
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
              </div>
            </details>
          ) : null}
          {preview ? (
            <IconButton
              data-testid="site-preview-stop"
              aria-label="Stop preview"
              title="Stop preview"
              onClick={() => void stop()}
              className="size-7"
            >
              <Square size={13} aria-hidden />
            </IconButton>
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
            !previewUrlAllowed ? (
              <div data-testid="site-preview-error" className="border-b border-line bg-panel px-4 py-2 text-[12px] text-danger">
                Preview URL must be an unauthenticated loopback HTTP URL.
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* allow-same-origin keeps localhost previews on their loopback
                    origin; without it sandboxed frames send "null" origins and
                    the SDK bridge cannot enforce exact active-preview matching.
                    The frame src is restricted to loopback URLs by isLoopbackOrigin,
                    message handling rejects origins that do not match the active
                    preview URL, and preview servers are dohc-controlled local
                    infrastructure rather than arbitrary remote content. */}
                <iframe
                  ref={iframeRef}
                  key={preview.url}
                  data-testid="site-preview-frame"
                  title={site.title}
                  src={frameUrlWithHostOrigin(preview.url)}
                  sandbox="allow-forms allow-same-origin allow-scripts"
                  referrerPolicy="no-referrer"
                  className="min-h-0 flex-1 border-0 bg-bg"
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
            )
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <Globe2 size={24} aria-hidden className="text-subtle" />
              <div className="max-w-sm text-sm text-muted">
                {modes.length > 0
                  ? stoppedByUser
                    ? "Preview stopped. Use Preview options to run it again."
                    : runningMode
                    ? `Starting ${modeLabel(runningMode).toLowerCase()} preview...`
                    : "This site did not start automatically. Choose another mode in Preview options."
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
