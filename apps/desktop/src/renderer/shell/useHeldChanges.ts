import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";

const NONE: ReadonlySet<string> = new Set();

/**
 * The notes whose save the engine holds, read from the holds themselves, so a
 * note's band stays after its Notice is dismissed. Main signals a Notices
 * change whenever the holds change; only the newest read for this workspace
 * sets the paths, and a read for another workspace never does.
 */
export function useHeldChanges(
  workspaceId: string,
  workspaceIsReady: boolean,
  reportShellError: (fallback: string, error: unknown, retry?: (() => void) | null) => void,
): ReadonlySet<string> {
  const [held, setHeld] = useState<{ workspaceId: string; paths: ReadonlySet<string> }>({ workspaceId, paths: NONE });
  const requests = useRequestSequence([workspaceId]);
  const report = useRef(reportShellError);
  report.current = reportShellError;
  const read = useCallback(async () => {
    const request = requests.next();
    try {
      const { paths } = await bridge().listHeldChanges({ workspaceId });
      if (requests.isCurrent(request)) setHeld({ workspaceId, paths: new Set(paths) });
    } catch (error) {
      if (requests.isCurrent(request)) report.current("dohc could not check which notes have a held change.", error, () => void read());
    }
  }, [workspaceId, requests]);
  useEffect(() => {
    if (!workspaceIsReady) return;
    const unsubscribe = bridge().onNoticesChanged(() => void read());
    void read();
    return unsubscribe;
  }, [workspaceIsReady, read]);
  return held.workspaceId === workspaceId ? held.paths : NONE;
}
