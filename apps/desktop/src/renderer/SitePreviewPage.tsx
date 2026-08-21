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
import { needsBuiltArtifact, presentBuildOutput } from "@dohc/workspace-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "./ui/controls";
import type {
  SitePackageInfo,
  SitePreviewMode,
  StartSitePreviewResult,
  WorkspaceSettingsResult,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { openLinkExternally } from "./editor/linkMenu";
import { isLoopbackOrigin } from "./sdkFrame";

type WorkspacePreviewMode =
  WorkspaceSettingsResult["settings"]["sites"]["defaultPreviewMode"];

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      site: SitePackageInfo;
      defaultPreviewMode: WorkspacePreviewMode;
    }
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
  if (sharedView || site.authority.kind === "share") {
    const sharedStaticEntry = presentBuildOutput(site) ??
      (!needsBuiltArtifact(site)
        ? site.entryPath
        : null);
    return sharedStaticEntry ? ["static"] : [];
  }
  if (site.entryPath) modes.push("static");
  if (
    site.configuredScripts.dev ||
    site.scripts.dev ||
    site.configuredScripts.start ||
    site.scripts.start
  ) modes.push("dev");
  if (
    site.configuredScripts.build ||
    site.scripts.build ||
    site.buildOutputs.length > 0 ||
    presentBuildOutput(site)
  ) modes.push("build");
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
  defaultPreviewMode: WorkspacePreviewMode,
  sharedView = false,
): SitePreviewMode | null {
  const stored = readStoredMode(workspaceId, site.root, modes);
  if (stored) return stored;
  if (sharedView || site.authority.kind === "share") {
    return modes.includes("static") ? "static" : null;
  }
  if (
    site.configuredPreviewMode &&
    modes.includes(site.configuredPreviewMode)
  ) {
    return site.configuredPreviewMode;
  }
  if (
    defaultPreviewMode !== "auto" &&
    modes.includes(defaultPreviewMode)
  ) {
    return defaultPreviewMode;
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

/** Produces a relay selector containing the runnable browser artifact only. */
export function shareTargetForSite(site: SitePackageInfo): SiteShareTarget | null {
  if (site.authority.kind === "share") return null;
  if (!site.shareManifest.ok) return null;
  const manifest = site.shareManifest.manifest;
  const paths = [manifest.entryPath, ...manifest.assets];
  if (paths.length === 0 || paths.length > 100 || new Set(paths).size !== paths.length) {
    return null;
  }
  return { paths, label: site.title };
}

function formatMiB(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
}

function shareRefusalMessage(
  result: Extract<SitePackageInfo["shareManifest"], { ok: false }>,
): string {
  if (result.reason === "byte-budget") {
    return `dohc scanned ${formatMiB(result.observedBytes)} for sharing. The configured limit is ${formatMiB(result.limitBytes)}. Reduce the site's referenced files and try again.`;
  }
  if (result.reason === "file-count") {
    return `dohc found ${result.observedFiles} files for sharing. The configured limit is ${result.limitFiles} files. Remove referenced files and try again.`;
  }
  if (result.reason === "unreadable") {
    return `dohc could not read ${result.path}. Check that the file is readable, then try again.`;
  }
  if (result.reason === "non-file-reference") {
    return `dohc found a shared reference that is not a file: ${result.path}. Replace the reference, then try again.`;
  }
  return "This site does not have a runnable static artifact to share.";
}

export function SitePreviewPage(props: {
  workspaceId: string;
  siteRoot: string;
  sharedView?: boolean;
  onShareSite?: (target: SiteShareTarget) => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [preview, setPreview] = useState<StartSitePreviewResult | null>(null);
  const [previewLogs, setPreviewLogs] = useState<StartSitePreviewResult["logs"]>(
    [],
  );
  const [logsOpen, setLogsOpen] = useState(false);
  const [runningMode, setRunningMode] = useState<SitePreviewMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stoppedByUser, setStoppedByUser] = useState(false);
  const [previewExited, setPreviewExited] = useState(false);
  const autoStartKeyRef = useRef<string | null>(null);
  const loadRequestRef = useRef(0);
  const previewStartRequestRef = useRef(0);
  const logsRequestRef = useRef(0);
  const shareRequestRef = useRef(0);
  const siteContextRef = useRef("");
  const siteContext = `${props.workspaceId}\0${props.siteRoot}`;
  siteContextRef.current = siteContext;

  const reloadSite = useCallback(async () => {
    const request = ++loadRequestRef.current;
    shareRequestRef.current += 1;
    setLoad({ status: "loading" });
    setPreview(null);
    setPreviewLogs([]);
    setLogsOpen(false);
    previewStartRequestRef.current += 1;
    logsRequestRef.current += 1;
    setRunningMode(null);
    setStoppedByUser(false);
    setPreviewExited(false);
    autoStartKeyRef.current = null;
    try {
      const [site, workspaceResult] = await Promise.all([
        bridge().getSitePackage({
          workspaceId: props.workspaceId,
          path: props.siteRoot,
        }),
        bridge()
          .getWorkspaceSettings({ workspaceId: props.workspaceId })
          .catch((): WorkspaceSettingsResult | null => null),
      ]);
      if (request !== loadRequestRef.current) return;
      setLoad(site
        ? {
            status: "ready",
            site,
            defaultPreviewMode:
              workspaceResult?.settings.sites.defaultPreviewMode ?? "auto",
          }
        : { status: "missing" });
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
      logsRequestRef.current += 1;
    };
  }, [reloadSite]);

  useEffect(() => {
    return () => {
      void bridge()
        .stopSitePreview({ workspaceId: props.workspaceId, siteRoot: props.siteRoot })
        .catch(() => undefined);
    };
  }, [props.workspaceId, props.siteRoot]);


  const modes = useMemo(
    () => (load.status === "ready" ? availableModes(load.site, props.sharedView) : []),
    [load, props.sharedView],
  );
  const previewUrlAllowed = preview ? isLoopbackOrigin(preview.url) : false;

  const start = useCallback(async (mode: SitePreviewMode) => {
    const request = ++previewStartRequestRef.current;
    logsRequestRef.current += 1;
    setLogsOpen(false);
    setPreviewLogs([]);
    setRunningMode(mode);
    setActionError(null);
    setStoppedByUser(false);
    setPreviewExited(false);
    try {
      const result = await bridge().startSitePreview({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
        mode,
      });
      if (request !== previewStartRequestRef.current) return;
      setPreviewLogs(result.logs);
      rememberMode(props.workspaceId, props.siteRoot, mode);
      if (result.exited) {
        setPreview(null);
        setPreviewExited(true);
        setLogsOpen(result.logs.length > 0);
        return result;
      }
      setPreview(result);
      return result;
    } catch (error) {
      if (request !== previewStartRequestRef.current) return;
      setPreview(null);
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
    const requestContext = siteContext;
    const isCurrent = () =>
      request === shareRequestRef.current &&
      requestContext === siteContextRef.current;
    try {
      let latest = site;
      const fresh = await bridge().getSitePackage({
        workspaceId: props.workspaceId,
        path: props.siteRoot,
      });
      if (!isCurrent()) return;
      // getSitePackage intentionally returns the deepest CONTAINING site for
      // a path (see requireExactSiteRoot's doc comment), so a stale tab whose
      // own root stopped being a detected site can still get back a detected
      // ANCESTOR above it. Sharing that ancestor would offer someone else's
      // site under this tab's name, so both refresh points here require an
      // exact root match before exposing a target.
      if (!fresh || fresh.root !== props.siteRoot) {
        setActionError("This site is no longer part of the workspace.");
        return;
      }
      latest = fresh;
      let target = shareTargetForSite(latest);
      if (
        !target &&
        needsBuiltArtifact(latest)
      ) {
        if (!latest.configuredScripts.build && !latest.scripts.build) {
          if (isCurrent()) {
            setActionError("This site needs a static build before it can be shared.");
          }
          return;
        }
        const built = await start("build");
        if (!built || !isCurrent()) return;
        const refreshedAfterBuild = await bridge().getSitePackage({
          workspaceId: props.workspaceId,
          path: props.siteRoot,
        });
        if (!isCurrent()) return;
        if (refreshedAfterBuild && refreshedAfterBuild.root !== props.siteRoot) {
          setActionError("This site is no longer part of the workspace.");
          return;
        }
        if (refreshedAfterBuild) latest = refreshedAfterBuild;
        target = shareTargetForSite(latest);
      }
      if (!target) {
        if (isCurrent()) {
          setActionError(
            latest.shareManifest.ok
              ? "This site does not have a runnable static artifact to share."
              : shareRefusalMessage(latest.shareManifest),
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
  }, [props.onShareSite, props.siteRoot, props.workspaceId, siteContext, start]);

  const refreshPreviewLogs = useCallback(async () => {
    if (
      !preview ||
      preview.mode !== "dev" ||
      preview.siteRoot !== props.siteRoot
    ) return;
    const request = ++logsRequestRef.current;
    const requestContext = siteContext;
    const previewRequest = previewStartRequestRef.current;
    try {
      const result = await bridge().getSitePreviewLogs({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
      });
      if (
        request !== logsRequestRef.current ||
        requestContext !== siteContextRef.current ||
        previewRequest !== previewStartRequestRef.current
      ) return;
      setPreviewLogs(result.logs);
      if (result.exited) {
        setPreview(null);
        setPreviewExited(true);
        setLogsOpen(true);
      }
    } catch {
      // Starting, stopping, and workspace changes can invalidate a poll.
    }
  }, [preview, props.siteRoot, props.workspaceId, siteContext]);

  useEffect(() => {
    if (preview?.mode !== "dev") return;
    void refreshPreviewLogs();
    const interval = setInterval(() => {
      void refreshPreviewLogs();
    }, 1000);
    return () => {
      clearInterval(interval);
      logsRequestRef.current += 1;
    };
  }, [preview?.mode, refreshPreviewLogs]);

  useEffect(() => {
    if (
      load.status !== "ready" ||
      load.site.root !== props.siteRoot ||
      preview ||
      previewExited ||
      stoppedByUser
    ) return;
    const mode = preferredMode(
      load.site,
      modes,
      props.workspaceId,
      load.defaultPreviewMode,
      props.sharedView,
    );
    if (!mode) return;

    const autoStartKey = `${props.workspaceId}:${props.siteRoot}:${mode}`;
    if (autoStartKeyRef.current === autoStartKey) return;
    autoStartKeyRef.current = autoStartKey;
    void start(mode);
  }, [
    load,
    modes,
    preview,
    previewExited,
    props.sharedView,
    props.siteRoot,
    props.workspaceId,
    start,
    stoppedByUser,
  ]);

  async function stop() {
    const request = ++previewStartRequestRef.current;
    logsRequestRef.current += 1;
    setLogsOpen(false);
    setActionError(null);
    try {
      await bridge().stopSitePreview({
        workspaceId: props.workspaceId,
        siteRoot: props.siteRoot,
      });
      if (request !== previewStartRequestRef.current) return;
      setPreview(null);
      setPreviewLogs([]);
      setStoppedByUser(true);
      setPreviewExited(false);
    } catch (error) {
      if (request !== previewStartRequestRef.current) return;
      setActionError(error instanceof Error ? error.message : "Could not stop preview.");
    }
  }

  const site = load.status === "ready" ? load.site : null;
  const canShare =
    !props.sharedView &&
    site?.authority.kind === "workspace" &&
    !!props.onShareSite;

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
          Loading site…
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
                  <span>
                    {diagnostic.message || "Could not check this site fully."}
                  </span>
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

          {preview && !previewUrlAllowed ? (
            <div data-testid="site-preview-error" className="border-b border-line bg-panel px-4 py-2 text-[12px] text-danger">
              This site tried to preview from an address dohc does not trust. Reload the preview.
            </div>
          ) : null}

          {preview && previewUrlAllowed ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* The frame can run normal site scripts but has no dohc bridge.
                  Its source is restricted to a dohc-controlled loopback server,
                  and the sandbox withholds popups, modals, and top navigation. */}
              <iframe
                key={preview.url}
                data-testid="site-preview-frame"
                title={site.title}
                src={preview.url}
                sandbox="allow-forms allow-same-origin allow-scripts"
                referrerPolicy="no-referrer"
                className="min-h-0 flex-1 border-0 bg-bg"
              />
              {preview.mode === "dev" || previewLogs.length > 0 ? (
                <details
                  open={logsOpen}
                  onToggle={(event) => setLogsOpen(event.currentTarget.open)}
                  className="max-h-36 shrink-0 overflow-auto border-t border-line bg-panel px-3 py-2 text-[11px]"
                >
                  <summary className="cursor-pointer text-muted">Logs</summary>
                  <pre className="m-0 mt-2 whitespace-pre-wrap font-mono text-subtle">
                    {previewLogs.map((log) => `[${log.stream}] ${log.text}`).join("\n")}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}

          {!preview ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <Globe2 size={24} aria-hidden className="text-subtle" />
              <div className="max-w-sm text-sm text-muted">
                {modes.length > 0
                  ? previewExited
                    ? "Dev server exited. Use Preview options to run it again."
                    : stoppedByUser
                    ? "Preview stopped. Use Preview options to run it again."
                    : runningMode
                    ? `Starting ${modeLabel(runningMode).toLowerCase()} preview…`
                    : "This site did not start automatically. Choose another mode in Preview options."
                  : "This site has no previewable entry, dev script, or build output yet."}
              </div>
              {previewExited && previewLogs.length > 0 ? (
                <details
                  open={logsOpen}
                  onToggle={(event) => setLogsOpen(event.currentTarget.open)}
                  className="max-h-36 w-full max-w-3xl overflow-auto border-t border-line bg-panel px-3 py-2 text-left text-[11px]"
                >
                  <summary className="cursor-pointer text-muted">Logs</summary>
                  <pre className="m-0 mt-2 whitespace-pre-wrap font-mono text-subtle">
                    {previewLogs.map((log) => `[${log.stream}] ${log.text}`).join("\n")}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
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
