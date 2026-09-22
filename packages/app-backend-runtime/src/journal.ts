import { createHash } from "node:crypto";

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
  checkpoint: Uint8Array;
  capacityBytes?: number;
  authorize: Authorize;
  account?: (allocation: Readonly<{ bytes: number; capacityBytes: number }>) => unknown;
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
  checkpoint: Uint8Array;
  account?: (allocation: Readonly<{bytes: number; capacityBytes: number; capacityDeltaBytes: number; cursor: DatasetCursor}>) => unknown;
}
export interface DatasetJournal {
  initialize(input: InitializeDatasetInput): DatasetCursor;
  transitionCheckpoint(input: TransitionCheckpointInput): DatasetCursor;
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
type StoredHead = DatasetHead & {checkpointSha256: string; checkpointCursor: DatasetCursor; checkpointPrevious: DatasetCursor | null};

/** The host owns authorization and durability. This module never accepts caller-supplied authority. */
export function createDatasetJournal(options: JournalOptions): DatasetJournal {
  const {db,transaction}=options, now=options.nowMs ?? Date.now;
  synchronous(transaction);
  const maxEvent=integer(options.maxEventBytes ?? 16*1024*1024,1024,128*1024*1024);
  const maxCheckpoint=integer(options.maxCheckpointBytes ?? 128*1024*1024,4096,1024*1024*1024);
  const maxPage=integer(options.maxPageBytes ?? 32*1024*1024,maxEvent,256*1024*1024);
  const tx=<T>(run:()=>T):T=>callback(()=>transaction(()=>callback(run)));
  tx(()=>db.exec(`
    CREATE TABLE IF NOT EXISTS dohc_dataset_journals (
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,host_epoch TEXT NOT NULL,approved_revision_hash TEXT NOT NULL,
      source TEXT NOT NULL,schema_sql TEXT NOT NULL,definition_json TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),digest TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes>=4096),
      checkpoint BLOB NOT NULL,checkpoint_sha256 TEXT NOT NULL,checkpoint_revision INTEGER NOT NULL CHECK(checkpoint_revision>=0),
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
      capacity_bytes INTEGER NOT NULL,checkpoint BLOB NOT NULL,checkpoint_sha256 TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,revision)) STRICT;`));
  function storedHead(key: DatasetScope): StoredHead {
    const row=db.prepare(`SELECT workspace_id,dataset_id,host_epoch,approved_revision_hash,source,schema_sql,definition_json,revision,digest,active,
      capacity_bytes,checkpoint_sha256,checkpoint_revision,checkpoint_digest,checkpoint_previous_json FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?`).get(key.workspaceId,key.datasetId);
    if(!row) throw new JournalError("conflict","Dataset is not initialized.");
    try {
      const head={cursor:cursor({...key,hostEpoch:String(row.host_epoch),approvedRevisionHash:String(row.approved_revision_hash),revision:Number(row.revision),digest:String(row.digest)}),
        active:row.active===1,source:text(String(row.source),256*1024),schemaSql:text(String(row.schema_sql),256*1024),definitionJson:resultText(String(row.definition_json)),capacityBytes:integer(Number(row.capacity_bytes),4096),
        checkpointSha256:digest(String(row.checkpoint_sha256)),
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
  return {
    initialize(input) {
      const key=scope(input.scope),hostEpoch=text(input.hostEpoch,256),approvedRevisionHash=digest(input.approvedRevisionHash),source=text(input.source,256*1024),schemaSql=text(input.schemaSql,256*1024),definitionJson=resultText(input.definitionJson);
      const checkpoint=copyBytes(input.checkpoint,maxCheckpoint),capacityBytes=integer(input.capacityBytes??128*1024*1024,4096,maxCheckpoint);
      if(checkpoint.byteLength>capacityBytes)invalid("Checkpoint exceeds reserved capacity.");
      const authorize=input.authorize,account=input.account,checkpointSha256=hash(checkpoint);
      synchronous(authorize);if(account)synchronous(account);
      const initial=cursor({...key,hostEpoch,approvedRevisionHash,revision:0,digest:checkpointHash({...key,hostEpoch,approvedRevisionHash,revision:0},checkpointSha256,source,schemaSql,definitionJson,capacityBytes,null)});
      return tx(()=>{
        callback(authorize);
        const exists=db.prepare("SELECT 1 FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId);
        if(exists) {
          const h=storedHead(key);active(h);
          if(!sameIdentity(initial,h.cursor)||h.checkpointCursor.digest!==initial.digest||h.checkpointCursor.revision!==0||h.capacityBytes!==capacityBytes)throw new JournalError("conflict","Dataset initialization differs from its approved state.");
          return h.cursor;
        }
        if(account)callback(()=>account(Object.freeze({bytes:capacityBytes+checkpoint.byteLength+Buffer.byteLength(JSON.stringify([initial,source,schemaSql,definitionJson]))+512,capacityBytes})));
        callback(authorize);
        db.prepare("INSERT INTO dohc_dataset_journals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(key.workspaceId,key.datasetId,hostEpoch,approvedRevisionHash,source,schemaSql,definitionJson,0,initial.digest,1,capacityBytes,checkpoint,checkpointSha256,0,initial.digest,null);
        return initial;
      });
    },
    transitionCheckpoint(input) {
      const expected=cursor(input.expected),hostEpoch=text(input.hostEpoch,256),approvedRevisionHash=digest(input.approvedRevisionHash);
      const source=text(input.source,256*1024),schemaSql=text(input.schemaSql,256*1024),definitionJson=resultText(input.definitionJson);
      const checkpoint=copyBytes(input.checkpoint,maxCheckpoint),checkpointSha256=hash(checkpoint),authorize=input.authorize,account=input.account;
      const requestedCapacity=input.capacityBytes===undefined?undefined:integer(input.capacityBytes,4096,maxCheckpoint);
      synchronous(authorize);if(account)synchronous(account);
      return tx(()=>{
        callback(authorize);
        const h=storedHead(expected);active(h);
        const capacityBytes=requestedCapacity??h.capacityBytes;
        if(capacityBytes<h.capacityBytes)invalid("Checkpoint transition cannot release materialization capacity.");
        if(checkpoint.byteLength>capacityBytes)invalid("Checkpoint exceeds reserved capacity.");
        const next=cursor({...expected,hostEpoch,approvedRevisionHash,revision:integer(expected.revision+1,1),
          digest:checkpointHash({...expected,hostEpoch,approvedRevisionHash,revision:expected.revision+1},checkpointSha256,source,schemaSql,definitionJson,capacityBytes,expected)});
        // Lost transition acknowledgments do not run host accounting twice.
        if(h.checkpointPrevious&&sameCursor(h.checkpointPrevious,expected)&&sameCursor(h.checkpointCursor,next))return next;
        assertCursor(expected,h.cursor);
        if(approvedRevisionHash===expected.approvedRevisionHash && (source!==h.source||schemaSql!==h.schemaSql||definitionJson!==h.definitionJson))
          invalid("Changed dataset artifacts require a new approved revision.");
        const bytes=checkpoint.byteLength+Buffer.byteLength(JSON.stringify([next,expected,source,schemaSql,definitionJson]))+1024+capacityBytes-h.capacityBytes;
        if(account)callback(()=>account(Object.freeze({bytes,capacityBytes,capacityDeltaBytes:capacityBytes-h.capacityBytes,cursor:next})));
        callback(authorize);
        db.prepare(`INSERT INTO dohc_dataset_checkpoint_history(workspace_id,dataset_id,revision,cursor_json,previous_json,source,schema_sql,
          definition_json,capacity_bytes,checkpoint,checkpoint_sha256)
          SELECT workspace_id,dataset_id,checkpoint_revision,?,checkpoint_previous_json,source,schema_sql,definition_json,capacity_bytes,checkpoint,checkpoint_sha256
          FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?`).run(JSON.stringify(h.checkpointCursor),expected.workspaceId,expected.datasetId);
        const changed=db.prepare(`UPDATE dohc_dataset_journals SET host_epoch=?,approved_revision_hash=?,source=?,schema_sql=?,definition_json=?,
          revision=?,digest=?,capacity_bytes=?,checkpoint=?,checkpoint_sha256=?,checkpoint_revision=?,checkpoint_digest=?,checkpoint_previous_json=?
          WHERE workspace_id=? AND dataset_id=? AND host_epoch=? AND approved_revision_hash=? AND revision=? AND digest=? AND active=1`)
          .run(hostEpoch,approvedRevisionHash,source,schemaSql,definitionJson,next.revision,next.digest,capacityBytes,checkpoint,checkpointSha256,
            next.revision,next.digest,JSON.stringify(expected),expected.workspaceId,expected.datasetId,expected.hostEpoch,expected.approvedRevisionHash,expected.revision,expected.digest);
        if(Number(changed.changes)!==1)throw new JournalError("conflict","Dataset cursor changed during checkpoint transition.");
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
          const row=db.prepare("SELECT checkpoint FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(key.workspaceId,key.datasetId)!;
          const bytes=copyBytes(row.checkpoint as Uint8Array,maxCheckpoint);
          if(hash(bytes)!==h.checkpointSha256)return corrupt("Checkpoint integrity check failed.");
          return {cursor:h.checkpointCursor,bytes,sha256:h.checkpointSha256,source:h.source,schemaSql:h.schemaSql,definitionJson:h.definitionJson};
        }
        if(requested>h.checkpointCursor.revision)throw new JournalError("conflict","Checkpoint revision is not available.");
        const row=db.prepare("SELECT * FROM dohc_dataset_checkpoint_history WHERE workspace_id=? AND dataset_id=? AND revision=?").get(key.workspaceId,key.datasetId,requested);
        if(!row)throw new JournalError("conflict","Checkpoint revision is not available.");
        try {
          const oldCursor=cursor(JSON.parse(String(row.cursor_json))),previous=row.previous_json===null?null:cursor(JSON.parse(String(row.previous_json)));
          const source=text(String(row.source),256*1024),schemaSql=text(String(row.schema_sql),256*1024),definitionJson=resultText(String(row.definition_json)),capacityBytes=integer(Number(row.capacity_bytes),4096),sha256=digest(String(row.checkpoint_sha256)),bytes=copyBytes(row.checkpoint as Uint8Array,maxCheckpoint);
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
