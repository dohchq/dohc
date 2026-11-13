import { useEffect, useRef, useState } from "react";
import { sharedOpenNoticed, type SharedDocumentOpenState } from "../../ipc/sharedDocumentOpenState";
import { reportLiveHostRefusal } from "../shell/useDocumentSaveNotices";

/** How long a page waits for its owner's dohc, ring alone, before its toast and row. */
export const LIVE_HOST_WAIT_REPORT_MS = 15_000;

/**
 * Raises a shared page that could not open for editing, because the open
 * failed or the server's live host would not take the page: a toast and a
 * Notices row once per open of the page, then the row alone for each Try
 * again that hears the same answer. The row goes once the page opens for
 * editing. A page waiting for its owner's dohc opens by itself, so it shows
 * its ring on the page and raises nothing until it has waited
 * LIVE_HOST_WAIT_REPORT_MS.
 */
export function useLiveHostRefusalNotice(input: {
  workspaceId: string;
  path: string;
  refusal: SharedDocumentOpenState | null;
  available: boolean;
  retry: () => void;
}): void {
  const key = JSON.stringify([input.workspaceId, input.path]);
  const raised = useRef<string | null>(null);
  const current = useRef({ key, retry: input.retry, mounted: true });
  current.current = { key, retry: input.retry, mounted: true };
  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; };
  }, []);
  const noticed = sharedOpenNoticed(input.refusal) ? input.refusal : null;
  // The page that has waited long enough for its owner's dohc. Each new answer
  // from the same wait keeps the wait's start.
  const waits = noticed?.awaitsHost === true;
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!waits) return;
    const timer = setTimeout(() => setWaitedFor(key), LIVE_HOST_WAIT_REPORT_MS);
    return () => { clearTimeout(timer); setWaitedFor(null); };
  }, [key, waits]);
  const refused = noticed && (!waits || waitedFor === key) ? noticed : null;
  useEffect(() => {
    if (refused) {
      const quiet = raised.current === key;
      raised.current = key;
      reportLiveHostRefusal(input.workspaceId, input.path, {
        ...(refused.reason ? { reason: refused.reason } : {}),
        quiet,
        retry: () => {
          if (!current.current.mounted || current.current.key !== key) return false;
          current.current.retry();
          return true;
        },
      });
    } else if (input.available) {
      reportLiveHostRefusal(input.workspaceId, input.path, null);
    }
    // The workspace and path are in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refused, input.available]);
}
