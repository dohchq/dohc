import {OwnerYDocOutbox, type LiveObjectBinding} from "@dohc/workspace-engine-client";
import type {EngineClient, OwnerYDocDraftDescriptor} from "@dohc/workspace-engine-client/daemon";
import {z} from "zod";
import type {UnwrittenRelease} from "./ownerLiveReleases";

const ServerKeptEdits = z.object({
  objectId: z.string().min(1).max(512), path: z.string().min(1).max(4096), outboxId: z.string().min(1).max(512),
  reason: z.string().min(1).max(128), generation: z.number().int().positive().safe(), recovery: z.enum(["paused", "retrying", "copied"]),
}).strict();
/**
 * A refused queue the server keeps for a document it hosts. `generation`
 * names the refusal; Try again and a confirmed copy name it back.
 */
export type ServerKeptEdits = z.infer<typeof ServerKeptEdits>;

/** The server's refused queues, from its live document list. Absent means none. */
export function readServerKeptEdits(response: unknown): ServerKeptEdits[] {
  return z.object({keptEdits: z.array(ServerKeptEdits).max(256).optional()}).parse(response).keptEdits ?? [];
}

// Enrollment recovers these by itself. Only a refusal waits for the owner.
const BINDING_QUARANTINES = new Set(["stale-binding", "restore-fenced", "binding-changed"]);

/**
 * paused: waiting for the owner. retrying: the owner's Try again waits for
 * delivery. stopping: a Stop waits for the server to stop live editing.
 * stopped-kept: the Stop finished but kept the queue. not-written: the Stop
 * took the edits into the document but could not write its file.
 */
export type OwnerLiveRecovery = "paused" | "retrying" | "stopping" | "stopped-kept" | "not-written";

/** One document whose owner edits the server refused for good, as this computer's engine keeps them. */
export type OwnerLiveQuarantineRecord = {
  objectId: string;
  path: string;
  reason: string;
  /** The refused queue; null once a Stop took its edits into the document. */
  outboxId: string | null;
  /** The binding generation the queue was refused at, which a Try again names. */
  binding: LiveObjectBinding;
  headDeliveryId: string | null;
  recovery: OwnerLiveRecovery;
};

type HeadFacts = {state: string; reason: string | null; binding: LiveObjectBinding; headDeliveryId: string | null; retryDeliveryId: string | null};
/** What each queue's head said, by draft revision and size, so an unchanged queue is not read again. */
export type OwnerLiveHeadCache = Map<string, {key: string; facts: HeadFacts}>;

const sameGeneration = (a: LiveObjectBinding, b: LiveObjectBinding) =>
  a.lineageClaimId === b.lineageClaimId && a.restoreFenceGeneration === b.restoreFenceGeneration;

/** Reads every refused owner queue in one workspace from the engine's durable state. */
export async function readOwnerLiveQuarantines(client: EngineClient, workspace: string, options: {
  unwritten?: readonly UnwrittenRelease[]; heads?: OwnerLiveHeadCache; signal?: AbortSignal;
} = {}): Promise<OwnerLiveQuarantineRecord[]> {
  const {signal, heads} = options;
  const request = () => ({id: 0, workspace, deadlineMs: 30_000});
  const outbox = new OwnerYDocOutbox({sendRequest: request => client.sendRequest(request, signal)}, workspace);
  const found: OwnerLiveQuarantineRecord[] = [];
  const listed = new Set<string>();
  // A queue's head never changes without a new draft revision or size, except
  // for a Try again grant, which is never cached. The base is never needed.
  const readFacts = async (draft: OwnerYDocDraftDescriptor & {outboxId: string}): Promise<HeadFacts> => {
    const key = `${draft.revision}:${draft.pendingBytes}`, cached = heads?.get(draft.outboxId);
    if (cached?.key === key) return cached.facts;
    const head = await outbox.readDeliveryHead(draft.outboxId, draft.binding)
      .catch((error: unknown) => {if (error instanceof TypeError) return outbox.readHead(draft.outboxId); throw error;});
    const facts = {state: head.state, reason: head.quarantineReason, binding: head.binding,
      headDeliveryId: head.entry?.deliveryId ?? null, retryDeliveryId: head.retryDeliveryId};
    if (facts.retryDeliveryId === null) heads?.set(draft.outboxId, {key, facts}); else heads?.delete(draft.outboxId);
    return facts;
  };
  try {
    // Only a Stop for this queue's own version and binding speaks for it.
    const stops = await client.ownerYDocStopList(request(), signal);
    const stopFor = (binding: LiveObjectBinding) => stops.find(stop => stop.document.objectId === binding.objectId &&
      stop.document.mainVersionId === binding.mainVersionId && (stop.binding === null || sameGeneration(stop.binding, binding)));
    let after: Parameters<EngineClient["ownerYDocListDrafts"]>[1]["after"] = null;
    do {
      const page = await client.ownerYDocListDrafts(request(), {after, limit: 64}, signal);
      for (const draft of page.drafts) {
        if (draft.state !== "quarantined" || draft.outboxId === null) continue;
        listed.add(draft.outboxId);
        const head = await readFacts({...draft, outboxId: draft.outboxId});
        if (head.state !== "quarantined" || head.headDeliveryId === null || head.reason === null || BINDING_QUARANTINES.has(head.reason)) continue;
        const stop = stopFor(head.binding);
        found.push({objectId: draft.binding.objectId, path: draft.binding.currentPath, reason: head.reason,
          outboxId: draft.outboxId, binding: head.binding, headDeliveryId: head.headDeliveryId,
          recovery: stop?.state === "released" && stop.deferred ? "stopped-kept"
            : stop && (stop.state === "requested" || stop.retirementOwed) ? "stopping"
            : head.retryDeliveryId === head.headDeliveryId ? "retrying" : "paused"});
      }
      after = page.next;
    } while (after !== null);
  } finally {outbox.dispose();}
  for (const id of heads?.keys() ?? []) if (!listed.has(id)) heads!.delete(id);
  // A release whose queue is still here did not commit: the queue speaks for it.
  for (const release of options.unwritten ?? []) {
    if (found.some(row => row.objectId === release.objectId)) continue;
    found.push({objectId: release.objectId, path: release.path, reason: release.reason, outboxId: null,
      binding: release.binding, headDeliveryId: null, recovery: "not-written"});
  }
  return found;
}

/** The owner's Try again: one more delivery attempt for the refused head. */
export async function retryOwnerLiveQuarantine(client: EngineClient, workspace: string, record: OwnerLiveQuarantineRecord & {outboxId: string}): Promise<void> {
  const outbox = new OwnerYDocOutbox({sendRequest: request => client.sendRequest(request)}, workspace);
  try {await outbox.retry({outboxId: record.outboxId, binding: record.binding});}
  finally {outbox.dispose();}
}

/** Every pending update of a refused queue, with its base and accepted checkpoint, for a recovery copy. The queue stays. */
export async function readOwnerLiveQueue(client: EngineClient, workspace: string, record: OwnerLiveQuarantineRecord & {outboxId: string}) {
  const outbox = new OwnerYDocOutbox({sendRequest: request => client.sendRequest(request)}, workspace);
  try {
    const pending = await outbox.readRecovery(record.outboxId);
    if (pending.state !== "quarantined" || !sameGeneration(pending.binding, record.binding)) {
      throw new Error("This document changed. Open Live documents to check it.");
    }
    return pending;
  } finally {outbox.dispose();}
}
