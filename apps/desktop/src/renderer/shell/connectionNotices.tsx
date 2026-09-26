import { useCallback, useMemo } from "react";
import { bridge } from "../bridge";
import {
  NoticeCenter,
  type CrashReportNotice,
  type WorkspaceErrorNotice,
} from "../workbench/NoticeCenter";
import { errorDetails } from "./copyDetails";
import { useShellError } from "./useShellError";

// What a connection attempt hands the surface that owns its notices. The
// owner raises the toast and the Notices row; the panel shows nothing inline.
export interface ConnectionErrorReport {
  // Main's own sentence, already stripped of the IPC wrapper.
  message: string;
  // The address the failed attempt used, so an owner that reopens a closed
  // panel can put it back in the field. Null for a status check or a
  // disconnect, which carry no address of their own.
  serverUrl: string | null;
  // Runs the same attempt again, and answers false when the panel that made
  // it is gone or has moved on to a newer attempt. The owner opens the
  // panel again rather than retrying nothing.
  retry: (() => boolean) | null;
}

// What a surface accepts so it can pass connection failures up to whatever
// owns notices above it, and take an address back down when that owner
// reopens the surface to retry.
export interface ConnectionNoticeHost {
  onConnectionError?: (error: ConnectionErrorReport) => void;
  initialServerUrl?: string;
}

// useShellError scopes its errors to a workspace and clears them when that
// workspace changes. These surfaces sit outside any workspace, so the scope
// never changes and a route change cannot erase a notice.
const NO_WORKSPACE = "";

/**
 * A notice owner for surfaces outside the workspace shell: the workspace
 * manager, and a CloudLogin with nothing above it that owns errors. Same
 * toast, same Notices row, same Try again and Copy as the shell's own.
 */
export function useConnectionNotices() {
  const {
    shellErrors,
    reportShellError,
    showSuccessNotice,
    retryShellError,
    hideShellError,
    dismissShellError,
  } = useShellError(NO_WORKSPACE);

  // One reporter per surface: `reopen` is what that surface does when the
  // retry can no longer reach the panel that failed.
  const reporter = useCallback(
    (reopen?: (serverUrl: string | null) => void) =>
      (error: ConnectionErrorReport) => {
        reportShellError(error.message, new Error(error.message), () => {
          if (error.retry?.()) return;
          reopen?.(error.serverUrl);
        });
      },
    [reportShellError],
  );

  const notices = useMemo<WorkspaceErrorNotice[]>(
    () =>
      shellErrors.map((error) => ({
        ...(error.tone ? { tone: error.tone } : {}),
        id: error.id,
        message: error.message,
        details: errorDetails([
          ["Error", error.message],
          ["Platform", bridge().platform],
          ["Time", new Date(error.atMs).toISOString()],
        ]),
        atMs: error.atMs,
        canRetry: error.retry !== null,
        seen: error.seen,
      })),
    [shellErrors],
  );

  return {
    reporter,
    reportError: reportShellError,
    showSuccess: showSuccessNotice,
    notices,
    retryNotice: retryShellError,
    hideNotice: hideShellError,
    dismissNotice: dismissShellError,
  };
}

const NOOP = () => undefined;

/**
 * The shell's notice center, docked bottom-right of a surface that has no
 * status bar to hold it. Nothing renders until a notice exists, so the
 * first-run screen keeps its own chrome.
 */
export function ConnectionNotices(props: {
  notices: readonly WorkspaceErrorNotice[];
  onRetry: (id: string) => void;
  onHide: (id: string) => void;
  onDismiss: (id: string) => void;
  crashReport?: CrashReportNotice | null;
  onSendCrashReport?: () => void;
  onDismissCrashReport?: () => void;
}) {
  if (props.notices.length === 0 && !props.crashReport) return null;
  return (
    <div
      data-testid="connection-notices"
      className="fixed bottom-2 right-3 z-30"
    >
      <NoticeCenter
        workspaceId={NO_WORKSPACE}
        host="corner"
        syncStatus={null}
        agentActive={false}
        conflictSummaries={[]}
        onOpenHistory={NOOP}
        onOpenSettings={NOOP}
        onOpenConflicts={NOOP}
        onRefreshShareView={NOOP}
        onRebuildEngineStore={NOOP}
        workspaceErrors={props.notices}
        onRetryWorkspaceError={props.onRetry}
        onHideWorkspaceError={props.onHide}
        onDismissWorkspaceError={props.onDismiss}
        crashReport={props.crashReport ?? null}
        {...(props.onSendCrashReport ? { onSendCrashReport: props.onSendCrashReport } : {})}
        {...(props.onDismissCrashReport ? { onDismissCrashReport: props.onDismissCrashReport } : {})}
      />
    </div>
  );
}
