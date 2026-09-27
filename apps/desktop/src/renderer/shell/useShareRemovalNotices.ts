import { useCallback, useMemo, useRef } from "react";
import type { RelayShareUndoReceipt } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";

// The relay keeps a removal's receipt for 10 minutes. The notice states that,
// and a late Undo explains itself instead of asking the relay to fail.
export const SHARE_UNDO_WINDOW = "You can undo this for 10 minutes.";
export const SHARE_UNDO_EXPIRED =
  "The 10 minutes to undo this have passed. Share again to give access back.";
export const SHARE_UNDO_FAILED = "dohc could not undo this removal.";

export type ShareRemoval = {
  workspaceId: string;
  // A Change, in the surface's own nouns: "Removed ana@example.com from Trip."
  message: string;
  // The Change the Undo makes: "Restored ana@example.com to Trip."
  restoredMessage: string;
  shareId: string;
  undo: RelayShareUndoReceipt;
  // Runs after access is back, so a list that is still open reads it again.
  restored?: () => void;
};
export type ReportShareRemoval = (removal: ShareRemoval) => void;

// A removal the relay refused. The shell files it with Try again, which runs
// the removal again, and the cause for Copy details.
export type ShareRemovalFailure = {
  workspaceId: string;
  // What did not happen, in the surface's own nouns: "dohc could not end the link to Trip."
  message: string;
  cause: unknown;
  retry?: () => void;
};

export interface ShareRemovalNotices {
  removed: ReportShareRemoval;
  failed: (failure: ShareRemovalFailure) => void;
}

// A removal an owner made: a toast and a Notices row with Undo. The notice is
// the shell's, so Undo outlives the dialog or panel that removed the access.
// Undo puts back the grants the removal ended; it never makes a new one.
export function useShareRemovalNotices(input: {
  workspaceId: string;
  showSuccessNotice: (message: string, undo?: () => void) => void;
  reportShellFailure: (failure: {
    message: string;
    cause?: unknown;
    retry?: (() => void) | null;
  }) => void;
}): ShareRemovalNotices {
  const workspaceIdRef = useRef(input.workspaceId);
  workspaceIdRef.current = input.workspaceId;
  const { showSuccessNotice, reportShellFailure } = input;
  const removed = useCallback<ReportShareRemoval>(
    (removal) => {
      // A switch clears the shell's list, so an answer for the workspace this
      // removal came from must not land in another workspace's notices.
      const current = () => workspaceIdRef.current === removal.workspaceId;
      if (!current()) return;
      let busy = false;
      const undo = async () => {
        if (!current() || busy) return;
        if (Date.now() >= removal.undo.expiresAtMs) {
          reportShellFailure({ message: SHARE_UNDO_EXPIRED });
          return;
        }
        busy = true;
        try {
          await bridge().undoRelayShare({
            shareId: removal.shareId,
            undoId: removal.undo.undoId,
          });
          if (!current()) return;
          showSuccessNotice(removal.restoredMessage);
          removal.restored?.();
        } catch (cause) {
          if (!current()) return;
          reportShellFailure({
            message: withErrorWords(SHARE_UNDO_FAILED, cause),
            cause,
            retry: () => void undo(),
          });
        } finally {
          busy = false;
        }
      };
      showSuccessNotice(`${removal.message} ${SHARE_UNDO_WINDOW}`, () => void undo());
    },
    [reportShellFailure, showSuccessNotice],
  );
  const failed = useCallback(
    (failure: ShareRemovalFailure) => {
      if (workspaceIdRef.current !== failure.workspaceId) return;
      reportShellFailure({
        message: withErrorWords(failure.message, failure.cause),
        cause: failure.cause,
        retry: failure.retry ?? null,
      });
    },
    [reportShellFailure],
  );
  return useMemo(() => ({ removed, failed }), [removed, failed]);
}
