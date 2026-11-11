import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import { useRequestSequence } from "./useRequestSequence";

/**
 * Whether the engine holds a save for this note, read from the hold itself,
 * so the band stays after its Notice is dismissed. Only an open lossy note
 * asks; main signals a Notices change whenever a hold starts or ends. Only
 * the newest read for this workspace and note sets the answer.
 */
export function useHeldChange(
  workspaceId: string,
  path: string,
  enabled: boolean,
  reportError: ReportButtonError | undefined,
): boolean {
  const [held, setHeld] = useState<{ workspaceId: string; path: string } | null>(null);
  const requests = useRequestSequence([workspaceId, path]);
  const report = useRef(reportError);
  report.current = reportError;
  const read = useCallback(async () => {
    const request = requests.next();
    try {
      const { change } = await bridge().readHeldChange({ workspaceId, path });
      if (requests.isCurrent(request)) setHeld(change ? { workspaceId, path } : null);
    } catch (error) {
      if (requests.isCurrent(request)) report.current?.("dohc could not check whether this note has a held change.", error, () => void read());
    }
  }, [workspaceId, path, requests]);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = bridge().onNoticesChanged(() => void read());
    void read();
    return unsubscribe;
  }, [enabled, read]);
  return enabled && held?.workspaceId === workspaceId && held.path === path;
}
