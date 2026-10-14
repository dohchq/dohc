import { useCallback, useRef, useState } from "react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { ServerAccountDeleteDialog, type ServerAccountDeleted } from "../ServerAccountDeleteDialog";
import { signInCount } from "../settings/CloudAccountRow";
import type { ConnectionErrorReport } from "./connectionNotices";

type Account = { email: string; server: string };
type Review = Account & { signIns: number };

// The deletion review that Settings' account row opens. The shell owns it, not
// the page: a status read, a session change, or Settings closing redraws the
// page, and none of them may close the review or lose the answer to a delete
// already sent. The review itself closes on a session change before the
// delete is sent.
export function useAccountDeletion(input: {
  cloudStatus: CloudStatusResult | null;
  report: (error: ConnectionErrorReport) => void;
  showSuccess: (message: string) => void;
  showWarning: (message: string) => void;
  // Reads the session again once a review ends.
  onEnded: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const open = useRef(false);
  const latest = useRef(input);
  latest.current = input;

  const start = useCallback((account: Account) => {
    open.current = true;
    setReview({ ...account, signIns: signInCount() });
  }, []);
  const reviewing = useCallback(() => open.current, []);

  function end() {
    open.current = false;
    setReview(null);
    latest.current.onEnded();
  }

  // Main already disconnected from the deleted account.
  function deleted(result: ServerAccountDeleted) {
    if (result.finished) {
      latest.current.showSuccess(`Deleted ${result.email} on ${result.server}. Workspaces on this computer stay.`);
    } else {
      latest.current.showWarning(
        `${result.server} blocked ${result.email} and will finish deleting its data. Workspaces on this computer stay.`,
      );
    }
    end();
  }

  // Try again reviews the same account. Once anyone signed in after the review
  // opened, or nobody is signed in, it declines and the owner opens the page
  // that shows the session now.
  function failed(failedReview: Review, message: string, cause: unknown) {
    latest.current.report({
      message,
      cause,
      serverUrl: null,
      retry: () => {
        if (signInCount() !== failedReview.signIns || latest.current.cloudStatus?.connected !== true) return false;
        start(failedReview);
        return true;
      },
    });
    end();
  }

  const dialog = review ? (
    <ServerAccountDeleteDialog
      email={review.email}
      server={review.server}
      onClose={end}
      onDeleted={deleted}
      onError={(message, cause) => failed(review, message, cause)}
    />
  ) : null;

  return { start, reviewing, dialog };
}
