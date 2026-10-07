import { useEffect, useRef } from "react";
import type { CheckSharedViewAccessResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

export function useSharedViewAccess(input: {
  workspaceId: string;
  enabled: boolean;
  relayFailed?: boolean;
  admission: { readonly superseded: boolean };
  onVerified(result: CheckSharedViewAccessResult): void;
}): () => Promise<CheckSharedViewAccessResult> {
  const latest = useRef(input);
  latest.current = input;
  const run = useRef<() => Promise<CheckSharedViewAccessResult>>(async () => ({ status: "unverified" }));
  useEffect(() => {
    if (!input.enabled) return;
    let disposed = false;
    let inFlight: Promise<CheckSharedViewAccessResult> | null = null;
    let immediate: Promise<CheckSharedViewAccessResult> | null = null;
    const isCurrent = () => !disposed && !input.admission.superseded &&
      latest.current.workspaceId === input.workspaceId && latest.current.enabled;
    const check = (): Promise<CheckSharedViewAccessResult> => {
      if (!isCurrent() || document.visibilityState === "hidden") return Promise.resolve({ status: "unverified" });
      if (inFlight) return inFlight;
      inFlight = (async (): Promise<CheckSharedViewAccessResult> => {
        try {
          const result = await bridge().checkSharedViewAccess({ workspaceId: input.workspaceId });
          if (!isCurrent()) return { status: "unverified" };
          if (result.status !== "unverified") latest.current.onVerified(result);
          return result;
        } catch {
          return { status: "unverified" };
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    };
    const recheck = (): Promise<CheckSharedViewAccessResult> => {
      if (inFlight) {
        if (!immediate) immediate = inFlight.then(check).finally(() => { immediate = null; });
        return immediate;
      }
      return check();
    };
    run.current = recheck;
    const onEvent = () => { void recheck(); };
    const interval = window.setInterval(() => { void check(); }, 5_000);
    window.addEventListener("focus", onEvent);
    document.addEventListener("visibilitychange", onEvent);
    void check();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onEvent);
      document.removeEventListener("visibilitychange", onEvent);
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
    if (recovered && input.enabled && !input.admission.superseded) void run.current();
  }, [input.workspaceId, input.admission, input.enabled, input.relayFailed]);
  return () => run.current();
}
