import { useCallback, useEffect, useRef } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

type Waiting = NonNullable<SyncStatusResult["collectionsWaitingForSync"]>;

// `failed` when the reopen after a pause failed, rather than a wait.
type CollectionsWaitingNotice = { message: string; toast: boolean; failed: boolean };

export function collectionsWaitingMessage(waiting: Waiting): string {
  return waiting === "sync"
    ? "Collection updates are waiting for sync to finish. To continue offline, pause sync in Settings."
    : "dohc paused sync but could not reopen this workspace. Collection updates wait until it reopens.";
}

// What one wait has shown, per workspace. Module state, because the shell
// remounts on every workspace switch and a dismissed row must not come back
// when the person returns.
const shownWaits = new Map<string, { waiting: Waiting; dismissed: boolean }>();

export function forgetCollectionsWaitingNoticesForTests(): void {
  shownWaits.clear();
}

// Collection updates wait for a pull that has not finished. A wait toasts
// once, and a later report replaces its row. Each change of state toasts
// again, such as the reopen after a pause failing. The wait ending, when sync
// finishes or a pause abandons the pull, clears the row. Dismissing it hides
// the row until the next change and leaves the engine waiting. Try again
// asks main for the sync retry; after a pause main repeats the reopen.
export function useCollectionsWaitingNotice(input: {
  workspaceId: string;
  // `undefined` while the status is still loading: unknown, not ended.
  waiting: Waiting | null | undefined;
  retryCloudSync: (workspaceId: string, reason: "person") => Promise<SyncStatusResult>;
  openSyncSettings: () => void;
  report: (notice: CollectionsWaitingNotice, retry: () => void, openSyncSettings: () => void) => void;
  reportRetryFailure: (message: string, error: unknown, retry: () => void) => void;
  clear: () => void;
}): { noteDismissed: () => void } {
  const { workspaceId, waiting, retryCloudSync, openSyncSettings, report, reportRetryFailure, clear } = input;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  // A retry can answer after this shell unmounted on a workspace switch.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // The workspace and state this mount last filed, so a repeated status does
  // not file it twice.
  const filedRef = useRef<string | null>(null);
  const retryRef = useRef<() => void>(() => undefined);

  const file = useCallback(
    (forWorkspace: string, state: Waiting, toast: boolean) => {
      filedRef.current = `${forWorkspace}\0${state}`;
      report(
        { message: collectionsWaitingMessage(state), toast, failed: state === "reopen" },
        () => retryRef.current(),
        openSyncSettings,
      );
    },
    [openSyncSettings, report],
  );

  const retry = useCallback(() => {
    const askedFor = workspaceRef.current;
    const reopen = waitingRef.current === "reopen";
    void retryCloudSync(askedFor, "person").then(
      (status) => {
        if (!mountedRef.current || workspaceRef.current !== askedFor) return;
        const next = status.collectionsWaitingForSync;
        if (!next) {
          shownWaits.delete(askedFor);
          filedRef.current = null;
          clear();
          return;
        }
        // The person asked and the updates still wait: say so again.
        shownWaits.set(askedFor, { waiting: next, dismissed: false });
        file(askedFor, next, true);
      },
      (error: unknown) => {
        if (!mountedRef.current || workspaceRef.current !== askedFor) return;
        reportRetryFailure(
          reopen ? "dohc could not reopen this workspace." : "dohc could not retry sync for this workspace.",
          error,
          () => retryRef.current(),
        );
      },
    );
  }, [clear, file, reportRetryFailure, retryCloudSync]);
  retryRef.current = retry;

  useEffect(() => {
    // A status still loading says nothing. Only a status with no wait ends
    // one, so a remount does not forget what was shown or dismissed.
    if (waiting === undefined) return;
    if (waiting === null) {
      shownWaits.delete(workspaceId);
      filedRef.current = null;
      clear();
      return;
    }
    if (filedRef.current === `${workspaceId}\0${waiting}`) return;
    const shown = shownWaits.get(workspaceId);
    if (shown?.waiting === waiting && shown.dismissed) return;
    const toast = shown?.waiting !== waiting;
    shownWaits.set(workspaceId, { waiting, dismissed: false });
    file(workspaceId, waiting, toast);
  }, [clear, file, waiting, workspaceId]);

  const noteDismissed = useCallback(() => {
    const shown = shownWaits.get(workspaceRef.current);
    if (shown) shown.dismissed = true;
  }, []);

  return { noteDismissed };
}
