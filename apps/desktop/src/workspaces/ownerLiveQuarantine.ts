import {OwnerYDocOutbox, OwnerYDocOutboxReadChangedError, type JsonValue, type LiveObjectBinding, type OwnerYDocOutboxRecovery} from "@dohc/workspace-engine-client";
import {EngineRequestError, type EngineClient, type OwnerYDocDraftDescriptor} from "@dohc/workspace-engine-client/daemon";
import {z} from "zod";
import {recoverySnapshot, sameBinding, type UnwrittenRelease} from "./ownerLiveReleases";

const ServerKeptEdits = z.object({
  objectId: z.string().min(1).max(512), path: z.string().min(1).max(4096), outboxId: z.string().min(1).max(512),
  reason: z.string().min(1).max(128), generation: z.number().int().positive().safe(), store: z.string().min(1).max(64),
  recovery: z.enum(["paused", "retrying", "copied"]), earlier: z.literal(true).optional(),
}).strict();
/**
 * A refused queue the server keeps for a document it hosts. `generation`
 * names the refusal; Try again and a confirmed copy name it back. `store`
 * names the server's copy of the workspace that holds it: copies can hold
 * different queues with the same outbox ID.
 * `earlier`: the server keeps them in an earlier copy of the workspace, before
 * and after a copy. Save recovery copy reads them from there; Try again cannot reach them.
 */
export type ServerKeptEdits = z.infer<typeof ServerKeptEdits>;

/** The server answered that the refusal an action named changed or is gone, or that Try again cannot reach an earlier copy's edits. */
export class ServerKeptEditsConflict extends Error {
  constructor(readonly earlier: boolean) {
    super(earlier ? "The server kept these edits in an earlier copy of this workspace. Save a recovery copy to get them back."
      : "This document changed. Open Live documents to check it.");
  }
}

const RECOVERY_COPY_REFUSALS = {
  "disk-space": "Ask the server administrator to free disk space, then try again.",
  "newer-schema": "Ask the server administrator to update dohc, then try again.",
  busy: "The server is using the earlier workspace copy. Try again when it finishes.",
  server: "Ask the server administrator to check the server, then try again.",
} as const;
export type RecoveryCopyRefusalReason = keyof typeof RECOVERY_COPY_REFUSALS;

/**
 * The server could not prepare the earlier copy of the workspace that holds
 * the edits, for the reason its code names. The server keeps them; saving
 * the copy again asks the server to prepare it again.
 */
export class ServerRecoveryCopyRefusedError extends Error {
  override readonly name = "ServerRecoveryCopyRefusedError";
  readonly code: RecoveryCopyRefusalReason;
  constructor(reason: unknown) {
    const code = typeof reason === "string" && Object.hasOwn(RECOVERY_COPY_REFUSALS, reason) ? reason as RecoveryCopyRefusalReason : "server";
    super(RECOVERY_COPY_REFUSALS[code]);
    this.code = code;
  }
}

// How often a read asks again while the server prepares an earlier copy,
// and how long it waits in all. The server ends its own preparation sooner.
const PREPARING_POLL_MS = 1_000;
const PREPARING_LIMIT_MS = 6 * 60_000;

const SERVER_KEPT_EDITS_PAGE = 256;
const FirstKeptEditsPage = z.object({keptEdits: z.array(ServerKeptEdits).max(SERVER_KEPT_EDITS_PAGE).optional(),
  keptEditsCursor: z.number().int().positive().safe().optional()});
const LaterKeptEditsPage = z.object({ok: z.literal(true), keptEdits: z.array(ServerKeptEdits).max(SERVER_KEPT_EDITS_PAGE),
  nextCursor: z.number().int().positive().safe().nullable()}).strict();

/**
 * Every refused queue the server keeps for the workspace: the live document
 * list's first page, then each later page its cursor names, through `page`.
 * Each page must parse and move the cursor forward, or the whole scan fails.
 * A queue listed twice, as when it was refused again during the scan, keeps
 * its later row. Absent means none.
 */
export async function readServerKeptEdits(response: unknown, page: (after: number) => Promise<unknown>): Promise<ServerKeptEdits[]> {
  const first = FirstKeptEditsPage.parse(response), rows = new Map<string, ServerKeptEdits>();
  const queue = (row: ServerKeptEdits) => JSON.stringify([row.store, row.outboxId]);
  for (const row of first.keptEdits ?? []) rows.set(queue(row), row);
  for (let after = first.keptEditsCursor; after !== undefined;) {
    const next = LaterKeptEditsPage.parse(await page(after));
    for (const row of next.keptEdits) {rows.delete(queue(row)); rows.set(queue(row), row);}
    if (next.nextCursor !== null && next.nextCursor <= after) throw new Error("The server's kept edits cursor did not advance.");
    after = next.nextCursor ?? undefined;
  }
  return [...rows.values()];
}

/**
 * Reads a refused queue the server keeps, whole, one bounded page per
 * request through `page`, as this computer's engine would read its own. A
 * queue that changed under the read answers as changed. While the server
 * prepares the earlier copy of the workspace that holds it, each page is
 * asked for again after `wait`.
 */
export async function readServerKeptEditsQueue(row: ServerKeptEdits, page: (cursor: JsonValue | undefined) => Promise<unknown>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<OwnerYDocOutboxRecovery> {
  const served = z.object({ok: z.literal(true), page: z.record(z.string(), z.unknown())}).strict();
  const outbox = new OwnerYDocOutbox({sendRequest: async request => {
    const params = request.params as {outboxId?: unknown; cursor?: JsonValue};
    if (request.method !== "ydoc.ownerOutbox.readPending" || params.outboxId !== row.outboxId) throw new Error("Unsupported kept edits read.");
    for (let waited = 0; ; waited += PREPARING_POLL_MS) {
      const result = served.parse(await page(params.cursor)).page;
      if (result.kind !== "preparing") return {id: request.id, result: result as JsonValue};
      if (waited >= PREPARING_LIMIT_MS) throw new ServerRecoveryCopyRefusedError("server");
      await wait(PREPARING_POLL_MS);
    }
  }}, "server");
  try {
    const queue = await outbox.readRecovery(row.outboxId);
    if (queue.outboxId !== row.outboxId || queue.binding.objectId !== row.objectId || queue.state !== "quarantined") throw new ServerKeptEditsConflict(false);
    return queue;
  } catch (error) {
    if (error instanceof OwnerYDocOutboxReadChangedError) throw new ServerKeptEditsConflict(false);
    throw error;
  } finally {outbox.dispose();}
}

// Enrollment recovers these by itself. Only a refusal waits for the owner.
const BINDING_QUARANTINES = new Set(["stale-binding", "restore-fenced", "binding-changed"]);
// The engine's answers about one queue, not about the engine or the workspace.
const QUEUE_REFUSALS = new Set(["INVALID_PARAMS", "INTERNAL"]);

/**
 * paused: waiting for the owner. retrying: the owner's Try again waits for
 * delivery. stopping: a Stop waits for the server to stop live editing.
 * stopped-kept: the Stop finished but kept the queue. not-written: the Stop
 * took the edits into the document but could not write its file.
 * cannot-write: as not-written, but the engine no longer holds that release,
 * so only Save recovery copy remains. unreadable: the engine refused to read
 * the queue's head, so only reading it again can act on it.
 */
export type OwnerLiveRecovery = "paused" | "retrying" | "stopping" | "stopped-kept" | "not-written" | "cannot-write" | "unreadable";

/** One document whose owner edits the server refused for good, as this computer's engine keeps them. */
export type OwnerLiveQuarantineRecord = {objectId: string; path: string; reason: string} & ({
  /** The refused queue. */
  outboxId: string;
  /** The binding generation the queue was refused at, which a Try again names. */
  binding: LiveObjectBinding;
  headDeliveryId: string;
  recovery: Exclude<OwnerLiveRecovery, "not-written" | "cannot-write" | "unreadable">;
} | {
  /** A refused queue whose head the engine refused to read; `reason` names that failure and `binding` is its draft's. */
  outboxId: string;
  binding: LiveObjectBinding;
  headDeliveryId: null;
  recovery: "unreadable";
} | {
  /** A Stop took the edits into the document; its record keeps the release's binding and queue head when it could read them. */
  outboxId: null;
  binding: LiveObjectBinding | null;
  headDeliveryId: string | null;
  recovery: "not-written" | "cannot-write";
});

type HeadFacts = {state: string; reason: string | null; binding: LiveObjectBinding; headDeliveryId: string | null; retryDeliveryId: string | null};
/**
 * What each queue's head said, by draft revision and size, so an unchanged
 * queue is not read again; and its whole snapshot, once a record needed it.
 */
export type OwnerLiveHeadCache = Map<string, {key: string; facts: HeadFacts; snapshot?: string}>;

export const sameGeneration = (a: LiveObjectBinding, b: LiveObjectBinding) =>
  a.lineageClaimId === b.lineageClaimId && a.restoreFenceGeneration === b.restoreFenceGeneration;

/**
 * Reads every refused owner queue in one workspace from the engine's durable
 * state. A queue whose head the engine refuses to read keeps an unreadable
 * row, unless `strict` names it: an action that needs its head then fails
 * with the engine's refusal.
 */
export async function readOwnerLiveQuarantines(client: EngineClient, workspace: string, options: {
  unwritten?: readonly UnwrittenRelease[]; heads?: OwnerLiveHeadCache; signal?: AbortSignal;
  strict?: (binding: LiveObjectBinding) => boolean;
} = {}): Promise<OwnerLiveQuarantineRecord[]> {
  const {signal, heads, strict} = options;
  const request = () => ({id: 0, workspace, deadlineMs: 30_000});
  const outbox = new OwnerYDocOutbox({sendRequest: request => client.sendRequest(request, signal)}, workspace);
  const found: OwnerLiveQuarantineRecord[] = [];
  const listed = new Map<string, string>();
  // A queue's head never changes without a new draft revision or size, except
  // for a Try again grant, which is never cached. The base is never needed.
  const readFacts = async (draft: OwnerYDocDraftDescriptor & {outboxId: string}): Promise<HeadFacts> => {
    const key = `${draft.revision}:${draft.pendingBytes}`, cached = heads?.get(draft.outboxId);
    listed.set(draft.outboxId, key);
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
        // The engine refusing one queue's head, as while an accepted update
        // waits on a missing dependency, leaves the other queues usable.
        const head = await readFacts({...draft, outboxId: draft.outboxId}).catch((error: unknown) => {
          if (!(error instanceof EngineRequestError && QUEUE_REFUSALS.has(error.wireError?.code ?? "")) || strict?.(draft.binding)) throw error;
          return error.message.slice(0, 128) || "unknown";
        });
        if (typeof head === "string") {
          found.push({objectId: draft.binding.objectId, path: draft.binding.currentPath, reason: head,
            outboxId: draft.outboxId, binding: draft.binding, headDeliveryId: null, recovery: "unreadable"});
          continue;
        }
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
    for (const id of heads?.keys() ?? []) if (!listed.has(id)) heads!.delete(id);
    // A queue is read whole only when a record may have come from it, and once per draft revision and size.
    const snapshotOf = async (outboxId: string) => {
      const cached = heads?.get(outboxId), current = cached?.key === listed.get(outboxId) ? cached : undefined;
      if (current?.snapshot !== undefined) return current.snapshot;
      const snapshot = recoverySnapshot(await outbox.readRecovery(outboxId));
      if (current) current.snapshot = snapshot;
      return snapshot;
    };
    // While the queue a record came from remains, its row speaks for both. A
    // later queue, even under the same binding and head, holding other edits
    // leaves the record its own row, and so does a record not read whole or
    // whose queue's head the engine refused to read.
    const queues = found.filter(row => row.recovery !== "unreadable");
    for (const release of options.unwritten ?? []) {
      const queue = release.binding === null || release.snapshot === null ? undefined
        : queues.find(row => row.objectId === release.objectId && row.headDeliveryId === release.headDeliveryId && sameBinding(row.binding, release.binding));
      if (queue?.outboxId && await snapshotOf(queue.outboxId) === release.snapshot) continue;
      found.push({objectId: release.objectId, path: release.path, reason: release.reason, outboxId: null,
        binding: release.binding, headDeliveryId: release.headDeliveryId, recovery: release.retry ? "not-written" : "cannot-write"});
    }
  } finally {outbox.dispose();}
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
