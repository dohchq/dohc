import { useCallback, useRef, useState } from "react";
import { mergeFilesWait, type VersionMergeNotice } from "../workbench/WorkspaceVersions";
import type { useShellError } from "./useShellError";

type Shell = ReturnType<typeof useShellError>;

// Capture stops only when the data store was refused, and that notice says how to fix it.
export const MERGE_RETRY_AFTER_STORE = "Fix the data store problem in Notices first.";
export const MERGE_RETRY_AFTER_CLOSE = "Close the open merge first.";

// Merges that answered after their dialog closed, as Notices rows. One that
// left files to decide offers the review, and its row has no Dismiss: it
// leaves when the review or a merge dialog closes with none of that merge's
// files waiting. One that stopped partway offers History, which shows what is
// in Main.
export function useVersionMergeNotices(options: {
  workspaceId: string;
  // Capture is on, so Try again can open the merge dialog.
  captureOn: boolean;
  reportShellFailure: Shell["reportShellFailure"];
  clearIdentity: Shell["clearIdentity"];
  openHistory: () => void;
  openConflictReview: () => void;
}) {
  const { workspaceId, captureOn, reportShellFailure, clearIdentity, openHistory, openConflictReview } = options;
  const [mergeOpen, setMergeOpen] = useState(false);
  const toDecide = useRef(new Map<string, string>());

  const report = useCallback(({ decideFrom, offersHistory, ...notice }: VersionMergeNotice) => {
    if (decideFrom === undefined) toDecide.current.delete(notice.identity);
    else toDecide.current.set(notice.identity, decideFrom);
    reportShellFailure({
      ...notice,
      ...(decideFrom === undefined
        ? {}
        : { noDismiss: true, action: { label: "Decide what to keep", run: openConflictReview, reads: true } }),
      ...(offersHistory ? { action: { label: "Open History", run: openHistory, reads: true, afterRetry: true } } : {}),
    });
  }, [openConflictReview, openHistory, reportShellFailure]);

  const settle = useCallback(() => {
    for (const [identity, sourceVersionId] of toDecide.current) {
      // A read that fails keeps the row, and the next close asks again.
      void mergeFilesWait(workspaceId, sourceVersionId).then((waiting) => {
        if (waiting || toDecide.current.get(identity) !== sourceVersionId) return;
        toDecide.current.delete(identity);
        clearIdentity(identity);
      }, () => undefined);
    }
  }, [clearIdentity, workspaceId]);

  // A later merge takes back an earlier failure's row. A row that waits on
  // decisions leaves only once none of its files wait.
  const clear = useCallback((identity: string) => {
    if (!toDecide.current.has(identity)) clearIdentity(identity);
  }, [clearIdentity]);

  const onMergeOpenChange = useCallback((open: boolean) => {
    setMergeOpen(open);
    if (!open) settle();
  }, [settle]);

  return {
    report,
    clear,
    settle,
    onMergeOpenChange,
    // Why a merge row's Try again can't run now.
    retryBlocked: !captureOn ? MERGE_RETRY_AFTER_STORE : mergeOpen ? MERGE_RETRY_AFTER_CLOSE : undefined,
  };
}
