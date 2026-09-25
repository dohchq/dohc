import { useCallback, useEffect, useRef, useState } from "react";
import type { ListAutomationHoldsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

export type AutomationHoldNotice = ListAutomationHoldsResult["holds"][number];

/**
 * Automation steps that wait for someone who can edit the Collection to
 * allow them, as main lists them. Read once the workspace is ready and again
 * on every hold poke. Leaving the workspace retires its token, so an answer
 * for one workspace never repaints another, and only the newest read in a
 * workspace sets the list.
 */
export function useAutomationHolds(
  workspaceId: string,
  workspaceIsReady: boolean,
  reportShellError: (fallback: string, error: unknown) => void,
) {
  const [automationHolds, setAutomationHolds] = useState<AutomationHoldNotice[]>([]);
  const [automationHoldsUnreadable, setAutomationHoldsUnreadable] = useState(false);
  const token = useRef(0);
  const reads = useRef(0);
  const reload = useCallback(async (asked: number) => {
    const read = ++reads.current;
    const result = await bridge().listAutomationHolds({ workspaceId });
    if (asked !== token.current || read !== reads.current) return;
    setAutomationHolds(result.holds);
    setAutomationHoldsUnreadable(result.unreadable);
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    const asked = ++token.current;
    setAutomationHolds([]);
    setAutomationHoldsUnreadable(false);
    void reload(asked).catch(() => undefined);
    const unsubscribe = bridge().onAutomationHoldsChanged((event) => {
      if (event.workspaceId !== workspaceId || asked !== token.current) return;
      void reload(asked).catch(() => undefined);
    });
    return () => {
      token.current += 1;
      unsubscribe();
    };
  }, [workspaceId, workspaceIsReady, reload]);
  const allowAutomationHold = useCallback(
    (hold: AutomationHoldNotice) => {
      const asked = token.current;
      void bridge()
        .confirmCollectionAutomationStep({
          workspaceId,
          automationId: hold.automationId,
          definitionHash: hold.definitionHash,
          step: hold.step,
          seq: hold.seq,
        })
        .then(async () => {
          if (asked === token.current) await reload(asked);
        })
        .catch((error: unknown) => {
          if (asked === token.current) reportShellError("Couldn't allow that automation step.", error);
        });
    },
    [workspaceId, reload, reportShellError],
  );
  const resetAutomationHolds = useCallback(() => {
    const asked = token.current;
    void bridge()
      .resetAutomationHolds({ workspaceId })
      .then(async (result) => {
        if (asked !== token.current) return;
        if (result.status === "roster-unknown") {
          reportShellError("Couldn't reset automation holds.", new Error("dohc cannot check who can edit this workspace yet. Try again in a moment."));
          return;
        }
        await reload(asked);
      })
      .catch((error: unknown) => {
        if (asked === token.current) reportShellError("Couldn't reset automation holds.", error);
      });
  }, [workspaceId, reload, reportShellError]);
  const revealAutomationHolds = useCallback(() => {
    void bridge()
      .revealAutomationHolds({ workspaceId })
      .catch((error: unknown) => reportShellError("Couldn't open the automations folder.", error));
  }, [workspaceId, reportShellError]);
  return { automationHolds, automationHoldsUnreadable, allowAutomationHold, resetAutomationHolds, revealAutomationHolds };
}
