import { useCallback, useEffect, useRef, useState } from "react";
import type { OldWindowState } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";

/**
 * Whether Forget left this window showing `workspaceId`, and whether another
 * window shows it now. Main reads it from this window's own session, and says
 * when a window opened or left a workspace. `recheck` reads it again, for a
 * window that kept its workspace after the workspace list changed. Only the
 * newest answer for the workspace shown now counts.
 */
export function useOldWindowState(workspaceId: string | null): {
  oldWindow: NonNullable<OldWindowState> | null;
  recheck: () => void;
} {
  const [state, setState] = useState<OldWindowState>(null);
  const shown = useRef(workspaceId);
  shown.current = workspaceId;
  const requests = useRequestSequence();
  const recheck = useCallback(() => {
    const asked = shown.current;
    if (asked === null) return;
    const request = requests.next();
    void bridge().readOldWindowState({}).then((answer) => {
      if (requests.isCurrent(request) && shown.current === asked) setState(answer?.workspaceId === asked ? answer : null);
    }, (error: unknown) => console.error("[dohc] could not read whether this window can edit its workspace:", error));
  }, [requests]);
  useEffect(() => {
    recheck();
  }, [workspaceId, recheck]);
  useEffect(() => bridge().onOldWindowStateChanged(recheck), [recheck]);
  return { oldWindow: state !== null && state.workspaceId === workspaceId ? state : null, recheck };
}
