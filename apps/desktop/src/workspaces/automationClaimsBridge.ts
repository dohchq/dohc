import {
  AUTOMATION_CLAIMED_EVENT,
  type Event,
} from "@dohc/workspace-engine-client";

/**
 * The daemon announces each automation claim a LOCAL apply inserted with an
 * `automation.claimed` event (ADR 0008: a synced apply claims nothing). The
 * event is only the wake-up — the durable claim table is the transport — so
 * this bridge reads nothing but the workspace the payload names (and the
 * claim's state) and pokes that workspace's consumers. An unknown or closed
 * workspace drops the event; its claims drain on the workspace's next open.
 *
 * A pending claim wakes the executor's drain. A claim inserted already
 * failed — the depth cap's `chain-stopped` stop report — is not drainable
 * work, so it instead pokes the owner-visible failure surface to re-read
 * `automations.failures`.
 */
export function bridgeAutomationClaimsToExecutors(
  daemon: { onEvent(handler: (event: Event) => void): () => void },
  executorFor: (workspaceId: string) => { notifyClaimed(): void } | undefined,
  onClaimFailed?: (workspaceId: string) => void,
): () => void {
  return daemon.onEvent((event) => {
    if (event.name !== AUTOMATION_CLAIMED_EVENT) return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
    if ((payload as { state?: unknown }).state === "failed") {
      onClaimFailed?.(workspaceId);
      return;
    }
    executorFor(workspaceId)?.notifyClaimed();
  });
}
