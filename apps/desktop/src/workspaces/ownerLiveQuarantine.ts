import {OwnerYDocOutbox, type LiveObjectBinding} from "@dohc/workspace-engine-client";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";

// Enrollment recovers these by itself. Only a refusal waits for the owner.
const BINDING_QUARANTINES = new Set(["stale-binding", "restore-fenced", "binding-changed"]);

/** One document whose owner edits the server refused for good, as this computer's engine keeps them. */
export type OwnerLiveQuarantineRecord = {
  objectId: string;
  path: string;
  reason: string;
  outboxId: string;
  /** The binding generation the queue was refused at, which a Try again names. */
  binding: LiveObjectBinding;
  headDeliveryId: string;
  recovery: "paused" | "retrying" | "stopped-kept";
};

/** Reads every refused owner queue in one workspace from the engine's durable state. */
export async function readOwnerLiveQuarantines(client: EngineClient, workspace: string, signal?: AbortSignal): Promise<OwnerLiveQuarantineRecord[]> {
  const request = () => ({id: 0, workspace, deadlineMs: 30_000});
  const outbox = new OwnerYDocOutbox({sendRequest: request => client.sendRequest(request, signal)}, workspace);
  const found: OwnerLiveQuarantineRecord[] = [];
  try {
    // A Stop that could not write the queue into the file keeps its row, and the queue.
    const stopped = new Set((await client.ownerYDocStopList(request(), signal)).map(stop => stop.document.objectId));
    let after: Parameters<EngineClient["ownerYDocListDrafts"]>[1]["after"] = null;
    do {
      const page = await client.ownerYDocListDrafts(request(), {after, limit: 64}, signal);
      for (const draft of page.drafts) {
        if (draft.state !== "quarantined" || draft.outboxId === null) continue;
        const head = await outbox.readHead(draft.outboxId);
        if (head.state !== "quarantined" || head.entry === null || head.quarantineReason === null ||
          BINDING_QUARANTINES.has(head.quarantineReason)) continue;
        found.push({objectId: draft.binding.objectId, path: draft.binding.currentPath, reason: head.quarantineReason,
          outboxId: head.outboxId, binding: head.binding, headDeliveryId: head.entry.deliveryId,
          recovery: stopped.has(draft.binding.objectId) ? "stopped-kept"
            : head.retryDeliveryId === head.entry.deliveryId ? "retrying" : "paused"});
      }
      after = page.next;
    } while (after !== null);
  } finally {outbox.dispose();}
  return found;
}

/** The owner's Try again: one more delivery attempt for the refused head. */
export async function retryOwnerLiveQuarantine(client: EngineClient, workspace: string, record: OwnerLiveQuarantineRecord): Promise<void> {
  const outbox = new OwnerYDocOutbox({sendRequest: request => client.sendRequest(request)}, workspace);
  try {await outbox.retry({outboxId: record.outboxId, binding: record.binding});}
  finally {outbox.dispose();}
}
