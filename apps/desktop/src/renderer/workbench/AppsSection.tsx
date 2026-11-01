import { AlertTriangle, CircleDashed, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { APP_CHECK_FALLBACK_MESSAGE } from "../appCopy";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import type { AboutNotices } from "./About";
import { ipcErrorMessage } from "../ipcError";

export type AppsLoadState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string; apps: SitePackageInfo[] }
  | { status: "failed"; workspaceId: string };

export interface WorkspaceApps {
  state: AppsLoadState;
  retry: () => void;
}

/** Whether the workspace has an app to show. */
export function hasApps(apps: WorkspaceApps): boolean {
  return apps.state.status === "ready" && apps.state.apps.length > 0;
}

// The workspace's apps, for Home's Apps section and the side panel's
// Add an app here…. Every settled file listing refetches them, so an app an
// agent writes appears by itself. The list stays while that runs; only a
// first load, or another workspace, shows loading. Try again keeps the
// failure on screen until the new answer replaces it. A failed read goes to
// the shell's error hook as one Notices row per workspace, which a later read
// clears.
export function useApps(
  workspaceId: string,
  filesSettledRevision: number,
  notices: AboutNotices,
  enabled: boolean,
): WorkspaceApps {
  const [state, setState] = useState<AppsLoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useAsyncResponseEffect(
    () => (enabled ? bridge().listSites({ workspaceId }) : null),
    {
      onSuccess: (result) => {
        notices.clear(appsIdentity(workspaceId));
        setState({ status: "ready", workspaceId, apps: result.sites });
      },
      onError: (error) => {
        setState({ status: "failed", workspaceId });
        notices.report({
          identity: appsIdentity(workspaceId),
          message: ipcErrorMessage(error, "Could not load apps."),
          cause: error,
          retry,
        });
      },
    },
    [workspaceId, filesSettledRevision, attempt, notices, enabled],
  );

  // The row goes when the workspace closes or changes, so its Try again
  // always reads the workspace on screen.
  useEffect(() => () => notices.clear(appsIdentity(workspaceId)), [notices, workspaceId]);

  return useMemo(
    () => ({
      state:
        state.status !== "loading" && state.workspaceId !== workspaceId
          ? { status: "loading" }
          : state,
      retry,
    }),
    [retry, state, workspaceId],
  );
}

function appsIdentity(workspaceId: string): string {
  return `apps:${workspaceId}`;
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

// The marks after an app's title: shared, then a diagnostic or a
// low-confidence detection.
export function AppMarks({ app }: { app: SitePackageInfo }) {
  const diagnosticLabel = appDiagnosticLabel(app);
  return (
    <>
      {app.authority.kind === "share" ? (
        <span
          data-testid="sites-shared-label"
          role="img"
          aria-label="Shared"
          title="Shared"
          className="shrink-0 text-muted"
        >
          <Users size={13} aria-hidden />
        </span>
      ) : null}
      {diagnosticLabel ? (
        <span
          data-testid="sites-diagnostic-indicator"
          role="img"
          aria-label={diagnosticLabel}
          title={diagnosticLabel}
          className="shrink-0 text-warning"
        >
          <AlertTriangle size={13} aria-hidden />
        </span>
      ) : app.confidence === "low" ? (
        <span
          data-testid="sites-low-confidence"
          role="img"
          aria-label="Low confidence detection"
          title="Low confidence detection"
          className="shrink-0 text-subtle"
        >
          <CircleDashed size={13} aria-hidden />
        </span>
      ) : null}
    </>
  );
}

/** What the shell hands the Explorer for Home's Apps section. */
export interface ExplorerApps extends WorkspaceApps {
  // Apps pinned to the sidebar in this workspace, by folder.
  pinnedApps: readonly string[];
  onSetPinned: (appRoot: string, pinned: boolean) => void;
  // Add an app here… asks for the section: it opens and its first row takes
  // focus, then onRevealed clears the request.
  reveal: boolean;
  onRevealed: () => void;
}
