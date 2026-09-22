import { createHash } from "node:crypto";
import { createCheckpointStorage, type CheckpointStage, type CheckpointStageAllocation, type ReclaimCheckpointStagesInput } from "./checkpoint-storage.js";
export type { CheckpointStage, CheckpointStageAllocation } from "./checkpoint-storage.js";

export interface JournalDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...parameters: unknown[]): Record<string, unknown> | undefined;
    all(...parameters: unknown[]): Array<Record<string, unknown>>;
    run(...parameters: unknown[]): { changes: number | bigint };
  };
}
export interface DatasetScope { workspaceId: string; datasetId: string }
export interface DatasetCursor extends DatasetScope {
  hostEpoch: string;
  approvedRevisionHash: string;
  revision: number;
  digest: string;
}
export interface DatasetHead {
  cursor: DatasetCursor;
  active: boolean;
  source: string;
  schemaSql: string;
  definitionJson: string;
  capacityBytes: number;
}
export interface JournalEvent {
  cursor: DatasetCursor;
  previousDigest: string;
  proposalId: string;
  operation: string;
  callerKey: string;
  idempotencyKey: string;
  payloadSha256: string;
  resultJson: string;
  changeset: Uint8Array;
  changesetSha256: string;
  attachedFileIds: readonly string[];
  recordedAtMs: number;
}
export interface JournalReceipt { revision: number; payloadSha256: string; resultJson: string }
/** Disposable replay acceleration at an already committed cursor. Never part of export history. */
export interface JournalMaterialization { cursor: DatasetCursor; checkpointId: string; byteLength: number; sha256: string }
export interface MaterializationAllocation { bytes: number; stagedCreditBytes: number; releasedBytes: number }
export class JournalError extends Error {
  constructor(readonly code: "conflict" | "invalid" | "inactive" | "corrupt", message: string) {
    super(message); this.name = "JournalError";
  }
}
type Authorize = () => unknown;
export interface JournalOptions {
  db: JournalDb;
  /** Must run the synchronous callback inside the host's authoritative transaction. */
  transaction: <T>(run: () => T) => T;
  nowMs?: () => number;
  maxEventBytes?: number;
  maxCheckpointBytes?: number;
  maxPageBytes?: number;
}
export interface InitializeDatasetInput {
  scope: DatasetScope;
  hostEpoch: string;
  approvedRevisionHash: string;
  source: string;
  schemaSql: string;
  definitionJson: string;
  checkpoint: Uint8Array | CheckpointStage;
  capacityBytes?: number;
  authorize: Authorize;
  account?: (allocation: Readonly<{ bytes: number; capacityBytes: number; stagedCreditBytes: number }>) => unknown;
}
export interface CommitOperationInput {
  expected: DatasetCursor;
  proposalId: string;
  operation: string;
  callerKey: string;
  idempotencyKey: string;
  payloadSha256: string;
  resultJson: string;
  changeset: Uint8Array;
  changesetSha256: string;
  attachedFileIds: readonly string[];
  recordedAtMs?: number;
  authorize: Authorize;
  /** The host validates and accounts attachments here, using the same transaction. */
  accountAndAttach?: (allocation: Readonly<{ revision: number; bytes: number; attachedFileIds: readonly string[] }>) => unknown;
}
export interface TransitionCheckpointInput extends Omit<InitializeDatasetInput,"scope"|"account"> {
  expected: DatasetCursor;
  /** Trusted, schema-validated checkpoint without a worker's private cursor marker. */
  checkpoint: Uint8Array | CheckpointStage;
  account?: (allocation: Readonly<{bytes: number; capacityBytes: number; capacityDeltaBytes: number; cursor: DatasetCursor; stagedCreditBytes: number}>) => unknown;
}
export type JournalExportRecord =
  | ({ kind: "event"; byteLength: number } & Omit<JournalEvent, "changeset">)
  | { kind: "checkpoint"; cursor: DatasetCursor; previous: DatasetCursor | null; source: string; schemaSql: string;
      definitionJson: string; capacityBytes: number; byteLength: number; sha256: string };
export interface JournalExportCapture<T> { cursor: DatasetCursor; checkpoint: Extract<JournalExportRecord, { kind: "checkpoint" }>; captured: T }
export interface DatasetJournal {
  materialization(input: { scope: DatasetScope; authorize: Authorize }): JournalMaterialization | null;
  materializationBlob(input: { scope: DatasetScope; cache: JournalMaterialization; offset: number; length?: number; authorize: Authorize }): Uint8Array | null;
  cacheMaterialization(input: { expected: DatasetCursor; checkpoint: CheckpointStage; authorize: Authorize; account?: (allocation: Readonly<MaterializationAllocation>) => unknown }): JournalMaterialization;
  /** Reject admission for a permanently deleted dataset, including after restart. */
  assertNotDeleted(scope: DatasetScope, authorize: Authorize): void;
  /** The cleanup callback runs inside the deletion transaction, before private data is removed. */
  destroy(input: { expected: DatasetCursor; authorize: Authorize; cleanup?: () => unknown }): void;
  stageCheckpoint(input: { scope: DatasetScope; expectedBytes: number; sha256: string; authorize: Authorize; account?: (allocation: Readonly<CheckpointStageAllocation>) => unknown }): CheckpointStage;
  appendCheckpointChunk(input: { stage: CheckpointStage; index: number; bytes: Uint8Array; authorize: Authorize }): void;
  sealCheckpoint(input: { stage: CheckpointStage; authorize: Authorize }): CheckpointStage;
  discardCheckpoint(input: { stage: CheckpointStage; authorize: Authorize; account?: (allocation: Readonly<CheckpointStageAllocation>) => unknown }): void;
  checkpointStages(input: { workspaceId: string; after?: string; limit?: number; authorize: Authorize }): CheckpointStage[];
  /** Startup only, while the host exclusively owns the store and has admitted no operations. */
  reclaimCheckpointStages(input: ReclaimCheckpointStagesInput): { reclaimed: number; after: string | undefined };
  captureExport<T>(input: { scope: DatasetScope; authorize: Authorize; capture(cursor: DatasetCursor): T }): JournalExportCapture<T>;
  exportPage(input: { scope: DatasetScope; through: DatasetCursor; afterRevision: number; limit?: number; authorize: Authorize }): JournalExportRecord[];
  exportBlob(input: { scope: DatasetScope; record: JournalExportRecord; offset: number; length?: number; authorize: Authorize }): Uint8Array;
  initialize(input: InitializeDatasetInput): DatasetCursor;
  transitionCheckpoint(input: TransitionCheckpointInput): DatasetCursor;
  /** Activate a fenced head on a fresh host epoch without discarding its retry lineage. */
  claimInactiveCheckpoint(input: TransitionCheckpointInput): DatasetCursor;
  head(scope: DatasetScope, authorize: Authorize): DatasetHead;
  receipt(input: { scope: DatasetScope; callerKey: string; idempotencyKey: string; payloadSha256: string; authorize: Authorize }): JournalReceipt | null;
  commitOperation(input: CommitOperationInput):
    | { kind: "committed"; receipt: JournalReceipt; event: JournalEvent }
    | { kind: "replayed"; receipt: JournalReceipt };
  events(input: { scope: DatasetScope; after: DatasetCursor; limit?: number; byteLimit?: number; authorize: Authorize }): { events: JournalEvent[]; head: DatasetCursor };
  checkpoint(input: { scope: DatasetScope; revision?: number; authorize: Authorize }): { cursor: DatasetCursor; bytes: Uint8Array; sha256: string; source: string; schemaSql: string; definitionJson: string };
  /** Permanently stop writes from this host epoch. Recovery reads remain authorized separately. */
  fence(input: { expected: DatasetCursor; authorize: Authorize }): DatasetCursor;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const invalid = (message: string): never => { throw new JournalError("invalid", message); };
const corrupt = (message: string): never => { throw new JournalError("corrupt", message); };
function text(value: string, max = 4096): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > max) invalid("Invalid journal text.");
  return value;
}
function digest(value: string): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid("Invalid journal digest."); return value; }
function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid("Invalid journal number."); return value;
}
function copyBytes(value: Uint8Array, max: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > max) invalid("Journal bytes exceed the limit.");
  return new Uint8Array(value);
}
function scope(value: DatasetScope): DatasetScope { return Object.freeze({workspaceId:text(value.workspaceId),datasetId:text(value.datasetId)}); }
function cursor(value: DatasetCursor): DatasetCursor {
  return Object.freeze({...scope(value),hostEpoch:text(value.hostEpoch,256),approvedRevisionHash:digest(value.approvedRevisionHash),revision:integer(value.revision),digest:digest(value.digest)});
}
function sameIdentity(a: DatasetCursor, b: DatasetCursor): boolean {
  return a.workspaceId===b.workspaceId && a.datasetId===b.datasetId && a.hostEpoch===b.hostEpoch && a.approvedRevisionHash===b.approvedRevisionHash;
}
function sameCursor(a: DatasetCursor, b: DatasetCursor): boolean { return sameIdentity(a,b) && a.revision===b.revision && a.digest===b.digest; }
function synchronous(fn: Function): void {
  if (typeof fn !== "function" || fn.constructor.name === "AsyncFunction") invalid("Journal callbacks must be synchronous.");
}
function callback<T>(fn: () => T): T {
  synchronous(fn);
  const result=fn();
  if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) invalid("Journal callbacks must be synchronous.");
  return result;
}
function fileIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length>64 || value.some(id=>typeof id!=="string"||!/^[A-Za-z0-9_-]{16,128}$/.test(id)) || new Set(value).size!==value.length) invalid("Invalid attachment references.");
  return Object.freeze([...value].sort());
}
function eventHash(event: Omit<JournalEvent,"cursor"|"changeset"> & {cursor: Omit<DatasetCursor,"digest">}): string {
  const c=event.cursor;
  return hash(JSON.stringify(["dohc-dataset-event-v1",c.workspaceId,c.datasetId,c.hostEpoch,c.approvedRevisionHash,c.revision,event.previousDigest,
    event.proposalId,event.operation,event.callerKey,event.idempotencyKey,event.payloadSha256,hash(event.resultJson),event.changesetSha256,event.attachedFileIds,event.recordedAtMs]));
}
function checkpointHash(c: Omit<DatasetCursor,"digest">, checkpointSha256: string, source: string, schemaSql: string, definitionJson: string,
  capacityBytes: number, previous: DatasetCursor | null): string {
  return hash(JSON.stringify(["dohc-dataset-checkpoint-v1",c.workspaceId,c.datasetId,c.hostEpoch,c.approvedRevisionHash,c.revision,
    previous?[previous.workspaceId,previous.datasetId,previous.hostEpoch,previous.approvedRevisionHash,previous.revision,previous.digest]:null,
    checkpointSha256,hash(source),hash(schemaSql),hash(definitionJson),capacityBytes]));
}
function resultText(value: string): string {
  if (typeof value!=="string" || Buffer.byteLength(value)>256*1024) invalid("Operation result exceeds the limit.");
  try { JSON.parse(value); } catch { invalid("Operation result must be JSON."); } return value;
}
type StoredHead = DatasetHead & {checkpointId: string; checkpointSha256: string; checkpointCursor: DatasetCursor; checkpointPrevious: DatasetCursor | null};

/** The host owns authorization and durability. This module never accepts caller-supplied authority. */
export function createDatasetJournal(options: JournalOptions): DatasetJournal {
  const {db,transaction}=options, now=options.nowMs ?? Date.now;
  synchronous(transaction);
  const maxEvent=integer(options.maxEventBytes ?? 16*1024*1024,1024,128*1024*1024);
  const maxCheckpoint=integer(options.maxCheckpointBytes ?? 128*1024*1024,4096,1024*1024*1024);
  const maxPage=integer(options.maxPageBytes ?? 32*1024*1024,maxEvent,256*1024*1024);
  const tx=<T>(run:()=>T):T=>callback(()=>transaction(()=>callback(run)));
  const checkpoints = createCheckpointStorage(db, transaction, maxCheckpoint);
  tx(()=>db.exec(`
    CREATE TABLE IF NOT EXISTS dohc_dataset_deletions (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,host_epoch TEXT NOT NULL,approved_revision_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=0),digest TEXT NOT NULL,deleted_at_ms INTEGER NOT NULL CHECK(deleted_at_ms>=0),
      PRIMARY KEY(workspace_id,dataset_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_journals (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,host_epoch TEXT NOT NULL,approved_revision_hash TEXT NOT NULL,
      source TEXT NOT NULL,schema_sql TEXT NOT NULL,definition_json TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),digest TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes>=4096),
      checkpoint_id TEXT NOT NULL,checkpoint_sha256 TEXT NOT NULL,checkpoint_revision INTEGER NOT NULL CHECK(checkpoint_revision>=0),
      checkpoint_digest TEXT NOT NULL,checkpoint_previous_json TEXT,
      PRIMARY KEY(workspace_id,dataset_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_events (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),previous_digest TEXT NOT NULL,digest TEXT NOT NULL,
      host_epoch TEXT NOT NULL,approved_revision_hash TEXT NOT NULL,proposal_id TEXT NOT NULL,operation TEXT NOT NULL,
      caller_key TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_sha256 TEXT NOT NULL,result_json TEXT NOT NULL,
      changeset BLOB NOT NULL,changeset_sha256 TEXT NOT NULL,attached_file_ids TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),PRIMARY KEY(workspace_id,dataset_id,revision),
      UNIQUE(workspace_id,dataset_id,caller_key,idempotency_key)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_receipts (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,caller_key TEXT NOT NULL,idempotency_key TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),result_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,caller_key,idempotency_key)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_checkpoint_history (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),
      cursor_json TEXT NOT NULL,previous_json TEXT,source TEXT NOT NULL,schema_sql TEXT NOT NULL,definition_json TEXT NOT NULL,
      capacity_bytes INTEGER NOT NULL,checkpoint_id TEXT NOT NULL,checkpoint_sha256 TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,revision)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_materializations (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,cursor_json TEXT NOT NULL,checkpoint_id TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length>=0),sha256 TEXT NOT NULL,storage_bytes INTEGER NOT NULL CHECK(storage_bytes>=0),
      PRIMARY KEY(workspace_id,dataset_id)) STRICT;`));
  function notDeleted(key: DatasetScope): void {
    if(db.prepare("SELECT 1 FROM dohc_dataset_deletions WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId))
      throw new JournalError("inactive","Dataset was permanently deleted.");
  }
  function storedHead(key: DatasetScope): StoredHead {
    notDeleted(key);
    const row=db.prepare(`SELECT workspace_id,dataset_id,host_epoch,approved_revision_hash,source,schema_sql,definition_json,revision,digest,active,
      capacity_bytes,checkpoint_id,checkpoint_sha256,checkpoint_revision,checkpoint_digest,checkpoint_previous_json FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?`).get(key.workspaceId,key.datasetId);
    if(!row) throw new JournalError("conflict","Dataset is not initialized.");
    try {
      const head={cursor:cursor({...key,hostEpoch:String(row.host_epoch),approvedRevisionHash:String(row.approved_revision_hash),revision:Number(row.revision),digest:String(row.digest)}),
        active:row.active===1,source:text(String(row.source),256*1024),schemaSql:text(String(row.schema_sql),256*1024),definitionJson:resultText(String(row.definition_json)),capacityBytes:integer(Number(row.capacity_bytes),4096),
        checkpointId:text(String(row.checkpoint_id),256),checkpointSha256:digest(String(row.checkpoint_sha256)),
        checkpointCursor:cursor({...key,hostEpoch:String(row.host_epoch),approvedRevisionHash:String(row.approved_revision_hash),revision:Number(row.checkpoint_revision),digest:String(row.checkpoint_digest)}),
        checkpointPrevious:row.checkpoint_previous_json===null?null:cursor(JSON.parse(String(row.checkpoint_previous_json)))};
      const previous=head.checkpointPrevious,current=head.checkpointCursor;
      if(current.revision>head.cursor.revision || (previous ? previous.workspaceId!==key.workspaceId||previous.datasetId!==key.datasetId||previous.revision+1!==current.revision : current.revision!==0) ||
        checkpointHash(current,head.checkpointSha256,head.source,head.schemaSql,head.definitionJson,head.capacityBytes,previous)!==current.digest) return corrupt("Dataset definition integrity check failed.");
      return head;
    } catch { return corrupt("Dataset header is damaged."); }
  }
  function active(head: StoredHead) { if(!head.active)throw new JournalError("inactive","Dataset host is fenced."); }
  function readEvent(key: DatasetScope, revision: number): JournalEvent {
    const size=db.prepare(`SELECT storage_bytes,length(changeset)+length(CAST(result_json AS BLOB))+length(CAST(attached_file_ids AS BLOB))+
      length(CAST(caller_key AS BLOB))+length(CAST(proposal_id AS BLOB))+length(CAST(operation AS BLOB))+length(CAST(idempotency_key AS BLOB)) AS actual_bytes
      FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND revision=?`).get(key.workspaceId,key.datasetId,revision);
    if(!size || !Number.isSafeInteger(size.storage_bytes)||Number(size.storage_bytes)>maxEvent || Number(size.actual_bytes)>Number(size.storage_bytes)) return corrupt("Journal event size is damaged.");
    const row=db.prepare("SELECT * FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND revision=?").get(key.workspaceId,key.datasetId,revision);
    if(!row) return corrupt("Journal event is missing.");
    try {
      const event: JournalEvent={cursor:cursor({...key,hostEpoch:String(row.host_epoch),approvedRevisionHash:String(row.approved_revision_hash),revision:Number(row.revision),digest:String(row.digest)}),
        previousDigest:digest(String(row.previous_digest)),proposalId:text(String(row.proposal_id),256),operation:text(String(row.operation),256),callerKey:text(String(row.caller_key),1024),
        idempotencyKey:text(String(row.idempotency_key),128),payloadSha256:digest(String(row.payload_sha256)),resultJson:resultText(String(row.result_json)),
        changeset:copyBytes(row.changeset as Uint8Array,maxEvent),changesetSha256:digest(String(row.changeset_sha256)),attachedFileIds:fileIds(JSON.parse(String(row.attached_file_ids))),recordedAtMs:integer(Number(row.recorded_at_ms))};
      if(hash(event.changeset)!==event.changesetSha256 || eventHash(event)!==event.cursor.digest) return corrupt("Journal event digest mismatch.");
      return event;
    } catch { return corrupt("Journal event is damaged."); }
  }
  function readReceipt(key: DatasetScope, callerKey: string, idempotencyKey: string, payloadSha256: string): JournalReceipt | null {
    const row=db.prepare("SELECT payload_sha256,revision,result_json FROM dohc_dataset_receipts WHERE workspace_id=? AND dataset_id=? AND caller_key=? AND idempotency_key=?")
      .get(key.workspaceId,key.datasetId,callerKey,idempotencyKey);
    if(!row)return null;
    const event=readEvent(key,Number(row.revision));
    if(event.callerKey!==callerKey || event.idempotencyKey!==idempotencyKey || event.payloadSha256!==row.payload_sha256 || event.resultJson!==row.result_json) return corrupt("Retry receipt differs from its journal event.");
    if(row.payload_sha256!==payloadSha256)throw new JournalError("conflict","Idempotency key has another payload.");
    return {revision:event.cursor.revision,payloadSha256:event.payloadSha256,resultJson:event.resultJson};
  }
  function assertCursor(wanted: DatasetCursor, actual: DatasetCursor) {
    if(!sameCursor(wanted,actual))throw new JournalError("conflict","Dataset cursor changed.");
  }
  function checkpointBytes(key: DatasetScope, checkpointId: string, sha256: string, authorize: Authorize): Uint8Array {
    const manifest=checkpoints.info(key,checkpointId),bytes=new Uint8Array(manifest.expectedBytes),hash=createHash("sha256");
    for(let offset=0;offset<bytes.byteLength;offset+=manifest.chunkSize) {
      callback(authorize);const chunk=checkpoints.read(key,checkpointId,offset,manifest.chunkSize);bytes.set(chunk,offset);hash.update(chunk);
    }
    if(manifest.sha256!==sha256||hash.digest("hex")!==sha256)return corrupt("Checkpoint integrity check failed.");
    return bytes;
  }
  function exportRecord(key: DatasetScope, revision: number): JournalExportRecord {
    const h = storedHead(key);
    const checkpoint = revision === h.checkpointCursor.revision
      ? { cursor_json: JSON.stringify(h.checkpointCursor), previous_json: h.checkpointPrevious === null ? null : JSON.stringify(h.checkpointPrevious),
          source: h.source, schema_sql: h.schemaSql, definition_json: h.definitionJson, capacity_bytes: h.capacityBytes, checkpoint_sha256: h.checkpointSha256,
          checkpoint_id: h.checkpointId }
      : db.prepare(`SELECT cursor_json,previous_json,source,schema_sql,definition_json,capacity_bytes,checkpoint_sha256,checkpoint_id
          FROM dohc_dataset_checkpoint_history WHERE workspace_id=? AND dataset_id=? AND revision=?`).get(key.workspaceId,key.datasetId,revision);
    if (checkpoint) {
      const current=cursor(JSON.parse(String(checkpoint.cursor_json))), previous=checkpoint.previous_json===null?null:cursor(JSON.parse(String(checkpoint.previous_json)));
      const source=text(String(checkpoint.source),256*1024),schemaSql=text(String(checkpoint.schema_sql),256*1024),definitionJson=resultText(String(checkpoint.definition_json));
      const manifest=checkpoints.info(key,String(checkpoint.checkpoint_id));
      const capacityBytes=integer(Number(checkpoint.capacity_bytes),4096),byteLength=integer(manifest.expectedBytes,0,maxCheckpoint),sha256=digest(String(checkpoint.checkpoint_sha256));
      if(manifest.sha256!==sha256)return corrupt("Export checkpoint manifest is damaged.");
      if(current.workspaceId!==key.workspaceId||current.datasetId!==key.datasetId||current.revision!==revision||
        (previous ? previous.revision+1!==revision||previous.workspaceId!==key.workspaceId||previous.datasetId!==key.datasetId : revision!==0)||
        checkpointHash(current,sha256,source,schemaSql,definitionJson,capacityBytes,previous)!==current.digest) return corrupt("Export checkpoint metadata is damaged.");
      return {kind:"checkpoint",cursor:current,previous,source,schemaSql,definitionJson,capacityBytes,byteLength,sha256};
    }
    const row=db.prepare(`SELECT workspace_id,dataset_id,revision,previous_digest,digest,host_epoch,approved_revision_hash,proposal_id,operation,
        caller_key,idempotency_key,payload_sha256,result_json,changeset_sha256,attached_file_ids,recorded_at_ms,length(changeset) AS byte_length
        FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND revision=?`).get(key.workspaceId,key.datasetId,revision);
    if(!row)return corrupt("Export history is incomplete.");
    const event:Omit<JournalEvent,"changeset">={cursor:cursor({...key,hostEpoch:String(row.host_epoch),approvedRevisionHash:String(row.approved_revision_hash),revision,digest:String(row.digest)}),
      previousDigest:digest(String(row.previous_digest)),proposalId:text(String(row.proposal_id),256),operation:text(String(row.operation),256),callerKey:text(String(row.caller_key),1024),
      idempotencyKey:text(String(row.idempotency_key),128),payloadSha256:digest(String(row.payload_sha256)),resultJson:resultText(String(row.result_json)),
      changesetSha256:digest(String(row.changeset_sha256)),attachedFileIds:fileIds(JSON.parse(String(row.attached_file_ids))),recordedAtMs:integer(Number(row.recorded_at_ms))};
    if(eventHash(event)!==event.cursor.digest)return corrupt("Export event metadata is damaged.");
    return {...event,kind:"event",byteLength:integer(Number(row.byte_length),0,maxEvent)};
  }
  function materializationRow(key: DatasetScope) {
    return db.prepare("SELECT * FROM dohc_dataset_materializations WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
  }
  function materializationRelease(key: DatasetScope): number {
    const row=materializationRow(key);
    return row ? integer(Number(row.storage_bytes),0,maxCheckpoint+1024*1024) : 0;
  }
  function removeMaterialization(key: DatasetScope) {
    const row=materializationRow(key);
    if(!row)return;
    checkpoints.removeMaterialization(key,String(row.checkpoint_id));
    db.prepare("DELETE FROM dohc_dataset_materializations WHERE workspace_id=? AND dataset_id=?").run(key.workspaceId,key.datasetId);
  }
  function readMaterialization(key: DatasetScope, h: StoredHead): JournalMaterialization | null {
    const row=materializationRow(key);
    if(!row)return null;
    // Cache damage is recoverable. Authorization and authority checks happen outside this fallback.
    try {
      const current=cursor(JSON.parse(String(row.cursor_json))),checkpointId=text(String(row.checkpoint_id),256);
      if(!sameIdentity(current,h.cursor)||current.revision<h.checkpointCursor.revision||current.revision>h.cursor.revision)return null;
      const canonical=current.revision===h.checkpointCursor.revision?h.checkpointCursor:exportRecord(key,current.revision).cursor;
      if(!sameCursor(current,canonical))return null;
      const manifest=checkpoints.info(key,checkpointId),byteLength=integer(Number(row.byte_length),0,h.capacityBytes),sha256=digest(String(row.sha256));
      if(manifest.expectedBytes!==byteLength||manifest.sha256!==sha256)return null;
      return {cursor:current,checkpointId,byteLength,sha256};
    } catch { return null; }
  }
  return {
    materialization(input) {
      const key=scope(input.scope);
      return tx(()=>{callback(input.authorize);const h=storedHead(key);active(h);return readMaterialization(key,h);});
    },
    materializationBlob(input) {
      const key=scope(input.scope),cache=structuredClone(input.cache),offset=integer(input.offset),length=integer(input.length??1024*1024,1,1024*1024);
      return tx(()=>{
        callback(input.authorize);const h=storedHead(key);active(h);
        const current=readMaterialization(key,h);
        if(!current||!sameCursor(cache.cursor,current.cursor)||cache.checkpointId!==current.checkpointId||cache.byteLength!==current.byteLength||cache.sha256!==current.sha256)return null;
        if(offset>current.byteLength)invalid("Invalid materialization blob range.");
        try {return checkpoints.read(key,current.checkpointId,offset,length);} catch {return null;}
      });
    },
    cacheMaterialization(input) {
      const expected=cursor(input.expected),checkpoint=structuredClone(input.checkpoint),authorize=input.authorize,account=input.account;
      if(checkpoint instanceof Uint8Array)invalid("Materialization requires a sealed checkpoint stage.");
      synchronous(authorize);if(account)synchronous(account);
      return tx(()=>{
        callback(authorize);const h=storedHead(expected);active(h);assertCursor(expected,h.cursor);
        const resolved=checkpoints.resolve(expected,checkpoint,true);
        if(resolved.expectedBytes>h.capacityBytes)invalid("Materialization exceeds reserved capacity.");
        const releasedBytes=materializationRelease(expected);
        const bytes=resolved.storageBytes+Buffer.byteLength(JSON.stringify(expected))+512;
        if((resolved.stagedCreditBytes||releasedBytes)&&!account)invalid("Materialization replacement requires quota accounting.");
        if(account)callback(()=>account(Object.freeze({bytes,stagedCreditBytes:resolved.stagedCreditBytes,releasedBytes})));
        callback(authorize);const current=storedHead(expected);active(current);assertCursor(expected,current.cursor);
        removeMaterialization(expected);
        const checkpointId=checkpoints.activate(expected,checkpoint);
        db.prepare("INSERT INTO dohc_dataset_materializations VALUES(?,?,?,?,?,?,?)")
          .run(expected.workspaceId,expected.datasetId,JSON.stringify(expected),checkpointId,resolved.expectedBytes,resolved.sha256,account?bytes:0);
        return {cursor:expected,checkpointId,byteLength:resolved.expectedBytes,sha256:resolved.sha256};
      });
    },
    assertNotDeleted(value,authorize) {
      const key=scope(value);
      callback(authorize);notDeleted(key);
    },
    destroy(input) {
      const expected=cursor(input.expected),authorize=input.authorize,cleanup=input.cleanup;
      synchronous(authorize);if(cleanup)synchronous(cleanup);
      tx(()=>{
        callback(authorize);const h=storedHead(expected);active(h);assertCursor(expected,h.cursor);
        db.prepare("INSERT INTO dohc_dataset_deletions VALUES(?,?,?,?,?,?,?)")
          .run(expected.workspaceId,expected.datasetId,expected.hostEpoch,expected.approvedRevisionHash,expected.revision,expected.digest,integer(now()));
        db.prepare("UPDATE dohc_dataset_journals SET active=0 WHERE workspace_id=? AND dataset_id=?").run(expected.workspaceId,expected.datasetId);
        if(cleanup)callback(cleanup);
        callback(authorize);
        checkpoints.destroy(expected);
        for(const table of ["dohc_dataset_materializations","dohc_dataset_receipts","dohc_dataset_events","dohc_dataset_checkpoint_history","dohc_dataset_journals"])
          db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND dataset_id=?`).run(expected.workspaceId,expected.datasetId);
      });
    },
    stageCheckpoint(input) {
      const key=scope(input.scope),authorize=input.authorize;
      return checkpoints.stageCheckpoint({...input,scope:key,authorize:()=>{callback(authorize);notDeleted(key);}});
    },
    appendCheckpointChunk: checkpoints.appendCheckpointChunk,
    sealCheckpoint: checkpoints.sealCheckpoint,
    discardCheckpoint: checkpoints.discardCheckpoint,
    checkpointStages: checkpoints.checkpointStages,
    reclaimCheckpointStages: checkpoints.reclaimCheckpointStages,
    captureExport(input) {
      const key=scope(input.scope);
      return tx(()=>{
        callback(input.authorize); const h=storedHead(key), checkpoint=exportRecord(key,h.checkpointCursor.revision);
        if(checkpoint.kind!=="checkpoint")return corrupt("Export checkpoint is missing.");
        synchronous(input.capture);const captured=callback(()=>input.capture({...h.cursor}));callback(input.authorize);
        return {cursor:h.cursor,checkpoint,captured};
      });
    },
    exportPage(input) {
      const key=scope(input.scope),through=cursor(input.through),after=integer(input.afterRevision,-1),limit=integer(input.limit??64,1,64);
      if(through.workspaceId!==key.workspaceId||through.datasetId!==key.datasetId||after>through.revision)invalid("Invalid export range.");
      return tx(()=>{
        callback(input.authorize); assertCursor(through,exportRecord(key,through.revision).cursor);
        const records:JournalExportRecord[]=[];let bytes=0;
        for(let revision=after+1;revision<=through.revision&&records.length<limit;revision++){
          const record=exportRecord(key,revision),size=Buffer.byteLength(JSON.stringify(record));
          if(size>1024*1024)invalid("Export record metadata exceeds its limit.");
          if(bytes+size>1024*1024)break;
          records.push(record);bytes+=size;
        }
        return records;
      });
    },
    exportBlob(input) {
      const key=scope(input.scope),record=input.record,revision=integer(record.cursor.revision),offset=integer(input.offset),length=integer(input.length??1024*1024,1,1024*1024);
      if(record.cursor.workspaceId!==key.workspaceId||record.cursor.datasetId!==key.datasetId||offset>record.byteLength)invalid("Invalid export blob range.");
      return tx(()=>{
        callback(input.authorize);
        const current=exportRecord(key,revision);
        if(JSON.stringify(current)!==JSON.stringify(record))return corrupt("Export record changed.");
        const checkpoint=record.kind==="checkpoint" ? db.prepare(`SELECT checkpoint_id FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=? AND checkpoint_revision=?
          UNION ALL SELECT checkpoint_id FROM dohc_dataset_checkpoint_history WHERE workspace_id=? AND dataset_id=? AND revision=?`)
          .get(key.workspaceId,key.datasetId,revision,key.workspaceId,key.datasetId,revision) : undefined;
        const row=record.kind==="event"
          ? db.prepare("SELECT substr(changeset,?,?) AS bytes FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND revision=?").get(offset+1,length,key.workspaceId,key.datasetId,revision)
          : checkpoint ? {bytes:checkpoints.read(key,String(checkpoint.checkpoint_id),offset,length)} : undefined;
        if(!row||!(row.bytes instanceof Uint8Array)||row.bytes.byteLength!==Math.min(length,record.byteLength-offset))return corrupt("Export blob is incomplete.");
        return new Uint8Array(row.bytes);
      });
    },
    initialize(input) {
      const key=scope(input.scope),hostEpoch=text(input.hostEpoch,256),approvedRevisionHash=digest(input.approvedRevisionHash),source=text(input.source,256*1024),schemaSql=text(input.schemaSql,256*1024),definitionJson=resultText(input.definitionJson);
      const checkpoint=input.checkpoint instanceof Uint8Array?copyBytes(input.checkpoint,maxCheckpoint):structuredClone(input.checkpoint),capacityBytes=integer(input.capacityBytes??128*1024*1024,4096,maxCheckpoint);
      const authorize=input.authorize,account=input.account;
      synchronous(authorize);if(account)synchronous(account);
      return tx(()=>{
        callback(authorize);notDeleted(key);
        const resolved=checkpoints.resolve(key,checkpoint),checkpointSha256=resolved.sha256;
        if(resolved.expectedBytes>capacityBytes)invalid("Checkpoint exceeds reserved capacity.");
        const initial=cursor({...key,hostEpoch,approvedRevisionHash,revision:0,digest:checkpointHash({...key,hostEpoch,approvedRevisionHash,revision:0},checkpointSha256,source,schemaSql,definitionJson,capacityBytes,null)});
        const exists=db.prepare("SELECT 1 FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
        if(exists) {
          const h=storedHead(key);active(h);
          if(!sameIdentity(initial,h.cursor)||h.checkpointCursor.digest!==initial.digest||h.checkpointCursor.revision!==0||h.capacityBytes!==capacityBytes)throw new JournalError("conflict","Dataset initialization differs from its approved state.");
          return h.cursor;
        }
        if(resolved.stagedCreditBytes&&!account)invalid("Staged checkpoint activation requires quota accounting.");
        if(account)callback(()=>account(Object.freeze({bytes:capacityBytes+resolved.storageBytes+Buffer.byteLength(JSON.stringify([initial,source,schemaSql,definitionJson]))+512,capacityBytes,stagedCreditBytes:resolved.stagedCreditBytes})));
        callback(authorize);notDeleted(key);
        const checkpointId=checkpoints.activate(key,checkpoint);
        db.prepare("INSERT INTO dohc_dataset_journals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(key.workspaceId,key.datasetId,hostEpoch,approvedRevisionHash,source,schemaSql,definitionJson,0,initial.digest,1,capacityBytes,checkpointId,checkpointSha256,0,initial.digest,null);
        return initial;
      });
    },
    transitionCheckpoint(input) {
      const expected=cursor(input.expected),hostEpoch=text(input.hostEpoch,256),approvedRevisionHash=digest(input.approvedRevisionHash);
      const source=text(input.source,256*1024),schemaSql=text(input.schemaSql,256*1024),definitionJson=resultText(input.definitionJson);
      const checkpoint=input.checkpoint instanceof Uint8Array?copyBytes(input.checkpoint,maxCheckpoint):structuredClone(input.checkpoint),authorize=input.authorize,account=input.account;
      const requestedCapacity=input.capacityBytes===undefined?undefined:integer(input.capacityBytes,4096,maxCheckpoint);
      synchronous(authorize);if(account)synchronous(account);
      return tx(()=>{
        callback(authorize);
        const resolved=checkpoints.resolve(expected,checkpoint),checkpointSha256=resolved.sha256;
        const h=storedHead(expected);active(h);
        const capacityBytes=requestedCapacity??h.capacityBytes;
        if(capacityBytes<h.capacityBytes)invalid("Checkpoint transition cannot release materialization capacity.");
        if(resolved.expectedBytes>capacityBytes)invalid("Checkpoint exceeds reserved capacity.");
        const next=cursor({...expected,hostEpoch,approvedRevisionHash,revision:integer(expected.revision+1,1),
          digest:checkpointHash({...expected,hostEpoch,approvedRevisionHash,revision:expected.revision+1},checkpointSha256,source,schemaSql,definitionJson,capacityBytes,expected)});
        // Lost transition acknowledgments do not run host accounting twice.
        if(h.checkpointPrevious&&sameCursor(h.checkpointPrevious,expected)&&sameCursor(h.checkpointCursor,next))return next;
        assertCursor(expected,h.cursor);
        if(approvedRevisionHash===expected.approvedRevisionHash && (source!==h.source||schemaSql!==h.schemaSql||definitionJson!==h.definitionJson))
          invalid("Changed dataset artifacts require a new approved revision.");
        const releasedBytes=materializationRelease(expected);
        const bytes=resolved.storageBytes+Buffer.byteLength(JSON.stringify([next,expected,source,schemaSql,definitionJson]))+1024+capacityBytes-h.capacityBytes-releasedBytes;
        if((resolved.stagedCreditBytes||releasedBytes)&&!account)invalid("Staged checkpoint activation requires quota accounting.");
        if(account)callback(()=>account(Object.freeze({bytes,capacityBytes,capacityDeltaBytes:capacityBytes-h.capacityBytes,cursor:next,stagedCreditBytes:resolved.stagedCreditBytes})));
        callback(authorize);
        removeMaterialization(expected);
        const checkpointId=checkpoints.activate(expected,checkpoint);
        db.prepare(`INSERT INTO dohc_dataset_checkpoint_history(workspace_id,dataset_id,revision,cursor_json,previous_json,source,schema_sql,
          definition_json,capacity_bytes,checkpoint_id,checkpoint_sha256)
          SELECT workspace_id,dataset_id,checkpoint_revision,?,checkpoint_previous_json,source,schema_sql,definition_json,capacity_bytes,checkpoint_id,checkpoint_sha256
          FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?`).run(JSON.stringify(h.checkpointCursor),expected.workspaceId,expected.datasetId);
        const changed=db.prepare(`UPDATE dohc_dataset_journals SET host_epoch=?,approved_revision_hash=?,source=?,schema_sql=?,definition_json=?,
          revision=?,digest=?,capacity_bytes=?,checkpoint_id=?,checkpoint_sha256=?,checkpoint_revision=?,checkpoint_digest=?,checkpoint_previous_json=?
          WHERE workspace_id=? AND dataset_id=? AND host_epoch=? AND approved_revision_hash=? AND revision=? AND digest=? AND active=1`)
          .run(hostEpoch,approvedRevisionHash,source,schemaSql,definitionJson,next.revision,next.digest,capacityBytes,checkpointId,checkpointSha256,
            next.revision,next.digest,JSON.stringify(expected),expected.workspaceId,expected.datasetId,expected.hostEpoch,expected.approvedRevisionHash,expected.revision,expected.digest);
        if(Number(changed.changes)!==1)throw new JournalError("conflict","Dataset cursor changed during checkpoint transition.");
        return next;
      });
    },
    claimInactiveCheckpoint(input) {
      const expected=cursor(input.expected),hostEpoch=text(input.hostEpoch,256),approvedRevisionHash=digest(input.approvedRevisionHash);
      if (hostEpoch===expected.hostEpoch) invalid("A claimed dataset requires a fresh host epoch.");
      const source=text(input.source,256*1024),schemaSql=text(input.schemaSql,256*1024),definitionJson=resultText(input.definitionJson);
      const checkpoint=input.checkpoint instanceof Uint8Array?copyBytes(input.checkpoint,maxCheckpoint):structuredClone(input.checkpoint),authorize=input.authorize,account=input.account;
      synchronous(authorize);if(account)synchronous(account);
      return tx(()=>{
        callback(authorize);
        const h=storedHead(expected);
        if(approvedRevisionHash!==expected.approvedRevisionHash)invalid("Inactive dataset claims cannot change approved rules.");
        const resolved=checkpoints.resolve(expected,checkpoint),capacityBytes=h.capacityBytes;
        if(source!==h.source||schemaSql!==h.schemaSql||definitionJson!==h.definitionJson)invalid("Inactive dataset claims cannot change approved artifacts.");
        if(input.capacityBytes!==undefined&&input.capacityBytes!==capacityBytes)invalid("Inactive dataset claims cannot change reserved capacity.");
        if(resolved.expectedBytes>capacityBytes)invalid("Checkpoint exceeds reserved capacity.");
        const next=cursor({...expected,hostEpoch,approvedRevisionHash,revision:integer(expected.revision+1,1),
          digest:checkpointHash({...expected,hostEpoch,approvedRevisionHash,revision:expected.revision+1},resolved.sha256,source,schemaSql,definitionJson,capacityBytes,expected)});
        if(h.active&&h.checkpointPrevious&&sameCursor(h.checkpointPrevious,expected)&&sameCursor(h.checkpointCursor,next))return next;
        if(h.active)throw new JournalError("conflict","Dataset authority is already active.");
        assertCursor(expected,h.cursor);
        if(db.prepare("SELECT 1 FROM dohc_dataset_checkpoint_history WHERE workspace_id=? AND dataset_id=? AND json_extract(cursor_json,'$.hostEpoch')=? LIMIT 1")
          .get(expected.workspaceId,expected.datasetId,hostEpoch)||db.prepare("SELECT 1 FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND host_epoch=? LIMIT 1")
          .get(expected.workspaceId,expected.datasetId,hostEpoch))invalid("A claimed dataset requires a fresh host epoch.");
        const releasedBytes=materializationRelease(expected);
        const bytes=resolved.storageBytes+Buffer.byteLength(JSON.stringify([next,expected,source,schemaSql,definitionJson]))+1024-releasedBytes;
        if((resolved.stagedCreditBytes||releasedBytes)&&!account)invalid("Staged checkpoint activation requires quota accounting.");
        if(account)callback(()=>account(Object.freeze({bytes,capacityBytes,capacityDeltaBytes:0,cursor:next,stagedCreditBytes:resolved.stagedCreditBytes})));
        callback(authorize);
        removeMaterialization(expected);
        const checkpointId=checkpoints.activate(expected,checkpoint);
        db.prepare(`INSERT INTO dohc_dataset_checkpoint_history(workspace_id,dataset_id,revision,cursor_json,previous_json,source,schema_sql,
          definition_json,capacity_bytes,checkpoint_id,checkpoint_sha256)
          SELECT workspace_id,dataset_id,checkpoint_revision,?,checkpoint_previous_json,source,schema_sql,definition_json,capacity_bytes,checkpoint_id,checkpoint_sha256
          FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?`).run(JSON.stringify(h.checkpointCursor),expected.workspaceId,expected.datasetId);
        const changed=db.prepare(`UPDATE dohc_dataset_journals SET active=1,host_epoch=?,approved_revision_hash=?,source=?,schema_sql=?,definition_json=?,
          revision=?,digest=?,checkpoint_id=?,checkpoint_sha256=?,checkpoint_revision=?,checkpoint_digest=?,checkpoint_previous_json=?
          WHERE workspace_id=? AND dataset_id=? AND host_epoch=? AND approved_revision_hash=? AND revision=? AND digest=? AND active=0`)
          .run(hostEpoch,approvedRevisionHash,source,schemaSql,definitionJson,next.revision,next.digest,checkpointId,resolved.sha256,next.revision,next.digest,JSON.stringify(expected),
            expected.workspaceId,expected.datasetId,expected.hostEpoch,expected.approvedRevisionHash,expected.revision,expected.digest);
        if(Number(changed.changes)!==1)throw new JournalError("conflict","Dataset claim changed during activation.");
        return next;
      });
    },
    head(value,authorize) {
      const key=scope(value);
      return tx(()=>{callback(authorize);const {cursor:current,active:enabled,source,schemaSql,definitionJson,capacityBytes}=storedHead(key);return {cursor:current,active:enabled,source,schemaSql,definitionJson,capacityBytes};});
    },
    receipt(input) {
      const key=scope(input.scope),callerKey=text(input.callerKey,1024),idempotencyKey=text(input.idempotencyKey,128),payloadSha256=digest(input.payloadSha256),authorize=input.authorize;
      return tx(()=>{callback(authorize);active(storedHead(key));return readReceipt(key,callerKey,idempotencyKey,payloadSha256);});
    },
    commitOperation(input) {
      const expected=cursor(input.expected),proposalId=text(input.proposalId,256),operation=text(input.operation,256),callerKey=text(input.callerKey,1024),idempotencyKey=text(input.idempotencyKey,128);
      const payloadSha256=digest(input.payloadSha256),resultJson=resultText(input.resultJson),changeset=copyBytes(input.changeset,maxEvent),changesetSha256=digest(input.changesetSha256);
      const attachedFileIds=fileIds(input.attachedFileIds),recordedAtMs=integer(input.recordedAtMs??now()),authorize=input.authorize,accountAndAttach=input.accountAndAttach;
      synchronous(authorize);if(accountAndAttach)synchronous(accountAndAttach);
      if(hash(changeset)!==changesetSha256)invalid("Changeset digest mismatch.");
      const metadata={proposalId,operation,callerKey,idempotencyKey,payloadSha256,resultJson,changesetSha256,attachedFileIds,recordedAtMs};
      const storageBytes=changeset.byteLength+Buffer.byteLength(JSON.stringify([expected,metadata]))+Buffer.byteLength(JSON.stringify([expected.workspaceId,expected.datasetId,callerKey,idempotencyKey,payloadSha256,resultJson]))+1024;
      if(storageBytes>maxEvent)invalid("Journal event exceeds the limit.");
      return tx(()=>{
        callback(authorize);
        const h=storedHead(expected);active(h);
        if(!sameIdentity(expected,h.cursor))throw new JournalError("conflict","Dataset approval or host changed.");
        const receipt=readReceipt(expected,callerKey,idempotencyKey,payloadSha256);
        if(receipt)return {kind:"replayed",receipt};
        assertCursor(expected,h.cursor);
        const revision=integer(expected.revision+1,1);
        const event:JournalEvent={...metadata,previousDigest:expected.digest,changeset,cursor:{...expected,revision,digest:""}};
        event.cursor=cursor({...event.cursor,digest:eventHash(event)});
        if(attachedFileIds.length && !accountAndAttach)invalid("Attachment commit requires host validation.");
        if(accountAndAttach)callback(()=>accountAndAttach(Object.freeze({revision,bytes:storageBytes,attachedFileIds})));
        callback(authorize);
        db.prepare("INSERT INTO dohc_dataset_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(expected.workspaceId,expected.datasetId,revision,expected.digest,event.cursor.digest,expected.hostEpoch,expected.approvedRevisionHash,
            proposalId,operation,callerKey,idempotencyKey,payloadSha256,resultJson,changeset,changesetSha256,JSON.stringify(attachedFileIds),recordedAtMs,storageBytes);
        db.prepare("INSERT INTO dohc_dataset_receipts VALUES(?,?,?,?,?,?,?)").run(expected.workspaceId,expected.datasetId,callerKey,idempotencyKey,payloadSha256,revision,resultJson);
        const updated=db.prepare(`UPDATE dohc_dataset_journals SET revision=?,digest=? WHERE workspace_id=? AND dataset_id=?
          AND revision=? AND digest=? AND host_epoch=? AND approved_revision_hash=? AND active=1`)
          .run(revision,event.cursor.digest,expected.workspaceId,expected.datasetId,expected.revision,expected.digest,expected.hostEpoch,expected.approvedRevisionHash);
        if(Number(updated.changes)!==1)throw new JournalError("conflict","Dataset cursor changed during commit.");
        return {kind:"committed",receipt:{revision,payloadSha256,resultJson},event};
      });
    },
    events(input) {
      const key=scope(input.scope),after=cursor(input.after),limit=integer(input.limit??100,1,1000),byteLimit=integer(input.byteLimit??maxPage,1,maxPage),authorize=input.authorize;
      return tx(()=>{
        callback(authorize);
        const h=storedHead(key);
        if(after.revision<h.checkpointCursor.revision)throw new JournalError("conflict","Dataset schema changed. Recover from its current checkpoint.");
        if(!sameIdentity(after,h.cursor)||after.revision>h.cursor.revision)throw new JournalError("conflict","Cursor scope or revision changed.");
        const previous=after.revision===h.checkpointCursor.revision?h.checkpointCursor:readEvent(key,after.revision).cursor;
        assertCursor(after,previous);
        const headers=db.prepare("SELECT revision,storage_bytes FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=? AND revision>? ORDER BY revision LIMIT ?")
          .all(key.workspaceId,key.datasetId,after.revision,limit);
        let current=after,total=0;const events:JournalEvent[]=[];
        for(const header of headers) {
          const size=Number(header.storage_bytes);
          if(!Number.isSafeInteger(size)||size<1||size>maxEvent)return corrupt("Journal event size is damaged.");
          if(total+size>byteLimit){if(!events.length)invalid("Event exceeds the requested page byte limit.");break;}
          const event=readEvent(key,Number(header.revision));
          if(event.cursor.revision!==current.revision+1||event.previousDigest!==current.digest||!sameIdentity(event.cursor,current))return corrupt("Journal sequence is broken.");
          events.push(event);total+=size;current=event.cursor;
        }
        if(current.revision===h.cursor.revision) {if(current.digest!==h.cursor.digest)return corrupt("Journal head digest mismatch.");}
        else if(headers.length<limit && events.length===headers.length)return corrupt("Journal tail is missing.");
        return {events,head:h.cursor};
      });
    },
    checkpoint(input) {
      const key=scope(input.scope),authorize=input.authorize,revision=input.revision===undefined?undefined:integer(input.revision);
      return tx(()=>{
        callback(authorize);const h=storedHead(key);
        const requested=revision??h.checkpointCursor.revision;
        if(requested===h.checkpointCursor.revision) {
          const bytes=checkpointBytes(key,h.checkpointId,h.checkpointSha256,authorize);
          return {cursor:h.checkpointCursor,bytes,sha256:h.checkpointSha256,source:h.source,schemaSql:h.schemaSql,definitionJson:h.definitionJson};
        }
        if(requested>h.checkpointCursor.revision)throw new JournalError("conflict","Checkpoint revision is not available.");
        const row=db.prepare("SELECT * FROM dohc_dataset_checkpoint_history WHERE workspace_id=? AND dataset_id=? AND revision=?").get(key.workspaceId,key.datasetId,requested);
        if(!row)throw new JournalError("conflict","Checkpoint revision is not available.");
        try {
          const oldCursor=cursor(JSON.parse(String(row.cursor_json))),previous=row.previous_json===null?null:cursor(JSON.parse(String(row.previous_json)));
          const source=text(String(row.source),256*1024),schemaSql=text(String(row.schema_sql),256*1024),definitionJson=resultText(String(row.definition_json)),capacityBytes=integer(Number(row.capacity_bytes),4096),sha256=digest(String(row.checkpoint_sha256)),bytes=checkpointBytes(key,String(row.checkpoint_id),sha256,authorize);
          if(oldCursor.workspaceId!==key.workspaceId||oldCursor.datasetId!==key.datasetId||oldCursor.revision!==requested ||
            (previous ? previous.workspaceId!==key.workspaceId||previous.datasetId!==key.datasetId||previous.revision+1!==requested : requested!==0) ||
            hash(bytes)!==sha256||checkpointHash(oldCursor,sha256,source,schemaSql,definitionJson,capacityBytes,previous)!==oldCursor.digest)return corrupt("Checkpoint history integrity check failed.");
          return {cursor:oldCursor,bytes,sha256,source,schemaSql,definitionJson};
        } catch { return corrupt("Checkpoint history is damaged."); }
      });
    },
    fence(input) {
      const expected=cursor(input.expected),authorize=input.authorize;
      return tx(()=>{callback(authorize);const h=storedHead(expected);assertCursor(expected,h.cursor);
        db.prepare("UPDATE dohc_dataset_journals SET active=0 WHERE workspace_id=? AND dataset_id=?").run(expected.workspaceId,expected.datasetId);return h.cursor;});
    }
  };
}
