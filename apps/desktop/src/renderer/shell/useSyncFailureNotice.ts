import { useCallback, useEffect, useRef } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

type SyncFailure = NonNullable<SyncStatusResult["syncFailure"]>;

type SyncFailureNotice = { message: string; detail: string; toast: boolean };

// Neither message vouches for this machine's copy: a failed sync pass does
// not prove local writes are healthy, and each document shows its own save.
export function syncFailureMessage(failure: SyncFailure): string {
  return failure.cause === "server-unreachable"
    ? "dohc could not reach the server."
    : "dohc could not sync this workspace.";
}

// One failed pass, named the same way whether the retry's answer or the
// status reports it, so the two file one row. A reconnect retry changes the
// cause or detail without counting an attempt, and still needs a new key.
function failedPassKey(failure: SyncFailure): string {
  return `${failure.sinceMs}:${failure.attempts}:${failure.cause}:${failure.detail}`;
}

// What one failure has already shown, per workspace. Module state, because
// the shell remounts on every workspace switch and a dismissed failure must
// not come back when the person returns.
const shownFailures = new Map<
  string,
  { sinceMs: number; toasted: boolean; dismissed: boolean }
>();

export function forgetSyncFailureNoticesForTests(): void {
  shownFailures.clear();
}

// A failed sync goes to the titlebar and to a Notices row at once. It
// interrupts with a toast only when it outlives one automatic retry, once per
// failure, or when a retry the person asked for fails. Try again runs a pass
// now; coming back online does the same without a toast of its own.
export function useSyncFailureNotice(input: {
  workspaceId: string;
  // `undefined` while the status is still loading: unknown, not recovered.
  failure: SyncFailure | null | undefined;
  retryCloudSync: (
    workspaceId: string,
    reason: "person" | "reconnect",
  ) => Promise<SyncStatusResult>;
  report: (notice: SyncFailureNotice, retry: () => void) => void;
  clear: () => void;
}): { retry: () => void; noteDismissed: () => void } {
  const { workspaceId, failure, retryCloudSync, report, clear } = input;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  // A retry can answer after this shell unmounted on a workspace switch. Its
  // answer then belongs to no surface and must not touch what the next mount
  // reads.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const failureRef = useRef(failure);
  failureRef.current = failure;
  // The failed pass this mount last filed, and whether it toasted, so a
  // status read or a retry's answer that repeats it does not file it twice.
  const filedRef = useRef<{ key: string; toast: boolean } | null>(null);

  const retryRef = useRef<() => void>(() => undefined);
  const file = useCallback(
    (notice: SyncFailureNotice, key: string) => {
      filedRef.current = { key, toast: notice.toast };
      report(notice, () => retryRef.current());
    },
    [report],
  );

  const retry = useCallback(() => {
    const askedFor = workspaceRef.current;
    void retryCloudSync(askedFor, "person").then(
      (status) => {
        if (!mountedRef.current || workspaceRef.current !== askedFor) return;
        const next = status.syncFailure;
        if (!next) {
          shownFailures.delete(askedFor);
          filedRef.current = null;
          clear();
          return;
        }
        // The status already toasted this failed pass.
        const key = failedPassKey(next);
        if (filedRef.current?.key === key && filedRef.current.toast) return;
        // The person asked and it failed: say so, whatever was shown before.
        const shown = shownFailures.get(askedFor);
        if (shown?.sinceMs === next.sinceMs) {
          shown.toasted = true;
          shown.dismissed = false;
        } else {
          shownFailures.set(askedFor, { sinceMs: next.sinceMs, toasted: true, dismissed: false });
        }
        file(
          { message: syncFailureMessage(next), detail: next.detail, toast: true },
          key,
        );
      },
      (error: unknown) => {
        if (!mountedRef.current || workspaceRef.current !== askedFor) return;
        file(
          {
            message: "dohc could not retry sync for this workspace.",
            detail: error instanceof Error ? error.message : String(error),
            toast: true,
          },
          "retry-request",
        );
      },
    );
  }, [clear, file, retryCloudSync]);
  retryRef.current = retry;

  const known = failure !== undefined;
  const sinceMs = failure?.sinceMs ?? null;
  const attempts = failure?.attempts ?? null;
  const cause = failure?.cause ?? null;
  const detail = failure?.detail ?? null;
  useEffect(() => {
    const current = failureRef.current;
    // A status still loading says nothing. Only a status with no failure
    // ends one, so a remount does not forget what was shown or dismissed.
    if (current === undefined) return;
    if (current === null) {
      shownFailures.delete(workspaceId);
      filedRef.current = null;
      clear();
      return;
    }
    // Refiling after a reconnect retry keeps the row in step and cannot
    // raise a toast, because the attempts did not grow.
    const key = failedPassKey(current);
    if (filedRef.current?.key === key) return;
    let shown = shownFailures.get(workspaceId);
    if (shown?.sinceMs !== current.sinceMs) {
      shown = { sinceMs: current.sinceMs, toasted: false, dismissed: false };
      shownFailures.set(workspaceId, shown);
    }
    if (shown.dismissed) return;
    const toast = current.attempts > 1 && !shown.toasted;
    if (toast) shown.toasted = true;
    file(
      { message: syncFailureMessage(current), detail: current.detail, toast },
      key,
    );
  }, [attempts, cause, clear, detail, file, known, sinceMs, workspaceId]);

  // Back online after an outage: try now instead of waiting out the backoff.
  // Its outcome arrives as status, like any automatic pass.
  useEffect(() => {
    const onOnline = () => {
      if (!failureRef.current) return;
      void retryCloudSync(workspaceRef.current, "reconnect").catch(() => undefined);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [retryCloudSync]);

  const noteDismissed = useCallback(() => {
    const shown = shownFailures.get(workspaceRef.current);
    if (shown) shown.dismissed = true;
  }, []);

  return { retry, noteDismissed };
}
