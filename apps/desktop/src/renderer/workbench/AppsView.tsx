import { discoverApps } from "@dohc/workspace-core";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileCode2,
  LayoutGrid,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AppPackageResult,
  WorkspaceFileEntry,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

type AppInfo = NonNullable<AppPackageResult>;

export interface WorkspaceAppEntry {
  name: string;
  root: string;
  manifestPath: string | null;
  openPath: string;
  sourceFiles: string[];
  status: "package" | "incomplete";
}

type PackageLoadState =
  | { status: "loading" }
  | { status: "ready"; info: AppInfo }
  | { status: "missing" }
  | { status: "error"; message: string };

type StatusTone = "success" | "danger" | "warning" | "muted";

const APP_DIR_RE = /(^|\/)\.apps\/([^/]+)(\/|$)/;

function appRootOf(path: string): { name: string; root: string } | null {
  const match = APP_DIR_RE.exec(path);
  if (!match) return null;
  const name = match[2];
  const marker = `.apps/${name}`;
  const index = path.indexOf(marker);
  return { name, root: path.slice(0, index + marker.length) };
}

function compareAppEntries(a: WorkspaceAppEntry, b: WorkspaceAppEntry): number {
  return a.root.localeCompare(b.root);
}

export function discoverWorkspaceApps(
  files: WorkspaceFileEntry[],
): WorkspaceAppEntry[] {
  const paths = files.map((file) => file.path);
  const packages = discoverApps(paths);
  const entries = packages.map<WorkspaceAppEntry>((pkg) => ({
    name: pkg.name,
    root: pkg.root,
    manifestPath: pkg.manifestPath,
    openPath: pkg.manifestPath,
    sourceFiles: pkg.sourceFiles,
    status: "package",
  }));
  const packageRoots = new Set(entries.map((entry) => entry.root));
  const incomplete = new Map<
    string,
    { name: string; root: string; sourceFiles: string[] }
  >();

  for (const path of paths) {
    const app = appRootOf(path);
    if (!app || packageRoots.has(app.root)) continue;
    const entry =
      incomplete.get(app.root) ??
      { name: app.name, root: app.root, sourceFiles: [] };
    entry.sourceFiles.push(path);
    incomplete.set(app.root, entry);
  }

  for (const app of incomplete.values()) {
    const sourceFiles = [...app.sourceFiles].sort();
    entries.push({
      name: app.name,
      root: app.root,
      manifestPath: null,
      openPath: sourceFiles[0],
      sourceFiles,
      status: "incomplete",
    });
  }

  return entries.sort(compareAppEntries);
}

function statusForEntry(
  entry: WorkspaceAppEntry,
  state: PackageLoadState | undefined,
): { label: string; tone: StatusTone; Icon: typeof CheckCircle2 } {
  if (entry.status === "incomplete") {
    return { label: "Incomplete", tone: "warning", Icon: AlertTriangle };
  }
  if (!state || state.status === "loading") {
    return { label: "Checking", tone: "muted", Icon: CircleDashed };
  }
  if (state.status === "missing") {
    return { label: "Incomplete", tone: "warning", Icon: AlertTriangle };
  }
  if (state.status === "error") {
    return { label: "Error", tone: "danger", Icon: XCircle };
  }
  if (state.info.readiness === "failed") {
    return { label: "Failed", tone: "danger", Icon: XCircle };
  }
  if (state.info.readiness === "needs-testing") {
    return { label: "Needs testing", tone: "muted", Icon: CircleDashed };
  }
  if (state.info.requiresTrust && !state.info.trusted) {
    return { label: "Needs trust", tone: "warning", Icon: ShieldAlert };
  }
  return { label: "Ready", tone: "success", Icon: CheckCircle2 };
}

function toneClass(tone: StatusTone): string {
  if (tone === "success") return "border-success/30 bg-success/10 text-success";
  if (tone === "danger") return "border-danger/30 bg-danger/10 text-danger";
  if (tone === "warning") return "border-warning/30 bg-warning/10 text-warning";
  return "border-line bg-panel text-subtle";
}

function packageTitle(
  entry: WorkspaceAppEntry,
  state: PackageLoadState | undefined,
): string {
  return state?.status === "ready"
    ? (state.info.manifest.title ?? state.info.name)
    : entry.name;
}

function packageMeta(
  entry: WorkspaceAppEntry,
  state: PackageLoadState | undefined,
): string {
  if (entry.status === "incomplete") return `${entry.sourceFiles.length} source`;
  if (state?.status !== "ready") return `${entry.sourceFiles.length} source`;
  const writeCount = state.info.manifest.write.length;
  if (writeCount > 0) return `${entry.sourceFiles.length} source · writes ${writeCount}`;
  return `${entry.sourceFiles.length} source · read-only`;
}

export function AppsView(props: {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  refreshKey?: number;
  onOpenPath: (path: string) => void;
}) {
  const entries = useMemo(() => discoverWorkspaceApps(props.files), [props.files]);
  const [packageState, setPackageState] = useState<Record<string, PackageLoadState>>(
    {},
  );
  const packageKey = useMemo(
    () =>
      entries
        .map((entry) => `${entry.root}:${entry.manifestPath ?? ""}:${entry.sourceFiles.length}`)
        .join("\0"),
    [entries],
  );

  useEffect(() => {
    let cancelled = false;
    const packages = entries.filter((entry) => entry.manifestPath !== null);
    if (packages.length === 0) {
      setPackageState({});
      return;
    }
    setPackageState(
      Object.fromEntries(packages.map((entry) => [entry.root, { status: "loading" }])),
    );
    void Promise.all(
      packages.map(async (entry): Promise<[string, PackageLoadState]> => {
        try {
          const info = await bridge().getAppPackage({
            workspaceId: props.workspaceId,
            path: entry.manifestPath ?? entry.openPath,
          });
          return [entry.root, info ? { status: "ready", info } : { status: "missing" }];
        } catch (error) {
          return [
            entry.root,
            {
              status: "error",
              message: error instanceof Error ? error.message : "App unavailable.",
            },
          ];
        }
      }),
    ).then((states) => {
      if (!cancelled) setPackageState(Object.fromEntries(states));
    });
    return () => {
      cancelled = true;
    };
  }, [entries, packageKey, props.refreshKey, props.workspaceId]);

  const readyCount = entries.filter((entry) => {
    const state = packageState[entry.root];
    return (
      state?.status === "ready" &&
      state.info.readiness === "ready" &&
      (!state.info.requiresTrust || state.info.trusted)
    );
  }).length;

  return (
    <div data-testid="apps-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <LayoutGrid size={13} aria-hidden className="text-subtle" />
        <output data-testid="apps-count" className="text-[11px] text-muted">
          {entries.length} app{entries.length === 1 ? "" : "s"}
        </output>
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <output data-testid="apps-ready-count" className="text-[11px] text-muted">
          {readyCount} ready
        </output>
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <LayoutGrid size={18} aria-hidden className="text-subtle" />
          <span className="text-xs text-muted">No apps</span>
          <span className="text-[11px] text-subtle">
            Workspace app packages will appear here.
          </span>
        </div>
      ) : (
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
          {entries.map((entry) => {
            const state = packageState[entry.root];
            const status = statusForEntry(entry, state);
            return (
              <li key={entry.root}>
                <button
                  type="button"
                  data-testid="apps-row"
                  data-root={entry.root}
                  data-state={state?.status ?? entry.status}
                  onClick={() => props.onOpenPath(entry.openPath)}
                  className="flex w-full items-start gap-2 border-b border-line px-3 py-2.5 text-left hover:bg-line/40 focus:bg-line/50 focus:outline-none"
                >
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded border border-line bg-panel text-subtle">
                    <FileCode2 size={14} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {packageTitle(entry, state)}
                      </span>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-medium leading-4 ${toneClass(status.tone)}`}
                      >
                        <status.Icon size={11} aria-hidden />
                        {status.label}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-subtle">
                      {entry.root}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted">
                      {packageMeta(entry, state)}
                    </span>
                    {state?.status === "error" ? (
                      <span className="mt-1 block truncate text-[11px] text-danger">
                        {state.message}
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
