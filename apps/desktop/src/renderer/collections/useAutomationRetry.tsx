import { useCallback, useState, type ReactNode } from "react";
import { bridge } from "../bridge";
import { ConfirmDialog } from "../ui/ConfirmDialog";

// Try again for a failed automation run, from the ⚡ panel or from its
// notice. Main queues the claim, wakes the executor's drain, and tells the
// failure notices to re-read; `onQueued` re-reads what the caller shows. A
// run whose automation changed since it failed is not a retry: it starts
// over, so the person confirms that first.

export const START_OVER_SENTENCE =
  "This automation changed since it failed. Running it again starts from the beginning and can repeat changes it already made.";

type Target = { automationId: string; claimId: string };

export function useAutomationRetry(options: {
  workspaceId: string;
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onQueued: () => void;
}): { retry: (target: Target) => void; dialog: ReactNode } {
  const { workspaceId, onError, onQueued } = options;
  const [confirming, setConfirming] = useState<Target | null>(null);

  const run = useCallback(
    (target: Target, startOver: boolean) => {
      const again = () => run(target, startOver);
      void bridge()
        .retryCollectionAutomation({ workspaceId, automationId: target.automationId, claimId: target.claimId, startOver })
        .then((result) => {
          if (result.status === "definition-changed") setConfirming(target);
          else if (result.status === "refused") onError(result.reason, new Error(result.reason));
          else onQueued();
        })
        .catch((error: unknown) => onError("dohc could not run the automation again.", error, again));
    },
    [workspaceId, onError, onQueued],
  );

  const retry = useCallback((target: Target) => run(target, false), [run]);
  const dialog = confirming ? (
    <ConfirmDialog
      title="Run from the start?"
      confirmLabel="Run from the start"
      testId="automation-start-over"
      cancelTestId="automation-start-over-cancel"
      confirmTestId="automation-start-over-confirm"
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        setConfirming(null);
        run(confirming, true);
      }}
    >
      <p className="m-0 mt-2 text-[13px] text-muted">{START_OVER_SENTENCE}</p>
    </ConfirmDialog>
  ) : null;
  return { retry, dialog };
}
