import { useCallback, useEffect, useRef, useState } from "react";
import type { ListAutomationHoldsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

export type AutomationHoldNotice = ListAutomationHoldsResult["holds"][number];

/**
 * Automation steps that wait for someone who can edit the Collection to
 * allow them, as main lists them. Read once the workspace is ready and again
 * on every hold poke. Latest-wins token: an answer for one workspace must
 * never repaint another.
 */
export function useAutomationHolds(
  workspaceId: string,
  workspaceIsReady: boolean,
  reportShellError: (fallback: string, error: unknown) => void,
) {
  const [automationHolds, setAutomationHolds] = useState<AutomationHoldNotice[]>([]);
  const token = useRef(0);
  const reload = useCallback(async () => {
    const current = ++token.current;
    const result = await bridge().listAutomationHolds({ workspaceId });
    if (current !== token.current) return;
    setAutomationHolds(result.holds);
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    void reload().catch(() => undefined);
    return bridge().onAutomationHoldsChanged((event) => {
      if (event.workspaceId !== workspaceId) return;
      void reload().catch(() => undefined);
    });
  }, [workspaceId, workspaceIsReady, reload]);
  const allowAutomationHold = useCallback(
    (hold: AutomationHoldNotice) => {
      void bridge()
        .confirmCollectionAutomationStep({
          workspaceId,
          automationId: hold.automationId,
          definitionHash: hold.definitionHash,
          step: hold.step,
          seq: hold.seq,
        })
        .then(async () => await reload())
        .catch((error: unknown) => {
          reportShellError("Couldn't allow that automation step.", error);
        });
    },
    [workspaceId, reload, reportShellError],
  );
  return { automationHolds, allowAutomationHold };
}
