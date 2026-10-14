import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { ServerAccountDeleteDialog, type ServerAccountDeleted } from "../ServerAccountDeleteDialog";
import { signInCount } from "../settings/CloudAccountRow";
import type { ConnectionErrorReport } from "./connectionNotices";

type Account = { email: string; server: string };
type Review = Account & { signIns: number };

// What the open workspace shell lends the deletion: its notices, and the
// session it shows.
export interface AccountDeletionShell {
  cloudStatus: CloudStatusResult | null;
  report: (error: ConnectionErrorReport) => void;
  showSuccess: (message: string) => void;
  showWarning: (message: string) => void;
  // Reads the session again once a review ends.
  onEnded: () => void;
}

export interface AccountDeletion {
  start: (account: Account) => void;
  reviewing: () => boolean;
  // The open shell attaches itself, and detaches with the returned function.
  attach: (shell: AccountDeletionShell) => () => void;
}

// The deletion review that Settings' account row opens. DesktopRoot owns it,
// above the workspace shell: a status read, a session change, Settings
// closing, or a workspace switch redraws or replaces the shell, and none of
// them may close the review or lose the answer to a delete already sent. That
// answer goes to the shell open when it arrives, or to the next one to open.
// The review itself closes on a session change before the delete is sent.
export function useAccountDeletion(): { deletion: AccountDeletion; dialog: ReactNode } {
  const [review, setReview] = useState<Review | null>(null);
  const open = useRef(false);
  const shell = useRef<AccountDeletionShell | null>(null);
  const held = useRef<((shell: AccountDeletionShell) => void) | null>(null);

  const start = useCallback((account: Account) => {
    open.current = true;
    setReview({ ...account, signIns: signInCount() });
  }, []);
  const reviewing = useCallback(() => open.current, []);
  const attach = useCallback((next: AccountDeletionShell) => {
    shell.current = next;
    return () => {
      if (shell.current === next) shell.current = null;
    };
  }, []);
  const deletion = useMemo(() => ({ start, reviewing, attach }), [start, reviewing, attach]);
  // A parent's effect, so a shell that just opened has started its notices
  // empty before the held answer arrives in them.
  useEffect(() => {
    const waiting = held.current;
    if (!waiting || !shell.current) return;
    held.current = null;
    waiting(shell.current);
  });

  function end(notify?: (shell: AccountDeletionShell) => void) {
    open.current = false;
    setReview(null);
    const finish = (to: AccountDeletionShell) => {
      notify?.(to);
      to.onEnded();
    };
    if (shell.current) finish(shell.current);
    else held.current = finish;
  }

  // Main already disconnected from the deleted account.
  function deleted(result: ServerAccountDeleted) {
    end((to) => {
      if (result.finished) {
        to.showSuccess(`Deleted ${result.email} on ${result.server}. Workspaces on this computer stay.`);
      } else {
        to.showWarning(
          `${result.server} blocked ${result.email} and will finish deleting its data. Workspaces on this computer stay.`,
        );
      }
    });
  }

  // Try again reviews the same account. Once anyone signed in after the review
  // opened, or nobody is signed in, it declines and the owner opens the page
  // that shows the session now.
  function failed(failedReview: Review, message: string, cause: unknown) {
    end((to) =>
      to.report({
        message,
        cause,
        serverUrl: null,
        retry: () => {
          if (signInCount() !== failedReview.signIns || shell.current?.cloudStatus?.connected !== true) return false;
          start(failedReview);
          return true;
        },
      }),
    );
  }

  // Outside the shell, so it carries the shell's chrome rules itself.
  const dialog = review ? (
    <div className="app-chrome contents">
      <ServerAccountDeleteDialog
        email={review.email}
        server={review.server}
        onClose={() => end()}
        onDeleted={deleted}
        onError={(message, cause) => failed(review, message, cause)}
      />
    </div>
  ) : null;

  return { deletion, dialog };
}
