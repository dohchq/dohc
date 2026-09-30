import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AutomationControlsTarget } from "@dohc/workspace-contracts/relay";
import type { RetryCollectionAutomationResult } from "../../ipc/bridgeContract";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useRequestSequence } from "../useRequestSequence";

// Try again for a failed automation run, from the ⚡ panel or from its
// notice. `request` asks main, which queues the claim and wakes the
// executor's drain; `onQueued` re-reads what the caller shows. A run whose
// automation changed since it failed is not a retry: it starts over, so the
// person confirms that first. A switched-off automation queues nothing:
// `onSwitchedOff` takes the person to the switch that turns it on.

export const START_OVER_SENTENCE =
  "This automation changed since it failed. Running it again starts from the beginning and can repeat changes it already made.";
export const REPEATS_MESSAGES_SENTENCE = "Posts, direct messages, and notices it already sent may be sent again.";

export function useAutomationRetry<Target>(options: {
  workspaceId: string;
  request: (target: Target, startOver: boolean) => Promise<RetryCollectionAutomationResult>;
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onQueued: () => void;
  onSwitchedOff: (controls: AutomationControlsTarget, target: Target) => void;
}): { retry: (target: Target) => void; dialog: ReactNode } {
  const { workspaceId, request, onError, onQueued, onSwitchedOff } = options;
  // Rises when the workspace changes: an answer for another workspace, and
  // a confirmation it opened, never reach this one.
  const workspace = useRequestSequence([workspaceId]);
  const [confirming, setConfirming] = useState<{ target: Target; epoch: number; repeatsMessages: boolean } | null>(null);
  useEffect(() => setConfirming(null), [workspaceId]);

  const run = useCallback(
    (target: Target, startOver: boolean) => {
      const epoch = workspace.current();
      const again = () => run(target, startOver);
      void request(target, startOver)
        .then((result) => {
          if (!workspace.isCurrent(epoch)) return;
          if (result.status === "definition-changed") setConfirming({ target, epoch, repeatsMessages: result.repeatsMessages });
          else if (result.status === "refused") onError(result.reason, new Error(result.reason));
          else if (result.status === "switched-off") onSwitchedOff(result.target, target);
          else onQueued();
        })
        .catch((error: unknown) => {
          if (workspace.isCurrent(epoch)) onError("dohc could not run the automation again.", error, again);
        });
    },
    [request, onError, onQueued, onSwitchedOff],
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
        run(confirming.target, true);
      }}
    >
      <p className="m-0 mt-2 text-[13px] text-muted">{START_OVER_SENTENCE}{confirming.repeatsMessages ? ` ${REPEATS_MESSAGES_SENTENCE}` : ""}</p>
    </ConfirmDialog>
  ) : null;
  return { retry, dialog };
}
