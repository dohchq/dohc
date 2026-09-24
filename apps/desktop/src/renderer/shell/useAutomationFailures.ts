import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationFailureNotice } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

export function useAutomationFailures(
  workspaceId: string,
  workspaceIsReady: boolean,
  reportShellError: (fallback: string, error: unknown) => void,
) {
  // ---- Automation failure notices (ADR 0008, Phase 4) ----
  // The engine's failed claim rows are the durable record; this state holds
  // only the rows the owner has not acknowledged, as main serves them. Read
  // once the workspace is ready and again on every failure poke; a dismiss
  // re-reads either way, so a stale acknowledgment clears nothing and a
  // newer failure comes back. Latest-wins token, the same guard
  // reloadShareSkipped uses: an answer for one workspace must never repaint
  // another.
  const [automationFailures, setAutomationFailures] = useState<
    AutomationFailureNotice[]
  >([]);
  const automationFailuresToken = useRef(0);
  const reloadAutomationFailures = useCallback(async () => {
    const token = ++automationFailuresToken.current;
    const result = await bridge().listAutomationFailures({ workspaceId });
    if (token !== automationFailuresToken.current) return;
    setAutomationFailures(result.failures);
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    void reloadAutomationFailures().catch(() => undefined);
    return bridge().onAutomationFailuresChanged((event) => {
      if (event.workspaceId !== workspaceId) return;
      void reloadAutomationFailures().catch(() => undefined);
    });
  }, [workspaceId, workspaceIsReady, reloadAutomationFailures]);
  const dismissAutomationFailure = useCallback(
    (automationId: string, generation: number) => {
      void bridge()
        .dismissAutomationFailure({ workspaceId, automationId, generation })
        .then(async () => await reloadAutomationFailures())
        .catch((error: unknown) => {
          reportShellError("Couldn't dismiss that notice.", error);
        });
    },
    [workspaceId, reloadAutomationFailures, reportShellError],
  );

  return { automationFailures, dismissAutomationFailure, reloadAutomationFailures };
}
