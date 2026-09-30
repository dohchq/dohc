import { useCallback, useEffect, useRef, useState } from "react";
import type { ListAutomationHoldsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

export type AutomationHoldNotice = ListAutomationHoldsResult["holds"][number];
export type AutomationStopNotice = ListAutomationHoldsResult["stops"][number];

const NO_HOLDS: ListAutomationHoldsResult = { holds: [], stops: [], unreadable: false, unprovenPaths: [] };

function unidentifiedMessage(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return `Automation steps in "${name}" wait because dohc cannot tell which Collection "${path}/automations.yaml" belongs to in one version of the workspace. Fix its collection.yaml or dataset.json in that version.`;
}

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
  reportShellError: (fallback: string, error: unknown, retry?: () => void) => void,
) {
  const [lists, setLists] = useState<ListAutomationHoldsResult>(NO_HOLDS);
  const token = useRef(0);
  const reads = useRef(0);
  const reported = useRef(new Set<string>());
  const report = useRef(reportShellError);
  report.current = reportShellError;
  const reload = useCallback(async (asked: number, retryPath?: string) => {
    const read = ++reads.current;
    const result = await bridge().listAutomationHolds({ workspaceId, ...(retryPath === undefined ? {} : { retryPath }) });
    if (asked !== token.current || read !== reads.current) return;
    setLists(result);
    // A path that left the list is reported again if it comes back.
    for (const path of reported.current) if (!result.unprovenPaths.includes(path)) reported.current.delete(path);
    // Try again reads the file once more. A retry that fails keeps Try again.
    const unidentified = (path: string, error?: unknown) => {
      const message = unidentifiedMessage(path);
      report.current(message, error ?? new Error(message), () => {
        if (asked !== token.current) return;
        reported.current.delete(path);
        void reload(asked, path).catch((failure: unknown) => {
          if (asked !== token.current || reported.current.has(path)) return;
          reported.current.add(path);
          unidentified(path, failure);
        });
      });
    };
    for (const path of result.unprovenPaths) {
      if (reported.current.has(path)) continue;
      reported.current.add(path);
      unidentified(path);
    }
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    const asked = ++token.current;
    setLists(NO_HOLDS);
    reported.current.clear();
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
