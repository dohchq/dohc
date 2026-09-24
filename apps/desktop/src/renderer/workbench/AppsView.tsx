import {
  AlertTriangle,
  Box,
  CircleDashed,
  FileCode2,
  Globe2,
} from "lucide-react";
import { useState } from "react";
import { APP_CHECK_FALLBACK_MESSAGE } from "../appCopy";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { PrimaryButton } from "../ui/controls";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import { siteTabPath } from "./workbenchState";

type AppsLoadState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string; apps: SitePackageInfo[] }
  | { status: "error"; workspaceId: string; message: string };

// Every settled file listing refetches the apps. The list and its count stay
// on screen while that runs; only a first load, or another workspace, shows
// loading.
function useApps(
  workspaceId: string,
  filesSettledRevision: number,
): AppsLoadState {
  const [state, setState] = useState<AppsLoadState>({ status: "loading" });

  useAsyncResponseEffect(
    () => bridge().listSites({ workspaceId }),
    {
      onSuccess: (result) => {
        setState({ status: "ready", workspaceId, apps: result.sites });
      },
      onError: (error) => {
        setState({
          status: "error",
          workspaceId,
          message: error instanceof Error ? error.message : "Could not load apps.",
        });
      },
    },
    [workspaceId, filesSettledRevision],
  );

  return state.status !== "loading" && state.workspaceId !== workspaceId
    ? { status: "loading" }
    : state;
}

function appDiagnosticLabel(app: SitePackageInfo): string | null {
  const diagnostic =
    app.diagnostics.find((entry) => entry.severity === "error") ??
    app.diagnostics[0];
  if (!diagnostic) return null;
  const prefix = diagnostic.severity === "error" ? "Error" : "Warning";
  const detail = diagnostic.message || APP_CHECK_FALLBACK_MESSAGE;
  return diagnostic.path ? `${prefix}: ${detail} (${diagnostic.path})` : `${prefix}: ${detail}`;
}

export function AppsView(props: {
  workspaceId: string;
  // Bumped once per settled workspace file listing — including a
  // content-only edit to an existing file (e.g. dohc.json, package.json),
  // not just an add/remove. A structural hash over path/kind/icon alone
  // produces the same value for a content edit, so the effect would never
  // rerun and the Apps view would keep stale titles, diagnostics,
  // scripts, and preview modes until the user manually refreshed it.
  filesSettledRevision: number;
  onOpenPath: (path: string) => void;
  onCreateFirstApp: () => Promise<void>;
  // A received share workspace rejects folder creation in main, including
  // for edit grants. Mounted shares inside a normal workspace do not set it.
  receivedShareWorkspace?: boolean;
}) {
  const state = useApps(props.workspaceId, props.filesSettledRevision);
  const apps = state.status === "ready" ? state.apps : [];
  const [creating, setCreating] = useState(false);

  const createFirstApp = async () => {
    if (creating || props.receivedShareWorkspace) return;
    setCreating(true);
    try {
      await props.onCreateFirstApp();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-testid="sites-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Globe2 size={13} aria-hidden className="text-subtle" />
        <output data-testid="sites-count" className="font-mono text-[11px] text-muted">
          {state.status === "ready" ? `${apps.length} app${apps.length === 1 ? "" : "s"}` : null}
        </output>
      </div>

      {state.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
          Loading apps…
        </div>
      ) : state.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <AlertTriangle size={18} aria-hidden className="text-warning" />
          <span className="max-w-sm text-xs text-muted">{state.message}</span>
        </div>
      ) : apps.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe2 size={18} aria-hidden className="text-subtle" />
          <span className="text-xs font-medium text-ink">No apps yet</span>
          <span className="max-w-52 text-xs leading-relaxed text-muted">
            {props.receivedShareWorkspace
              ? "This shared view cannot create an app. Ask the workspace owner to add one."
              : "Start with one editable HTML file in your workspace."}
          </span>
          {!props.receivedShareWorkspace ? (
            <PrimaryButton
              data-testid="sites-create-first"
              disabled={creating}
              onClick={() => void createFirstApp()}
              className="mt-1"
            >
              {creating ? "Creating app…" : "Create app"}
            </PrimaryButton>
          ) : null}
        </div>
      ) : (
        <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto p-2">
          {apps.map((app) => {
            const diagnosticLabel = appDiagnosticLabel(app);
            return (
              <li key={app.root}>
                <button
                  type="button"
                  data-testid="sites-row"
                  data-root={app.root}
                  onClick={() => props.onOpenPath(siteTabPath(app.root))}
                  className="flex w-full items-start gap-3 rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:bg-panel-2"
                >
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-line bg-bg text-subtle">
                    {app.packagePath ? (
                      <Box size={14} aria-hidden />
                    ) : (
                      <FileCode2 size={14} aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {app.title}
                      </span>
                      {app.authority.kind === "share" ? (
                        <span
                          data-testid="sites-shared-label"
                          className="shrink-0 text-[11px] text-muted"
                        >
                          Shared
                        </span>
                      ) : null}
                      {diagnosticLabel ? (
                        <span
                          data-testid="sites-diagnostic-indicator"
                          aria-label={diagnosticLabel}
                          title={diagnosticLabel}
                          className="shrink-0 text-warning"
                        >
                          <AlertTriangle size={12} aria-hidden />
                        </span>
                      ) : app.confidence === "low" ? (
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
                      {app.root}
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
