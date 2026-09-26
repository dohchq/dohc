import { useCallback, useEffect, useRef, useState } from "react";
import type { ListAutomationHoldsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

export type AutomationHoldNotice = ListAutomationHoldsResult["holds"][number];
export type AutomationStopNotice = ListAutomationHoldsResult["stops"][number];

const NO_HOLDS: ListAutomationHoldsResult = { holds: [], stops: [], unreadable: false };

/**
 * Automation steps whose reach changed, as main lists them: steps that wait
 * for someone who can edit the Collection to allow them, and steps a
 * narrower share stopped. Read once the workspace is ready and again on
 * every poke. Leaving the workspace retires its token, so an answer for one
 * workspace never repaints another, and only the newest read in a workspace
 * sets the lists.
 */
export function useAutomationHolds(
  workspaceId: string,
  workspaceIsReady: boolean,
  reportShellError: (fallback: string, error: unknown) => void,
) {
  const [lists, setLists] = useState<ListAutomationHoldsResult>(NO_HOLDS);
  const token = useRef(0);
  const reads = useRef(0);
  const reload = useCallback(async (asked: number) => {
    const read = ++reads.current;
    const result = await bridge().listAutomationHolds({ workspaceId });
    if (asked !== token.current || read !== reads.current) return;
    setLists(result);
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    const asked = ++token.current;
    setLists(NO_HOLDS);
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
  // Runs a change to the reach notices, then reads them again, unless the
  // window moved to another workspace meanwhile.
  const change = useCallback(
    (work: () => Promise<unknown>, fallback: string) => {
      const asked = token.current;
      void work()
        .then(async () => {
          if (asked === token.current) await reload(asked);
        })
        .catch((error: unknown) => {
          if (asked === token.current) reportShellError(fallback, error);
        });
    },
    [reload, reportShellError],
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
  const allowAutomationHold = useCallback(
    (hold: AutomationHoldNotice) => change(
      () => bridge().confirmCollectionAutomationStep({
        workspaceId,
        automationId: hold.automationId,
        definitionHash: hold.definitionHash,
        step: hold.step,
        seq: hold.seq,
        ...(hold.recipient ? { recipient: hold.recipient } : {}),
      }),
      "Couldn't allow that automation step.",
    ),
    [workspaceId, change],
  );
  const dismissAutomationStops = useCallback(
    (stops: readonly AutomationStopNotice[]) => change(
      () => bridge().dismissAutomationStops({
        workspaceId,
        stops: stops.map(({ automationId, definitionHash, step, seq }) => ({ automationId, definitionHash, step, seq })),
      }),
      "Couldn't dismiss the stopped automations notice.",
    ),
    [workspaceId, change],
  );
  return {
    automationHolds: lists.holds,
    automationHoldsUnreadable: lists.unreadable,
    allowAutomationHold,
    resetAutomationHolds,
    revealAutomationHolds,
    automationStops: lists.stops,
    dismissAutomationStops,
  };
}
