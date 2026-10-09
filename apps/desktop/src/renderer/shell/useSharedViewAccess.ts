import { useEffect, useRef } from "react";
import type { CheckSharedViewAccessResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { onAutomationButtonCompleted } from "../collections/useAutomationButtons";

const unverified = (): CheckSharedViewAccessResult => ({ status: "unverified" });
export type SharedViewAccessScheduler = (() => Promise<CheckSharedViewAccessResult>) & {
  pull(): Promise<CheckSharedViewAccessResult>;
};

export function useSharedViewAccess(input: {
  workspaceId: string;
  enabled: boolean;
  relayFailed?: boolean;
  admission: { readonly superseded: boolean };
  onVerified(result: CheckSharedViewAccessResult): void;
  pull(): Promise<unknown>;
  onPersistentFailure(error: unknown): void;
}): SharedViewAccessScheduler {
  const latest = useRef(input);
  latest.current = input;
  const run = useRef<(access: boolean, pull: boolean) => Promise<CheckSharedViewAccessResult>>(async () => unverified());
  useEffect(() => {
    if (!input.enabled) return;
    let disposed = false;
    let paused = false;
    let failures = 0;
    let epoch = 0;
    let timer: number | undefined;
    let nextPullAt = Date.now() + 30_000;
    let lastPullAt = -Infinity;
    let inFlight: Promise<CheckSharedViewAccessResult> | null = null;
    let followUp: Promise<CheckSharedViewAccessResult> | null = null;
    let queuedAccess = false;
    let queuedPull = false;
    const isCurrent = () => !disposed && !input.admission.superseded &&
      latest.current.workspaceId === input.workspaceId && latest.current.enabled;
    const visible = () => document.visibilityState !== "hidden";
    const clearTimer = () => { window.clearTimeout(timer); timer = undefined; };
    const schedule = () => {
      clearTimer();
      if (!isCurrent() || !visible() || paused) return;
      timer = window.setTimeout(() => { void request(false, true); }, Math.max(0, nextPullAt - Date.now()));
    };
    const check = (access: boolean, pull: boolean): Promise<CheckSharedViewAccessResult> => {
      if (!isCurrent() || !visible() || paused) return Promise.resolve(unverified());
      clearTimer();
      const startedEpoch = epoch;
      inFlight = (async (): Promise<CheckSharedViewAccessResult> => {
        let result = unverified();
        try {
          const accessCheck = async () => {
            if (!access) return;
            result = await bridge().checkSharedViewAccess({ workspaceId: input.workspaceId });
            if (!isCurrent() || startedEpoch !== epoch) return unverified();
            if (result.status !== "unverified") latest.current.onVerified(result);
          };
          const pullShare = async () => {
            if (!pull) return;
            lastPullAt = Date.now();
            await latest.current.pull();
            if (!isCurrent() || startedEpoch !== epoch) return unverified();
            failures = 0;
            nextPullAt = Date.now() + 30_000;
          };
          // Access verification must not delay the opening pull.
          const completed = await Promise.allSettled([accessCheck(), pullShare()]);
          for (const completion of completed) if (completion.status === "rejected") throw completion.reason;
          return result;
        } catch (error) {
          if (!isCurrent() || startedEpoch !== epoch) return unverified();
          failures += 1;
          const backoff = Math.min(600_000, 30_000 * 2 ** Math.min(failures - 1, 5));
          nextPullAt = Date.now() + Math.min(600_000, backoff * (0.8 + Math.random() * 0.4));
          paused = !!error && typeof error === "object" && "errorKind" in error && error.errorKind === "unauthorized";
          if (paused || failures === 3) latest.current.onPersistentFailure(error);
          return unverified();
        } finally {
          inFlight = null;
          schedule();
        }
      })();
      return inFlight;
    };
    const request = (access: boolean, pull: boolean): Promise<CheckSharedViewAccessResult> => {
      if (!isCurrent() || !visible() || paused) return Promise.resolve(unverified());
      if (!inFlight) return check(access, pull);
      queuedAccess ||= access;
      queuedPull ||= pull;
      if (!followUp) followUp = inFlight.then(() => {
        const access = queuedAccess;
        const pull = queuedPull;
        queuedAccess = queuedPull = false;
        followUp = null;
        return check(access, pull);
      });
      return followUp;
    };
    run.current = request;
    const onReset = () => { failures = 0; nextPullAt = Date.now() + 30_000; void request(true, true); };
    const onFocus = () => {
      if (!isCurrent() || !visible() || paused) return;
      const recovering = failures > 0;
      failures = 0;
      if (Date.now() - lastPullAt < 5_000) {
        if (recovering) { nextPullAt = Date.now() + 30_000; schedule(); }
        return;
      }
      onReset();
    };
    const onVisibility = () => { if (visible()) void request(true, true); else clearTimer(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onReset);
    document.addEventListener("visibilitychange", onVisibility);
    const stopSession = bridge().onCloudSessionChanged(({ phase }) => {
      epoch += 1;
      paused = phase === "changing";
      clearTimer();
      if (phase === "ready") onReset();
    });
    const stopButtons = onAutomationButtonCompleted(input.workspaceId, () => { void request(false, true); });
    void request(true, true);
    return () => {
      disposed = true;
      clearTimer();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onReset);
      document.removeEventListener("visibilitychange", onVisibility);
      stopSession();
      stopButtons();
    };
  }, [input.workspaceId, input.enabled, input.admission]);
  const recovery = useRef({ workspaceId: input.workspaceId, admission: input.admission, failed: false });
  useEffect(() => {
    if (recovery.current.workspaceId !== input.workspaceId || recovery.current.admission !== input.admission) {
      recovery.current = { workspaceId: input.workspaceId, admission: input.admission, failed: false };
    }
    if (input.relayFailed === undefined) return;
    const recovered = recovery.current.failed && !input.relayFailed;
    recovery.current.failed = input.relayFailed;
    if (recovered && input.enabled && !input.admission.superseded) void run.current(true, true);
  }, [input.workspaceId, input.admission, input.enabled, input.relayFailed]);
  return Object.assign(() => run.current(true, false), { pull: () => run.current(false, true) });
}
