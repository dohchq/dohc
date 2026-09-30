import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ListAutomationHoldsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

/** A held step, and whether it waits on the owner's self-hosted server. */
export type AutomationHoldNotice = ListAutomationHoldsResult["holds"][number] & { onServer: boolean };
export type AutomationStopNotice = ListAutomationHoldsResult["stops"][number];

const NO_HOLDS: ListAutomationHoldsResult = { holds: [], stops: [], unreadable: false, unprovenPaths: [] };
const NO_SERVER_HOLDS: ListAutomationHoldsResult["holds"] = [];

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
 * sets the lists. The steps the owner's self-hosted server holds are read
 * apart, once the workspace is ready and whenever `serverHoldsKey` changes,
 * as it does when the server's notices about them arrive or go.
 */
export function useAutomationHolds(
  workspaceId: string,
  workspaceIsReady: boolean,
  reportShellError: (fallback: string, error: unknown, retry?: (() => void) | null) => void,
  serverHoldsKey: string,
) {
  const [lists, setLists] = useState<ListAutomationHoldsResult>(NO_HOLDS);
  const [serverHolds, setServerHolds] = useState(NO_SERVER_HOLDS);
  const token = useRef(0);
  const reads = useRef(0);
  const serverReads = useRef(0);
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
  // A list the server could not answer says so, with Try again, unless the
  // window moved to another workspace meanwhile. The report is read when it
  // is made, so a new one never reads the list again.
  const reloadServer = useCallback(async (asked: number): Promise<void> => {
    const read = ++serverReads.current;
    try {
      const result = await bridge().listServerAutomationHolds({ workspaceId });
      if (asked === token.current && read === serverReads.current) setServerHolds(result.holds);
    } catch (error) {
      if (asked !== token.current || read !== serverReads.current) return;
      report.current("dohc could not read the automation steps your server holds.", error, () => {
        if (asked === token.current) void reloadServer(asked);
      });
    }
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    const asked = ++token.current;
    setLists(NO_HOLDS);
    reported.current.clear();
    setServerHolds(NO_SERVER_HOLDS);
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
  useEffect(() => {
    if (!workspaceIsReady) return;
    void reloadServer(token.current);
  }, [workspaceIsReady, reloadServer, serverHoldsKey]);
  // Runs a change to the reach notices, then reads them again, unless the
  // window moved to another workspace meanwhile.
  const change = useCallback(
    (work: () => Promise<unknown>, fallback: string) => {
      const asked = token.current;
      void work()
        .then(async () => {
          if (asked === token.current) await Promise.all([reload(asked), reloadServer(asked)]);
        })
        .catch((error: unknown) => {
          if (asked === token.current) reportShellError(fallback, error);
        });
    },
    [reload, reloadServer, reportShellError],
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
        onServer: hold.onServer,
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
  const automationHolds = useMemo(
    () => [
      ...lists.holds.map((hold) => ({ ...hold, onServer: false })),
      ...serverHolds.map((hold) => ({ ...hold, onServer: true })),
    ],
    [lists.holds, serverHolds],
  );
  return {
    automationHolds,
    automationHoldsUnreadable: lists.unreadable,
    allowAutomationHold,
    resetAutomationHolds,
    revealAutomationHolds,
    automationStops: lists.stops,
    dismissAutomationStops,
  };
}
