import type { StorageContext } from "./storage/context.js";
import { deriveLiveAuthorSnapshot, type TrustedLiveAccount } from "./storage/liveAuthorSnapshot.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { limitLiveDeclaredAgents, liveAuthorCheckpointAnticipated } from "./storage/liveAuthorWindow";
import type { ServiceActivationAccess } from "./storage/serviceActivationAccess";
import { OwnerYDocOutbox } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { refusalOutstanding, type OwnerKnownRefusal, type OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateHostApplicationAck, type LiveDocumentKey, type LiveUpdateHostApplicationAck, type LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import type { SyncRelayStorage, LiveHostConnectionCoordinate } from "./storage.js";
import type { LiveJournalValidation } from "./storage/types.js";
import { SERVICE_KEPT_EDITS_REASONS, type ServiceKeptEditsIdentity } from "./storage/serviceKeptEdits.js";
import { configRecord } from "./deviceLiveHostConfig.js";

export type LiveAdmissionValidation = LiveJournalValidation | {
  readonly kind: "retry";
  readonly reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};

export interface OwnerOutboxAdmission {
  readonly activation?: ServiceActivationAccess;
  trustedAccount(accountId: string): TrustedLiveAccount | undefined | Promise<TrustedLiveAccount | undefined>;
  readonly shares: ReadonlyMap<string,string>;
  readonly maxEntriesPerDrain: number;
  readonly maxBytesPerDrain: number;
  /** Outlives every pass and connection, so a refusal received once is recorded, not admitted again. */
  readonly refusals: OwnerKnownRefusals;
  /**
   * The workspace identity whose hosted store holds the queue, where it lives
   * on the service host, so its owner can find and recover a refused queue
   * there. A device's queue is on the owner's computer.
   */
  readonly keptOnServer?: ServiceKeptEditsIdentity;
  validate(input: {document: LiveDocumentKey; currentPath: string; checkpoint: Uint8Array; suffix: readonly Uint8Array[]; candidate: Uint8Array;
    retainStateUpdate?: boolean}, signal?: AbortSignal): LiveAdmissionValidation | Promise<LiveAdmissionValidation>;
}

export type CapacityLiveAdmissionValidator = OwnerOutboxAdmission["validate"] & {
  hasCapacity?(): boolean;
  /** Pooled validators wait without retaining a journal cut. */
  waitForCapacity?(signal?: AbortSignal): Promise<void>;
};

/**
 * The adoption this queue belongs to, as the relay recorded it from the host's
 * adoption ACK. A divergent adoption queues its local seed first, under
 * `owner-adoption:sha256([adoptionId, sequence, updateDigest])`. `applied`
 * releases the accepted-feed gate when the queue is empty, its head is later
 * work, or the host acknowledged applying the seed. A quarantined queue also
 * releases that gate while preserving its unapplied local work.
 */
export interface OwnerOutboxAdoption {
  readonly adoptionId: string;
  readonly sequence: number;
  applied(): void;
}

/** Runs within one authenticated device delivery and rechecks standing at every await. */
export async function drainOwnerOutbox(options: {
  storage: SyncRelayStorage; admission: OwnerOutboxAdmission; client: EngineClient;
  workspace: string; host: LiveHostConnectionCoordinate; registrationId: number;
  binding: LiveObjectBinding; adoption: OwnerOutboxAdoption; nextRequestId(): number; deadlineMs: number; signal?: AbortSignal;
  assertCurrent(): void;
  applyThrough(receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck | null>;
}): Promise<{admittedEntries: number; hasMore: boolean; retryReady?: boolean}> {
  const {storage,admission,client,registrationId,binding,host,signal,adoption} = options;
  const seedKey = (updateDigest: string) => `owner-adoption:${createHash("sha256")
    .update(JSON.stringify([adoption.adoptionId,adoption.sequence,updateDigest])).digest("hex")}`;
  for (const value of [admission.maxEntriesPerDrain,admission.maxBytesPerDrain]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid owner drain budget.");
  }
  const check = () => { signal?.throwIfAborted(); options.assertCurrent(); };
  const request = () => ({id: options.nextRequestId(),workspace: options.workspace,deadlineMs: options.deadlineMs});
  check();
  const readStatus = async () => {
    const available = await client.sendRequest({...request(),method: "liveApplication.ownerOutbox",params: {registrationId}},signal);
    check();
    const status = configRecord(available.result,["outboxId","pendingBytes","state","retryDeliveryId"]);
    if (typeof status.pendingBytes !== "number" || !Number.isSafeInteger(status.pendingBytes) || status.pendingBytes < 0) throw new Error("Invalid owner pending bytes.");
    if (status.retryDeliveryId !== null && (status.state !== "quarantined" || typeof status.retryDeliveryId !== "string")) throw new Error("Invalid owner outbox retry.");
    // Only the owner's Try again lets a quarantined queue reach admission, and only for its head.
    if (status.state === "quarantined") return {outboxId: status.outboxId, pendingBytes: status.pendingBytes, quarantined: status.retryDeliveryId === null};
    if (status.pendingBytes > 0 && ((status.state !== "active" && status.state !== "sealed") || typeof status.outboxId !== "string")) throw new Error("Invalid owner outbox state.");
    return {outboxId: status.outboxId, pendingBytes: status.pendingBytes};
  };
  const status = await readStatus(), outboxId = status.outboxId;
  const refusals = admission.refusals, held = JSON.stringify([host.mode,host.hostId,outboxId]);
  // The row of this queue in the attached store. A store of another identity can hold a queue with the same ID.
  const queue = admission.keptOnServer && typeof outboxId === "string" ? {workspaceId: binding.workspaceId, identity: admission.keptOnServer, outboxId} : undefined;
  // A queue that delivers again, as after an accepted Try again, is no longer
  // kept for its owner. Its status is read again under the hold, so a refusal
  // another pass is recording keeps its row.
  if (queue && status.quarantined === undefined && storage.readServiceKeptEdits(queue)) {
    if (!refusals.hold(held)) return {admittedEntries: 0, hasMore: true};
    try {
      const current = await readStatus();
      if (current.outboxId === outboxId && current.quarantined === undefined) storage.forgetServiceKeptEdits(queue);
    } finally {refusals.release(held);}
  }
  let receivedBytes = 0, admittedEntries = 0;
  const byteBudget = new Error("Owner drain byte budget exceeded.");
  const outbox = new OwnerYDocOutbox({sendRequest: async original => {
    check();
    const reading = original.method === "ydoc.ownerOutbox.readPending";
    if (!reading && original.method !== "ydoc.ownerOutbox.acknowledge") throw new Error("Unsupported owner outbox operation.");
    const params = original.params as Record<string,unknown>;
    if (params.outboxId !== outboxId) throw new Error("Owner outbox changed.");
    const response = await client.sendRequest({...request(),method: reading ? "liveApplication.readOwnerOutbox" : "liveApplication.acknowledgeOwnerOutbox",
      params: {registrationId,...(reading ? (params.cursor === undefined ? {} : {cursor: params.cursor as never}) : {receipts: params.receipts as never})}},signal);
    check();
    if (reading) {
      const result = response.result as Record<string,unknown>;
      if (typeof result.bytesBase64 === "string") receivedBytes += result.bytesBase64.length;
      if (receivedBytes > admission.maxBytesPerDrain) throw byteBudget;
    }
    return {...response,id: original.id};
  }},options.workspace);
  // The record of a refusal its owner can find, written before the engine's
  // quarantine so no crash leaves a quarantine without one.
  const keep = (outbox: string, refusal: {reason: string; deliveryId: string; key: string}) => {
    if (admission.keptOnServer) storage.recordServiceKeptEdits({identity: admission.keptOnServer, outboxId: outbox, binding, reason: refusal.reason,
      headDeliveryId: refusal.deliveryId, refusalKey: refusal.key, nowMs: Date.now()});
  };
  if (status.quarantined) {
    // With no Try again outstanding, no known refusal is left to record.
    const known = refusals.get(held);
    try {
      // A quarantine whose record was lost, or forgotten once its document left, is recorded from the engine's queue.
      if (queue && !storage.readServiceKeptEdits(queue)) {
        if (known) keep(queue.outboxId, known);
        else {
          const head = await outbox.readDeliveryHead(queue.outboxId, binding); check();
          if (head.entry && head.quarantineReason !== null && SERVICE_KEPT_EDITS_REASONS.includes(head.quarantineReason)) {
            keep(queue.outboxId, {reason: head.quarantineReason, deliveryId: head.entry.deliveryId, key: `quarantined:${head.entry.deliveryId}`});
          }
        }
      }
    } finally {outbox.dispose();}
    if (known) refusals.recorded(held, known);
    adoption.applied(); return {admittedEntries: 0, hasMore: false};
  }
  if (status.pendingBytes === 0) {adoption.applied(); return {admittedEntries: 0, hasMore: false};}
  if (typeof outboxId !== "string") throw new Error("Invalid owner outbox identity.");
  const quarantine = async (known: OwnerKnownRefusal) => {
    keep(outboxId, known);
    await client.sendRequest({...request(), method: "liveApplication.quarantineOwnerOutbox",
      params: {registrationId, reason: known.reason, deliveryId: known.deliveryId, refusalKey: known.key}}, signal);
    refusals.recorded(held, known);
    check();
  };
  // One attempt per outbox at a time, across passes and connections.
  if (!refusals.hold(held)) return {admittedEntries: 0, hasMore: true};
  try {
    for (let index = 0; index < admission.maxEntriesPerDrain; index++) {
      check();
      const pending = await outbox.readDeliveryHead(outboxId,binding); check();
      if (!isDeepStrictEqual(pending.binding,binding) || pending.baseUpdateDigest !== binding.lineageClaimId) throw new Error("Owner outbox binding changed.");
      const known = refusals.get(held);
      if (known) {
        // A refusal already received completes; it never reaches admission again.
        if (refusalOutstanding(pending, known)) {
          await quarantine(known);
          adoption.applied();
          return {admittedEntries, hasMore: true, retryReady: true};
        }
        refusals.recorded(held, known);
      }
      if (pending.state === "quarantined" && (!pending.entry || pending.entry.deliveryId !== pending.retryDeliveryId)) {adoption.applied(); return {admittedEntries, hasMore: false};}
      if (!pending.entry) {adoption.applied(); return {admittedEntries, hasMore: false};}
      const entry = pending.entry;
      // The seed is the queue's first entry, so a later head proves it applied.
      // Another adoption's key here means this queue is not the one recorded.
      const seed = entry.appendKey === seedKey(entry.updateDigest);
      if (!seed && entry.appendKey.startsWith("owner-adoption:")) throw new Error("Owner outbox holds another adoption's seed.");
      if (!seed) adoption.applied();
      const shareId = admission.shares.get(binding.workspaceId);
      const share = shareId ? storage.getShare(shareId) : null;
      if (!share || share.workspaceId !== binding.workspaceId) throw new Error("Owner share is unavailable.");
      const actor = {kind: "owner" as const,userId: share.granterUserId,shareId: share.shareId};
      const document = {workspaceId: binding.workspaceId,mainVersionId: binding.mainVersionId,objectId: binding.objectId,lineageClaimId: binding.lineageClaimId};
      const current = storage.resolveCurrentLiveDocumentBinding({document,actor}, admission.activation);
      if (current.kind !== "current" || !isDeepStrictEqual(current.host,host) || !isDeepStrictEqual(current.binding,binding)) throw new Error("Owner standing changed.");
      const cut = storage.readLiveUpdateJournalCut({document});
      if (cut.kind !== "cut") throw new Error("Owner journal is unavailable.");
      const declared = entry.agentDeclaration;
      const trustedAccount = await admission.trustedAccount(current.authority.principalId);
      check();
      if ((entry.personEdit || declared) && !trustedAccount) return {admittedEntries, hasMore: true};
      if (trustedAccount && trustedAccount.accountId !== current.authority.principalId) throw new Error("Owner account changed.");
      const authorContext = entry.personEdit || declared ? {kind: "account" as const, accountId: trustedAccount!.accountId,
        ...(declared ? {agent: {agentId: declared.agentId, ...(declared.onBehalfOf !== null ? {onBehalfOf: declared.onBehalfOf} : {}), depth: declared.depth}} : {})} : undefined;
      const validation = await admission.validate({document,currentPath: binding.currentPath,checkpoint: cut.cut.checkpoint.bytes,
        suffix: cut.cut.suffix.map(row => row.bytes),candidate: entry.update,
        retainStateUpdate: liveAuthorCheckpointAnticipated(cut.cut.suffix.map(row => row.metadata), []) || liveAuthorCheckpointAnticipated(cut.cut.suffix.map(row => row.metadata),
          limitLiveDeclaredAgents(cut.cut.suffix.map(row => row.metadata), current.authority,
            deriveLiveAuthorSnapshot(storage as StorageContext, current.authority, authorContext, trustedAccount)))}, signal);
      check();
      if (validation.kind === "retry") {
        await validation.waitForCapacity(signal); check();
        return {admittedEntries, hasMore: true, retryReady: true};
      }
      const committed = storage.commitLiveUpdateJournal({host,actor,expectedAuthority: current.authority,
        trustedAccount,
        metadata: {deliveryId: entry.deliveryId,updateDigest: entry.updateDigest,binding,...(authorContext ? {authorContext} : {})},
        cutToken: cut.cut,validation,updateBytes: entry.update,receivedAtMs: Date.now()}, admission.activation);
      if (committed.result.kind === "retry") return {admittedEntries, hasMore: true, retryReady: true};
      if (committed.result.kind !== "accepted") {
        // Final refusals of this candidate freeze its whole queue. Contention returned retry above;
        // validator integration and admitted-cut failures threw in storage.
        if (["provenance-refused", "delivery-conflict", "capacity-refused", "invalid-update"].includes(committed.result.reason)) {
          await quarantine(refusals.receive(held, {deliveryId: entry.deliveryId, reason: committed.result.reason}));
          adoption.applied();
          return {admittedEntries, hasMore: false};
        }
        throw new Error("Owner update admission refused.");
      }
      const receipt = committed.result.receipt;
      const applied = await options.applyThrough(receipt); check();
      if (applied === null) return {admittedEntries, hasMore: true};
      const ack = parseLiveUpdateHostApplicationAck(applied);
      if (ack.deliveryId !== receipt.deliveryId || ack.updateDigest !== receipt.updateDigest ||
        ack.journalCursor !== receipt.journalCursor || ack.acceptingHostEpoch !== receipt.acceptingHostEpoch) {
        throw new Error("Native application ACK identity changed.");
      }
      if (seed) adoption.applied();
      await outbox.acknowledge(outboxId,[committed.result.receipt]); check();
      admittedEntries++;
    }
    const remaining = await readStatus();
    if (remaining.outboxId !== outboxId) throw new Error("Owner outbox changed.");
    return {admittedEntries, hasMore: remaining.pendingBytes > 0};
  } catch (error) {
    if (error === byteBudget && admittedEntries > 0) {
      const remaining = await readStatus();
      if (remaining.outboxId !== outboxId) throw new Error("Owner outbox changed.");
      return {admittedEntries, hasMore: remaining.pendingBytes > 0};
    }
    throw error;
  } finally { outbox.dispose(); refusals.release(held); }
}
