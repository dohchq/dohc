import { useCallback, useEffect, useState, type ReactNode } from "react";
import { bridge } from "../bridge";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useRequestSequence } from "../useRequestSequence";

// Try again for a failed automation run, from the ⚡ panel or from its
// notice. Main queues the claim, wakes the executor's drain, and tells the
// failure notices to re-read; `onQueued` re-reads what the caller shows. A
// run whose automation changed since it failed, or whose progress dohc no
// longer has, is not a retry: it starts over, so the person confirms that
// first.

export const START_OVER_SENTENCE =
  "This automation changed since it failed. Running it again starts from the beginning and can repeat changes it already made.";
export const PROGRESS_GONE_SENTENCE =
  "dohc no longer has this run's progress. Running it again starts from the beginning and can repeat changes it already made.";
export const REPEATS_MESSAGES_SENTENCE = "Posts and direct messages it already sent may be sent again.";

type Target = { automationId: string; claimId: string };

export function useAutomationRetry(options: {
  workspaceId: string;
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onQueued: () => void;
}): { retry: (target: Target) => void; dialog: ReactNode } {
  const { workspaceId, onError, onQueued } = options;
  // Rises when the workspace changes: an answer for another workspace, and
  // a confirmation it opened, never reach this one.
  const workspace = useRequestSequence([workspaceId]);
  const [confirming, setConfirming] = useState<(Target & { epoch: number; why: string; repeatsMessages: boolean }) | null>(null);
  useEffect(() => setConfirming(null), [workspaceId]);

  const run = useCallback(
    (target: Target, startOver: boolean) => {
      const epoch = workspace.current();
      const again = () => run(target, startOver);
      void bridge()
        .retryCollectionAutomation({ workspaceId, automationId: target.automationId, claimId: target.claimId, startOver })
        .then((result) => {
          if (!workspace.isCurrent(epoch)) return;
          if (result.status === "definition-changed") setConfirming({ ...target, epoch, why: START_OVER_SENTENCE, repeatsMessages: result.repeatsMessages });
          else if (result.status === "progress-gone") setConfirming({ ...target, epoch, why: PROGRESS_GONE_SENTENCE, repeatsMessages: result.repeatsMessages });
          else if (result.status === "refused") onError(result.reason, new Error(result.reason));
          else onQueued();
        })
        .catch((error: unknown) => {
          if (workspace.isCurrent(epoch)) onError("dohc could not run the automation again.", error, again);
        });
    },
    [workspaceId, onError, onQueued],
  );

  const retry = useCallback((target: Target) => run(target, false), [run]);
  const dialog = confirming && workspace.isCurrent(confirming.epoch) ? (
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
      <p className="m-0 mt-2 text-[13px] text-muted">{confirming.why}{confirming.repeatsMessages ? ` ${REPEATS_MESSAGES_SENTENCE}` : ""}</p>
    </ConfirmDialog>
  ) : null;
  return { retry, dialog };
}
