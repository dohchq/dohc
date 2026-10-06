import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspacePathOpenFailedEvent } from "../../ipc/bridgeContract";
import { needsNewerDohc, withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { workspaceName } from "../Titlebar";
import type { ErrorDetailField } from "./copyDetails";

// What a failed launch open says: the folder by name, then why and what to
// do in dohc's words. Copy details keep the error as it arrived.
export function workspacePathOpenNotice(path: string, cause: unknown): { message: string; canRetry: boolean } {
  return {
    message: withErrorWords(`dohc could not open ${workspaceName({ rootPath: path })}.`, cause),
    canRetry: !needsNewerDohc(cause),
  };
}

interface HeldFailures {
  failures: readonly WorkspacePathOpenFailedEvent[];
  take(taken: readonly WorkspacePathOpenFailedEvent[]): void;
}

export const WorkspacePathOpenFailures = createContext<HeldFailures>({ failures: [], take: () => undefined });

/**
 * The window's root holds each failure main sends until a notice owner takes
 * it. The first can arrive before the workspace list is read and any owner
 * is mounted.
 */
export function useHeldWorkspacePathOpenFailures(): HeldFailures {
  const [failures, setFailures] = useState<readonly WorkspacePathOpenFailedEvent[]>([]);
  useEffect(() => bridge().onWorkspacePathOpenFailed((failure) => {
    setFailures((held) => [...held, failure]);
  }), []);
  const take = useCallback((taken: readonly WorkspacePathOpenFailedEvent[]) => {
    setFailures((held) => held.filter((failure) => !taken.includes(failure)));
  }, []);
  return useMemo(() => ({ failures, take }), [failures, take]);
}

type ReportFailure = (failure: {
  message: string;
  cause?: unknown;
  details?: ReadonlyArray<ErrorDetailField>;
  retry?: (() => void) | null;
  identity?: string;
}) => void;

/**
 * A notice owner's side: each held failure becomes a toast and a Notices
 * row with Copy, and with Try again unless only a newer dohc can open it.
 * `workspaceId` is the workspace this owner shows, or null for none.
 */
export function useWorkspacePathOpenFailures(workspaceId: string | null, report: ReportFailure): void {
  const { failures, take } = useContext(WorkspacePathOpenFailures);
  // A Try again that answers after this owner is gone must not report into
  // whatever replaced it.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (failures.length === 0) return;
    const reportFailure = (failure: WorkspacePathOpenFailedEvent, cause: unknown, canRetry: boolean) => {
      const notice = workspacePathOpenNotice(failure.path, cause);
      report({
        message: notice.message,
        cause,
        details: [["Folder", failure.path, failure.path.length]],
        retry: canRetry && notice.canRetry ? () => {
          // Main answers a failure with a new report, and an opened folder
          // by switching to it. Only a refused request lands here.
          void bridge().retryWorkspacePathOpen({ attemptId: failure.attemptId }).catch((error: unknown) => {
            if (live.current) reportFailure(failure, error, false);
          });
        } : null,
        identity: `workspace-path-open:${failure.path}`,
      });
    };
    for (const failure of failures) {
      // Main names the workspace the window showed when it sent this. A
      // workspace that has gone since takes its failure with it.
      if (failure.workspaceId === null || failure.workspaceId === workspaceId) {
        reportFailure(failure, failure.cause, true);
      }
    }
    take(failures);
  }, [failures, report, take, workspaceId]);
}
