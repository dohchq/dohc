import { useCallback, useEffect, useRef } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

type SyncFailure = NonNullable<SyncStatusResult["syncFailure"]>;

type SyncFailureNotice = { message: string; detail: string; toast: boolean };

// Only an unreachable server is known to leave this machine's copy untouched,
// so only that message says the changes are saved here.
export function syncFailureMessage(failure: SyncFailure): string {
  return failure.cause === "server-unreachable"
    ? "dohc could not reach the server. Your changes are saved on this machine."
    : "dohc could not sync this workspace.";
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
  failure: SyncFailure | null;
  retryCloudSync: (workspaceId: string) => Promise<SyncStatusResult>;
  report: (notice: SyncFailureNotice, retry: () => void) => void;
  clear: () => void;
}): { retry: () => void; noteDismissed: () => void } {
  const { workspaceId, failure, retryCloudSync, report, clear } = input;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const failureRef = useRef(failure);
  failureRef.current = failure;
  // The failed pass this mount last filed, so a status read that repeats it
  // does not file it twice.
  const filedRef = useRef<string | null>(null);

  const retryRef = useRef<() => void>(() => undefined);
  const file = useCallback(
    (notice: SyncFailureNotice, key: string) => {
      filedRef.current = key;
      report(notice, () => retryRef.current());
    },
    [report],
  );

  const retry = useCallback(() => {
    const askedFor = workspaceRef.current;
    void retryCloudSync(askedFor).then(
      (status) => {
        if (workspaceRef.current !== askedFor) return;
        const next = status.syncFailure;
        if (!next) {
          shownFailures.delete(askedFor);
          filedRef.current = null;
          clear();
          return;
        }
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
          `${next.sinceMs}:${next.attempts}`,
        );
      },
      (error: unknown) => {
        if (workspaceRef.current !== askedFor) return;
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

  const sinceMs = failure?.sinceMs ?? null;
  const attempts = failure?.attempts ?? null;
  useEffect(() => {
    const current = failureRef.current;
    if (current === null) {
      shownFailures.delete(workspaceId);
      filedRef.current = null;
      clear();
      return;
    }
    const key = `${current.sinceMs}:${current.attempts}`;
    if (filedRef.current === key) return;
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
  }, [attempts, clear, file, sinceMs, workspaceId]);

  // Back online after an outage: try now instead of waiting out the backoff.
  // Its outcome arrives as status, like any automatic pass.
  useEffect(() => {
    const onOnline = () => {
      if (failureRef.current === null) return;
      void retryCloudSync(workspaceRef.current).catch(() => undefined);
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
