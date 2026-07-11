import {
  AlertTriangle,
  Box,
  CircleDashed,
  FileCode2,
  Globe2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { SitePackageInfo, WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { siteTabPath } from "./workbenchState";

type SitesLoadState =
  | { status: "loading" }
  | { status: "ready"; sites: SitePackageInfo[] }
  | { status: "error"; message: string };

function staticSiteFromFiles(files: WorkspaceFileEntry[]): SitePackageInfo[] {
  return files
    .filter((file) => file.path.endsWith("/index.html") || file.path === "index.html")
    .map((file) => {
      const root = file.path === "index.html" ? "." : file.path.slice(0, -"/index.html".length);
      const title =
        root === "." || root === ""
          ? "Workspace Site"
          : (root.split("/").at(-1) ?? root)
              .replace(/[-_]+/g, " ")
              .replace(/\b\w/g, (letter) => letter.toUpperCase());
      return {
        root,
        title,
        kind: "static" as const,
        confidence: "high" as const,
        entryPath: file.path,
        configPath: null,
        packagePath: null,
        packageManager: null,
        scripts: {},
        buildOutputs: [],
        sourceFiles: [file.path],
        diagnostics: [],
      };
    });
}

function useSites(workspaceId: string, files: WorkspaceFileEntry[], refreshKey = 0): SitesLoadState {
  const [state, setState] = useState<SitesLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    bridge()
      .listSites({ workspaceId })
      .then((result) => {
        if (!cancelled) setState({ status: "ready", sites: result.sites });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load sites.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  if (state.status === "loading" && files.length > 0) {
    return { status: "ready", sites: staticSiteFromFiles(files) };
  }
  return state;
}

function siteMeta(site: SitePackageInfo): string {
  const parts: string[] = [site.kind, site.confidence];
  if (site.packageManager) parts.push(site.packageManager);
  if (site.scripts.dev) parts.push("dev");
  if (site.scripts.build || site.buildOutputs.length > 0) parts.push("build");
  return parts.join(" · ");
}

function siteDiagnosticLabel(site: SitePackageInfo): string | null {
  const diagnostic =
    site.diagnostics.find((entry) => entry.severity === "error") ??
    site.diagnostics[0];
  if (!diagnostic) return null;
  const prefix = diagnostic.severity === "error" ? "Error" : "Warning";
  const detail = diagnostic.message ?? diagnostic.code;
  return diagnostic.path ? `${prefix}: ${detail} (${diagnostic.path})` : `${prefix}: ${detail}`;
}

export function SitesView(props: {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  refreshKey?: number;
  onOpenPath: (path: string) => void;
}) {
  const state = useSites(props.workspaceId, props.files, props.refreshKey);
  const sites = state.status === "ready" ? state.sites : [];

  return (
    <div data-testid="sites-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Globe2 size={13} aria-hidden className="text-subtle" />
        <output data-testid="sites-count" className="font-mono text-[11px] text-muted">
          {sites.length} site{sites.length === 1 ? "" : "s"}
        </output>
      </div>

      {state.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
          Loading sites...
        </div>
      ) : state.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <AlertTriangle size={18} aria-hidden className="text-warning" />
          <span className="max-w-sm text-xs text-muted">{state.message}</span>
        </div>
      ) : sites.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <Globe2 size={18} aria-hidden className="text-subtle" />
          <span className="text-xs text-muted">No sites</span>
        </div>
      ) : (
        <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto p-2">
          {sites.map((site) => {
            const diagnosticLabel = siteDiagnosticLabel(site);
            return (
              <li key={site.root}>
                <button
                  type="button"
                  data-testid="sites-row"
                  data-root={site.root}
                  onClick={() => props.onOpenPath(siteTabPath(site.root))}
                  className="flex w-full items-start gap-3 rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:bg-panel-2"
                >
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-line bg-bg text-subtle">
                    {site.packagePath ? (
                      <Box size={14} aria-hidden />
                    ) : (
                      <FileCode2 size={14} aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {site.title}
                      </span>
                      {diagnosticLabel ? (
                        <span
                          data-testid="sites-diagnostic-indicator"
                          aria-label={diagnosticLabel}
                          title={diagnosticLabel}
                          className="shrink-0 text-warning"
                        >
                          <AlertTriangle size={12} aria-hidden />
                        </span>
                      ) : site.confidence === "low" ? (
                        <span
                          data-testid="sites-low-confidence"
                          aria-label="Low confidence detection"
                          title="Low confidence detection"
                          className="shrink-0 text-subtle"
                        >
                          <CircleDashed size={12} aria-hidden />
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-subtle">
                      {site.root}
                    </span>
                    <span className="mt-1.5 block truncate font-mono text-[11px] text-muted">
                      {siteMeta(site)}
                    </span>
                    {diagnosticLabel ? (
                      <span
                        data-testid="sites-diagnostic"
                        className="mt-1 block truncate text-[11px] text-warning"
                      >
                        {diagnosticLabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
