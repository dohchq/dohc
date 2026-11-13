import { useEffect, useRef } from "react";
import { sharedOpenNoticed, type SharedDocumentOpenState } from "../../ipc/sharedDocumentOpenState";
import { reportLiveHostRefusal } from "../shell/useDocumentSaveNotices";

/**
 * Raises a shared page that could not open for editing, because the open
 * failed or the server's live host would not take the page: a toast and a
 * Notices row once per open of the page, then the row alone for each Try
 * again that hears the same answer. The row goes once the page opens for
 * editing.
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
  const refused = sharedOpenNoticed(input.refusal) ? input.refusal : null;
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
