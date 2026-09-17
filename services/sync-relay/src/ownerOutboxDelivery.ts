import { isDeepStrictEqual } from "node:util";
import type { ServiceActivationAccess } from "./storage/serviceActivationAccess";
import { OwnerYDocOutbox } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateHostApplicationAck, type LiveDocumentKey, type LiveUpdateHostApplicationAck, type LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import type { SyncRelayStorage, LiveHostConnectionCoordinate } from "./storage.js";
import type { LiveJournalValidation } from "./storage/types.js";
import { configRecord } from "./deviceLiveHostConfig.js";

export type LiveAdmissionValidation = LiveJournalValidation | {
  readonly kind: "retry";
  readonly reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};

export interface OwnerOutboxAdmission {
  readonly activation?: ServiceActivationAccess;
  readonly shares: ReadonlyMap<string,string>;
  readonly maxEntriesPerDrain: number;
  readonly maxBytesPerDrain: number;
  validate(input: {document: LiveDocumentKey; currentPath: string; checkpoint: Uint8Array; suffix: readonly Uint8Array[]; candidate: Uint8Array}, signal?: AbortSignal): LiveAdmissionValidation | Promise<LiveAdmissionValidation>;
}

/** Runs within one authenticated device delivery and rechecks standing at every await. */
export async function drainOwnerOutbox(options: {
  storage: SyncRelayStorage; admission: OwnerOutboxAdmission; client: EngineClient;
  workspace: string; host: LiveHostConnectionCoordinate; registrationId: number;
  binding: LiveObjectBinding; nextRequestId(): number; deadlineMs: number; signal?: AbortSignal;
  assertCurrent(): void;
  applyThrough(receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck | null>;
}): Promise<{admittedEntries: number; hasMore: boolean; retryReady?: boolean}> {
  const {storage,admission,client,registrationId,binding,host,signal} = options;
  for (const value of [admission.maxEntriesPerDrain,admission.maxBytesPerDrain]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid owner drain budget.");
  }
  const check = () => { signal?.throwIfAborted(); options.assertCurrent(); };
  const request = () => ({id: options.nextRequestId(),workspace: options.workspace,deadlineMs: options.deadlineMs});
  check();
  const readStatus = async () => {
    const available = await client.sendRequest({...request(),method: "liveApplication.ownerOutbox",params: {registrationId}},signal);
    check();
    const status = configRecord(available.result,["outboxId","pendingBytes","state"]);
    if (typeof status.pendingBytes !== "number" || !Number.isSafeInteger(status.pendingBytes) || status.pendingBytes < 0) throw new Error("Invalid owner pending bytes.");
    if (status.state === "quarantined") throw new Error(`Owner outbox is ${status.state}; explicit recovery is required.`);
    if (status.pendingBytes > 0 && ((status.state !== "active" && status.state !== "sealed") || typeof status.outboxId !== "string")) throw new Error("Invalid owner outbox state.");
    return {outboxId: status.outboxId, pendingBytes: status.pendingBytes};
  };
  const status = await readStatus(), outboxId = status.outboxId;
  if (status.pendingBytes === 0) return {admittedEntries: 0, hasMore: false};
  if (typeof outboxId !== "string") throw new Error("Invalid owner outbox identity.");
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
  try {
    for (let index = 0; index < admission.maxEntriesPerDrain; index++) {
      check();
      const pending = await outbox.readDeliveryHead(outboxId,binding); check();
      if (!isDeepStrictEqual(pending.binding,binding) || pending.baseUpdateDigest !== binding.lineageClaimId) throw new Error("Owner outbox binding changed.");
      if (pending.state === "quarantined") throw new Error("Owner outbox requires explicit recovery.");
      if (!pending.entry) return {admittedEntries, hasMore: false};
      const entry = pending.entry;
      const shareId = admission.shares.get(binding.workspaceId);
      const share = shareId ? storage.getShare(shareId) : null;
      if (!share || share.workspaceId !== binding.workspaceId) throw new Error("Owner share is unavailable.");
      const actor = {kind: "owner" as const,userId: share.granterUserId,shareId: share.shareId};
      const document = {workspaceId: binding.workspaceId,mainVersionId: binding.mainVersionId,objectId: binding.objectId,lineageClaimId: binding.lineageClaimId};
      const current = storage.resolveCurrentLiveDocumentBinding({document,actor}, admission.activation);
      if (current.kind !== "current" || !isDeepStrictEqual(current.host,host) || !isDeepStrictEqual(current.binding,binding)) throw new Error("Owner standing changed.");
      const cut = storage.readLiveUpdateJournalCut({document});
      if (cut.kind !== "cut") throw new Error("Owner journal is unavailable.");
      const validation = await admission.validate({document,currentPath: binding.currentPath,checkpoint: cut.cut.checkpoint.bytes,
        suffix: cut.cut.suffix.map(row => row.bytes),candidate: entry.update}, signal);
      check();
      if (validation.kind === "retry") {
        await validation.waitForCapacity(signal); check();
        return {admittedEntries, hasMore: true, retryReady: true};
      }
      const committed = storage.commitLiveUpdateJournal({host,actor,expectedAuthority: current.authority,
        metadata: {deliveryId: entry.deliveryId,updateDigest: entry.updateDigest,binding},cutToken: cut.cut,validation,updateBytes: entry.update,receivedAtMs: Date.now()}, admission.activation);
      if (committed.result.kind !== "accepted") throw new Error("Owner update admission refused.");
      const receipt = committed.result.receipt;
      const applied = await options.applyThrough(receipt); check();
      if (applied === null) return {admittedEntries, hasMore: true};
      const ack = parseLiveUpdateHostApplicationAck(applied);
      if (ack.deliveryId !== receipt.deliveryId || ack.updateDigest !== receipt.updateDigest ||
        ack.journalCursor !== receipt.journalCursor || ack.acceptingHostEpoch !== receipt.acceptingHostEpoch) {
        throw new Error("Native application ACK identity changed.");
      }
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
  } finally { outbox.dispose(); }
}
