import { useCallback, useEffect, useState } from "react";
import type { KeptTyping } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";

const NONE: readonly KeptTyping[] = [];

// Typing kept for workspaces no longer in the list, such as one whose join
// failed. Main says when it changes, as it does for Notices. A list that fails
// shows nothing new: the typing stays on disk for the next list.
export function useKeptTyping(): { keptTyping: readonly KeptTyping[]; dismiss: (kept: KeptTyping) => Promise<void> } {
  const [keptTyping, setKeptTyping] = useState(NONE);
  const requests = useRequestSequence();
  const refresh = useCallback(async () => {
    const request = requests.next();
    try {
      const listed = await bridge().listKeptTyping({});
      if (requests.isCurrent(request)) setKeptTyping(listed);
    } catch (error) {
      console.warn("[desktop] could not list kept typing:", error);
    }
  }, [requests]);
  useEffect(() => {
    const unsubscribe = bridge().onNoticesChanged(() => void refresh());
    void refresh();
    return unsubscribe;
  }, [refresh]);
  const dismiss = useCallback(async (kept: KeptTyping) => {
    await bridge().dismissKeptTyping({ workspaceId: kept.workspaceId, recordId: kept.recordId });
    await refresh();
  }, [refresh]);
  return { keptTyping, dismiss };
}
