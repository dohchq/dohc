import { createHash, randomUUID } from "node:crypto";
import type { DatasetScope, JournalDb } from "./journal.js";

/** Scoped, immutable manifest. Only the journal accepts this host-created handle. */
export interface CheckpointStage {
  stageId: string;
  scope: DatasetScope;
  expectedBytes: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  sealed: boolean;
}
export interface CheckpointStageAllocation { bytes: number; scope: DatasetScope; stage: CheckpointStage }
export interface ReclaimCheckpointStagesInput {
  after?: string;
  limit?: number;
  authorize: () => unknown;
  /** Checked inside each deletion transaction. Recovery imports retain their stages. */
  retain: (stage: Readonly<CheckpointStage>) => boolean;
  account: (allocation: Readonly<CheckpointStageAllocation>) => unknown;
}
type Authorize = () => unknown;
type StageRow = { stage_id: string; workspace_id: string; dataset_id: string; byte_length: number; sha256: string; state: number; reserved_bytes: number; next_index: number };
export const CHECKPOINT_CHUNK_BYTES = 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function synchronous(fn: Function) {
  if (typeof fn !== "function" || fn.constructor.name === "AsyncFunction") throw new Error("Checkpoint callbacks must be synchronous.");
}
function callback<T>(fn: () => T): T {
  synchronous(fn);
  const result = fn();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Checkpoint callbacks must be synchronous.");
  return result;
}
function validText(value: string) { if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 4096) throw new Error("Invalid checkpoint identity."); return value; }
function manifest(row: StageRow): CheckpointStage {
  return { stageId: row.stage_id, scope: { workspaceId: row.workspace_id, datasetId: row.dataset_id }, expectedBytes: row.byte_length,
    sha256: row.sha256, chunkSize: CHECKPOINT_CHUNK_BYTES, chunkCount: Math.ceil(row.byte_length / CHECKPOINT_CHUNK_BYTES), sealed: row.state !== 0 };
}

/** Staged reservations survive restart. The owner must discard abandoned stages through the same quota transaction. */
export function createCheckpointStorage(db: JournalDb, transaction: <T>(work: () => T) => T, maximumBytes: number) {
  synchronous(transaction);
  callback(() => transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS dohc_dataset_checkpoints (
      stage_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>=0),
      sha256 TEXT NOT NULL,state INTEGER NOT NULL CHECK(state IN(0,1,2)),reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
      next_index INTEGER NOT NULL CHECK(next_index>=0)) STRICT;
    CREATE INDEX IF NOT EXISTS dohc_dataset_checkpoints_scope ON dohc_dataset_checkpoints(workspace_id,dataset_id,state,stage_id);
    CREATE INDEX IF NOT EXISTS dohc_dataset_checkpoints_staged ON dohc_dataset_checkpoints(stage_id) WHERE state!=2;
    CREATE TABLE IF NOT EXISTS dohc_dataset_checkpoint_chunks (
      stage_id TEXT NOT NULL,chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),bytes BLOB NOT NULL CHECK(length(bytes)>0 AND length(bytes)<=1048576),
      sha256 TEXT NOT NULL,PRIMARY KEY(stage_id,chunk_index),FOREIGN KEY(stage_id) REFERENCES dohc_dataset_checkpoints(stage_id)) STRICT;`)));
  const tx = <T>(work: () => T) => callback(() => transaction(() => callback(work)));
  function validateRow(value: StageRow | undefined): StageRow {
    if (!value || !Number.isSafeInteger(value.byte_length) || value.byte_length < 0 || value.byte_length > maximumBytes || !/^[a-f0-9]{64}$/.test(value.sha256)
      || ![0, 1, 2].includes(value.state) || !Number.isSafeInteger(value.next_index) || value.next_index < 0 || value.next_index > Math.ceil(value.byte_length / CHECKPOINT_CHUNK_BYTES)
      || !Number.isSafeInteger(value.reserved_bytes) || value.reserved_bytes < 0 || value.reserved_bytes > storageBytes(value.byte_length)) throw new Error("Checkpoint manifest is damaged.");
    return value;
  }
  const row = (stage: CheckpointStage): StageRow => {
    const value = validateRow(db.prepare("SELECT * FROM dohc_dataset_checkpoints WHERE stage_id=? AND workspace_id=? AND dataset_id=?")
      .get(validText(stage.stageId), validText(stage.scope.workspaceId), validText(stage.scope.datasetId)) as StageRow | undefined);
    if (value.byte_length !== stage.expectedBytes || value.sha256 !== stage.sha256 || stage.chunkSize !== CHECKPOINT_CHUNK_BYTES
      || stage.chunkCount !== Math.ceil(value.byte_length / CHECKPOINT_CHUNK_BYTES)) throw new Error("Checkpoint stage changed or is unavailable.");
    return value;
  };
  function chunk(value: StageRow, index: number): Uint8Array {
    const expected = Math.min(CHECKPOINT_CHUNK_BYTES, value.byte_length - index * CHECKPOINT_CHUNK_BYTES);
    const size = db.prepare("SELECT length(bytes) AS byte_length,sha256 FROM dohc_dataset_checkpoint_chunks WHERE stage_id=? AND chunk_index=?").get(value.stage_id, index);
    if (!size || size.byte_length !== expected || expected <= 0 || expected > CHECKPOINT_CHUNK_BYTES) throw new Error("Checkpoint chunk integrity check failed.");
    const item = db.prepare("SELECT bytes FROM dohc_dataset_checkpoint_chunks WHERE stage_id=? AND chunk_index=?").get(value.stage_id, index);
    if (!item || !(item.bytes instanceof Uint8Array) || item.bytes.byteLength !== expected || digest(item.bytes) !== size.sha256) throw new Error("Checkpoint chunk integrity check failed.");
    return item.bytes;
  }
  function stageCheckpoint(input: { scope: DatasetScope; expectedBytes: number; sha256: string; authorize: Authorize; account?: (allocation: Readonly<CheckpointStageAllocation>) => unknown }): CheckpointStage {
    if (input.account) synchronous(input.account);
    const key = Object.freeze({ workspaceId: validText(input.scope.workspaceId), datasetId: validText(input.scope.datasetId) });
    if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0 || input.expectedBytes > maximumBytes || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Invalid checkpoint size or digest.");
    const value: StageRow = { stage_id: randomUUID(), workspace_id: key.workspaceId, dataset_id: key.datasetId, byte_length: input.expectedBytes,
      sha256: input.sha256, state: 0, reserved_bytes: input.account ? storageBytes(input.expectedBytes) : 0, next_index: 0 };
    const stage = manifest(value);
    return tx(() => {
      callback(input.authorize);
      if (input.account) callback(() => input.account!(Object.freeze({ bytes: value.reserved_bytes, scope: key, stage: structuredClone(stage) })));
      db.prepare("INSERT INTO dohc_dataset_checkpoints VALUES(?,?,?,?,?,?,?,?)").run(value.stage_id, key.workspaceId, key.datasetId, value.byte_length, value.sha256, 0, value.reserved_bytes, 0);
      callback(input.authorize); return stage;
    });
  }
  function appendCheckpointChunk(input: { stage: CheckpointStage; index: number; bytes: Uint8Array; authorize: Authorize }) {
    if (!Number.isSafeInteger(input.index) || input.index < 0 || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > CHECKPOINT_CHUNK_BYTES) throw new Error("Invalid checkpoint chunk.");
    const bytes = new Uint8Array(input.bytes), stage = structuredClone(input.stage), index = input.index;
    tx(() => {
      callback(input.authorize); const value = row(stage), expected = Math.min(CHECKPOINT_CHUNK_BYTES, value.byte_length - index * CHECKPOINT_CHUNK_BYTES);
      if (value.state !== 0 || value.next_index !== index || expected <= 0 || bytes.byteLength !== expected) throw new Error("Checkpoint chunks must be appended once, in order.");
      db.prepare("INSERT INTO dohc_dataset_checkpoint_chunks VALUES(?,?,?,?)").run(value.stage_id, index, bytes, digest(bytes));
      db.prepare("UPDATE dohc_dataset_checkpoints SET next_index=next_index+1 WHERE stage_id=?").run(value.stage_id);
      callback(input.authorize);
    });
  }
  function sealCheckpoint(input: { stage: CheckpointStage; authorize: Authorize }): CheckpointStage {
    const stage = structuredClone(input.stage);
    return tx(() => {
      callback(input.authorize); const value = row(stage);
      if (value.state === 2) throw new Error("Checkpoint is already active.");
      if (value.next_index !== Math.ceil(value.byte_length / CHECKPOINT_CHUNK_BYTES)) throw new Error("Checkpoint chunks are incomplete.");
      const hash = createHash("sha256");
      for (let index = 0; index < value.next_index; index++) { callback(input.authorize); hash.update(chunk(value, index)); }
      if (hash.digest("hex") !== value.sha256) throw new Error("Checkpoint integrity check failed.");
      db.prepare("UPDATE dohc_dataset_checkpoints SET state=1 WHERE stage_id=?").run(value.stage_id);
      callback(input.authorize); return manifest({ ...value, state: 1 });
    });
  }
  function storageBytes(length: number) { return length + Math.ceil(length / CHECKPOINT_CHUNK_BYTES) * 128 + 512; }
  function discard(value: StageRow, account?: (allocation: Readonly<CheckpointStageAllocation>) => unknown) {
    if (value.state === 2) throw new Error("Active checkpoints cannot be discarded.");
    if (value.reserved_bytes && !account) throw new Error("Discarding this checkpoint requires quota accounting.");
    const stage = manifest(value);
    if (account) callback(() => account(Object.freeze({ bytes: -value.reserved_bytes, scope: Object.freeze({ ...stage.scope }), stage })));
    db.prepare("DELETE FROM dohc_dataset_checkpoint_chunks WHERE stage_id=?").run(value.stage_id);
    db.prepare("DELETE FROM dohc_dataset_checkpoints WHERE stage_id=?").run(value.stage_id);
  }
  return {
    stageCheckpoint, appendCheckpointChunk, sealCheckpoint,
    /** Called only inside the journal's authorized permanent-deletion transaction. */
    destroy(key: DatasetScope) {
      db.prepare(`DELETE FROM dohc_dataset_checkpoint_chunks WHERE stage_id IN
        (SELECT stage_id FROM dohc_dataset_checkpoints WHERE workspace_id=? AND dataset_id=?)`).run(key.workspaceId,key.datasetId);
      db.prepare("DELETE FROM dohc_dataset_checkpoints WHERE workspace_id=? AND dataset_id=?").run(key.workspaceId,key.datasetId);
    },
    discardCheckpoint(input: { stage: CheckpointStage; authorize: Authorize; account?: (allocation: Readonly<CheckpointStageAllocation>) => unknown }) {
      if (input.account) synchronous(input.account);
      const stage = structuredClone(input.stage);
      tx(() => {
        callback(input.authorize); const value = row(stage);
        discard(value, input.account);
        callback(input.authorize);
      });
    },
    /** Startup only: the caller must exclusively own this store before admitting operations. */
    reclaimCheckpointStages(input: ReclaimCheckpointStagesInput) {
      synchronous(input.retain); synchronous(input.account);
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid checkpoint stage page size.");
      const stages = tx(() => {
        callback(input.authorize);
        return db.prepare("SELECT * FROM dohc_dataset_checkpoints WHERE state!=2 AND stage_id>? ORDER BY stage_id LIMIT ?")
          .all(input.after ?? "", limit).map(value => manifest(validateRow(value as StageRow)));
      });
      let reclaimed = 0;
      for (const stage of stages) tx(() => {
        callback(input.authorize);
        const value = row(stage);
        if (!callback(() => input.retain(Object.freeze(structuredClone(stage))))) {
          discard(value, input.account);
          reclaimed++;
        }
        callback(input.authorize);
      });
      return { reclaimed, after: stages.length === limit ? stages.at(-1)!.stageId : undefined };
    },
    checkpointStages(input: { workspaceId: string; after?: string; limit?: number; authorize: Authorize }) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid checkpoint stage page size.");
      return tx(() => { callback(input.authorize); return db.prepare("SELECT * FROM dohc_dataset_checkpoints WHERE workspace_id=? AND state!=2 AND stage_id>? ORDER BY stage_id LIMIT ?")
        .all(validText(input.workspaceId), input.after ?? "", limit).map(value => manifest(validateRow(value as StageRow))); });
    },
    resolve(key: DatasetScope, input: Uint8Array | CheckpointStage) {
      const value = input instanceof Uint8Array ? { expectedBytes: input.byteLength, sha256: digest(input), bytes: input } : input;
      if (input instanceof Uint8Array) {
        if (input.byteLength > maximumBytes) throw new Error("Checkpoint exceeds its size limit.");
        return { ...value, storageBytes: storageBytes(value.expectedBytes), stagedCreditBytes: 0 };
      }
      const stored = row(input);
      if (stored.workspace_id !== key.workspaceId || stored.dataset_id !== key.datasetId || stored.state === 0) throw new Error("Checkpoint is not sealed for this dataset.");
      return { ...value, stageId: stored.stage_id, storageBytes: storageBytes(stored.byte_length), stagedCreditBytes: stored.reserved_bytes };
    },
    activate(key: DatasetScope, input: Uint8Array | CheckpointStage): string {
      if (input instanceof Uint8Array) {
        const stageId = randomUUID(), count = Math.ceil(input.byteLength / CHECKPOINT_CHUNK_BYTES);
        db.prepare("INSERT INTO dohc_dataset_checkpoints VALUES(?,?,?,?,?,?,?,?)").run(stageId, key.workspaceId, key.datasetId, input.byteLength, digest(input), 2, 0, count);
        for (let offset = 0, index = 0; offset < input.byteLength; offset += CHECKPOINT_CHUNK_BYTES, index++) {
          const bytes = input.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES);
          db.prepare("INSERT INTO dohc_dataset_checkpoint_chunks VALUES(?,?,?,?)").run(stageId, index, bytes, digest(bytes));
        }
        return stageId;
      }
      const value = row(input);
      if (value.state !== 1 || value.workspace_id !== key.workspaceId || value.dataset_id !== key.datasetId) throw new Error("Checkpoint is not available for activation.");
      db.prepare("UPDATE dohc_dataset_checkpoints SET state=2,reserved_bytes=0 WHERE stage_id=?").run(value.stage_id);
      return value.stage_id;
    },
    info(key: DatasetScope, stageId: string) {
      const value = validateRow(db.prepare("SELECT * FROM dohc_dataset_checkpoints WHERE stage_id=? AND workspace_id=? AND dataset_id=? AND state=2")
        .get(stageId, key.workspaceId, key.datasetId) as StageRow | undefined);
      return manifest(value);
    },
    read(key: DatasetScope, stageId: string, offset: number, length: number): Uint8Array {
      const value = validateRow(db.prepare("SELECT * FROM dohc_dataset_checkpoints WHERE stage_id=? AND workspace_id=? AND dataset_id=? AND state=2")
        .get(stageId, key.workspaceId, key.datasetId) as StageRow | undefined);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.byte_length || !Number.isSafeInteger(length) || length < 0 || length > CHECKPOINT_CHUNK_BYTES) throw new Error("Invalid checkpoint range.");
      const end = Math.min(offset + length, value.byte_length), output = new Uint8Array(end - offset);
      for (let position = offset; position < end;) {
        const index = Math.floor(position / CHECKPOINT_CHUNK_BYTES), bytes = chunk(value, index), start = position % CHECKPOINT_CHUNK_BYTES;
        const count = Math.min(bytes.byteLength - start, end - position); output.set(bytes.subarray(start, start + count), position - offset); position += count;
      }
      return output;
    },
  };
}
