import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellErrorKind } from "../shell/useShellError";

// The shell's hold on a record's History dialog. A failed read keeps one row
// in Notices; its Try again opens that record's History again and reads back
// to the page that failed, even after the dialog or the record's file closed.
// The row clears once the dialog shows that page, or the entries past it.
// A run dohc could not place keeps its own row the same way, until a dialog
// of that record has placed each run the row names.

export const HISTORY_READ_FAILED = "dohc could not read this record's history.";
export const RUN_NOT_CHECKED = "dohc could not check where this run is.";

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
  // The record and runs Notices says dohc could not place, and the oldest page to read back to.
  const unplaced = useRef<{ record: string; runs: Set<string>; until: number | null } | null>(null);

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
  const runsUnchecked = useCallback((shown: RecordHistorySession, until: number | null, error: unknown, runs: readonly string[]) => {
    if (shown.key !== live.current || shown.workspaceId !== workspace.current) return;
    const record = recordOf(shown);
    const held = unplaced.current?.record === record ? unplaced.current : null;
    // A null page is the first, so any page id is older.
    const oldest = held === null || held.until === null ? until : until === null ? held.until : Math.min(held.until, until);
    unplaced.current = { record, runs: new Set([...(held?.runs ?? []), ...runs]), until: oldest };
    deps.current.reportShellError(RUN_NOT_CHECKED, error, () => {
      if (workspace.current === shown.workspaceId) show(shown.workspaceId, shown.target, oldest);
    }, "record-history-run");
  }, [show]);
  const runsChecked = useCallback((shown: RecordHistorySession, runs: readonly string[]) => {
    if (shown.key !== live.current || shown.workspaceId !== workspace.current) return;
    const held = unplaced.current;
    if (held === null || held.record !== recordOf(shown)) return;
    for (const run of runs) held.runs.delete(run);
    if (held.runs.size > 0) return;
    unplaced.current = null;
    deps.current.clearKind("record-history-run");
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
    /** The dialog shown now could not place these runs; Try again reads back to `until`. */
    runsUnchecked: (until: number | null, error: unknown, runs: readonly string[]) => {
      if (shown) runsUnchecked(shown, until, error, runs);
    },
    /** The dialog shown now placed these runs. */
    runsChecked: (runs: readonly string[]) => {
      if (shown) runsChecked(shown, runs);
    },
  };
}
