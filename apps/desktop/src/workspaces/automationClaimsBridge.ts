import {
  AUTOMATION_CLAIMED_EVENT,
  type Event,
} from "@dohc/workspace-engine-client";

/**
 * The daemon announces each automation claim a LOCAL apply inserted with an
 * `automation.claimed` event (ADR 0008: a synced apply claims nothing). The
 * event is only the wake-up — the durable claim table is the transport — so
 * this bridge reads nothing but the workspace the payload names and pokes
 * that workspace's executor to drain. An unknown or closed workspace drops
 * the event; its claims drain on the workspace's next open.
 */
export function bridgeAutomationClaimsToExecutors(
  daemon: { onEvent(handler: (event: Event) => void): () => void },
  executorFor: (workspaceId: string) => { notifyClaimed(): void } | undefined,
): () => void {
  return daemon.onEvent((event) => {
    if (event.name !== AUTOMATION_CLAIMED_EVENT) return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
    executorFor(workspaceId)?.notifyClaimed();
  });
}
