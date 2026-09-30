import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellErrorKind } from "../shell/useShellError";

// The shell's hold on a record's History dialog. A failed read keeps one row
// in Notices; its Try again opens that record's History again and reads back
// to the page that failed, even after the dialog or the record's file closed.
// The row clears once the dialog shows that page, or the entries past it.

export const HISTORY_READ_FAILED = "dohc could not read this record's history.";

/** A record whose History a person opens, and the name its page shows. */
export interface RecordHistoryTarget {
  collectionPath: string;
  recordId: string;
  recordName: string;
}

export interface RecordHistorySession {
  workspaceId: string;
  target: RecordHistoryTarget;
  /** The older page to read back to, by its beforeHistoryId; null reads the first page only. */
  until: number | null;
  /** A new key opens the dialog afresh. */
  key: number;
}

const recordOf = (shown: RecordHistorySession) => JSON.stringify([shown.workspaceId, shown.target.collectionPath, shown.target.recordId]);

export function useRecordHistory(workspaceId: string, shell: {
  reportShellError: (fallback: string, error: unknown, retry: (() => void) | null, kind?: ShellErrorKind) => void;
  clearKind: (...kinds: ShellErrorKind[]) => void;
  /** Opens the ⚡ panel at one run; resolves to a sentence when it cannot. */
  openAutomationRun: (automationId: string, claimId: string, name: string) => Promise<string | null>;
}) {
  const [session, setSession] = useState<RecordHistorySession | null>(null);
  const deps = useRef(shell);
  deps.current = shell;
  const workspace = useRef(workspaceId);
  workspace.current = workspaceId;
  const key = useRef(0);
  // The dialog shown now; a report from any other is dropped.
  const live = useRef<number | null>(null);
  // The record and page whose failed read Notices holds; a null page is the first.
  const failedRead = useRef<{ record: string; before: number | null } | null>(null);

  const show = useCallback((forWorkspace: string, target: RecordHistoryTarget, until: number | null) => {
    key.current += 1;
    live.current = key.current;
    setSession({ workspaceId: forWorkspace, target, until, key: key.current });
  }, []);
  const open = useCallback((target: RecordHistoryTarget) => show(workspaceId, target, null), [show, workspaceId]);
  const close = useCallback(() => {
    live.current = null;
    setSession(null);
  }, []);
  useEffect(close, [workspaceId, close]);

  const failed = useCallback((shown: RecordHistorySession, before: number | null, error: unknown) => {
    if (shown.key !== live.current || shown.workspaceId !== workspace.current) return;
    failedRead.current = { record: recordOf(shown), before };
    deps.current.reportShellError(HISTORY_READ_FAILED, error, () => {
      if (workspace.current === shown.workspaceId) show(shown.workspaceId, shown.target, before);
    }, "record-history");
  }, [show]);
  // A page read reaches the failed one once the next page starts below it.
  // Entries added since can move page edges, so the edges need not match.
  const read = useCallback((shown: RecordHistorySession, next: number | null) => {
    if (shown.key !== live.current || shown.workspaceId !== workspace.current) return;
    const failure = failedRead.current;
    if (failure === null || failure.record !== recordOf(shown)) return;
    if (failure.before !== null && next !== null && next >= failure.before) return;
    failedRead.current = null;
    deps.current.clearKind("record-history");
  }, []);

  // The ⚡ panel takes focus.
  const openRun = useCallback((automationId: string, claimId: string, name: string) => {
    const owner = workspace.current;
    close();
    void deps.current.openAutomationRun(automationId, claimId, name).then((note) => {
      if (note !== null && workspace.current === owner) deps.current.reportShellError(note, new Error(note), null);
    }).catch((error: unknown) => {
      if (workspace.current !== owner) return;
      deps.current.reportShellError("dohc could not open this run.", error, () => {
        if (workspace.current === owner) openRun(automationId, claimId, name);
      });
    });
  }, [close]);

  const shown = session?.workspaceId === workspaceId ? session : null;
  return {
    session: shown,
    open,
    close,
    openRun,
    /** The dialog shown now could not read a page: the one it asked for, or null for the first. */
    failed: (before: number | null, error: unknown) => {
      if (shown) failed(shown, before, error);
    },
    /** The dialog shown now read a page: `next` is where the page after it starts, or null at the end. */
    read: (next: number | null) => {
      if (shown) read(shown, next);
    },
  };
}
