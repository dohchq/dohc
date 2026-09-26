import { randomUUID } from "node:crypto";
import type { DatasetCursor, DatasetJournal, DatasetScope, JournalDb, JournalExportRecord, CheckpointStage } from "./journal.js";
import { readValidatedBlob, type ValidatedDatasetRecovery, type RecoveryBlob } from "./recovery-import.js";
import type { RecoveryAttachment } from "./recovery-export.js";
import { initializeDatasetAttempts, cancelledDatasetAttemptBytes } from "./dataset-attempts.js";

export interface RecoveryImportReceipt {
  transferId: string;
  manifestSha256: string;
  sourceCursor: DatasetCursor;
  targetCursor?: DatasetCursor;
}
export interface RecoveryInstallOptions<Context> {
  db: JournalDb;
  transaction<T>(run: () => T): T;
  journal: DatasetJournal;
  /** Same signed retained-byte counter used by checkpoint staging and journal commits. */
  /** Trusted local disaster recovery only. Never enable on shared replica or relay adapters. */
  allowOwnerRecoveryClaim?: boolean;
  account?(context: Context, allocation: DatasetScope & { bytes: number; capacityDeltaBytes: number }): void;
  installAttachment?(context: Context, input: DatasetScope & { importId: string; file: RecoveryAttachment; stream: AsyncIterable<Uint8Array> }): Promise<void>;
  /** Commit all staged files and associations in the install transaction. */
  commitAttachments?(context: Context, input: DatasetScope & { importId: string }): void;
  discardAttachments?(context: Context, input: DatasetScope & { importId: string }): Promise<void>;
}
const same = (a: DatasetCursor, b: DatasetCursor) => a.workspaceId === b.workspaceId && a.datasetId === b.datasetId && a.hostEpoch === b.hostEpoch && a.approvedRevisionHash === b.approvedRevisionHash && a.revision === b.revision && a.digest === b.digest;
function sync<T>(fn: () => T): T {
  if (fn.constructor.name === "AsyncFunction") throw new Error("Recovery callbacks must be synchronous.");
  const value = fn();
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) throw new Error("Recovery callbacks must be synchronous.");
  return value;
}
function identity(value: string) { if (typeof value !== "string" || !value.length || value.includes("\0") || Buffer.byteLength(value) > 256) throw new Error("Invalid recovery import identity."); return value; }

/** Private staging is durable and charged before the absent dataset becomes visible, inactive. */
export function createRecoveryInstaller<Context>(options: RecoveryInstallOptions<Context>) {
  const { db, journal } = options;
  const tx = <T>(run: () => T): T => sync(() => options.transaction(() => sync(run)));
  tx(() => initializeDatasetAttempts(db));
  tx(() => db.exec(`
    CREATE TABLE IF NOT EXISTS dohc_dataset_imports(
      import_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,
      source_json TEXT NOT NULL,target_json TEXT,phase TEXT NOT NULL,owner_token TEXT NOT NULL,
      retained_bytes INTEGER NOT NULL,head_json TEXT,UNIQUE(workspace_id,dataset_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_recovered_permissions(import_id TEXT NOT NULL,body TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_import_records(
      import_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,
      blob BLOB,stage_json TEXT,storage_bytes INTEGER NOT NULL,PRIMARY KEY(import_id,revision)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_import_metadata(
      import_id TEXT NOT NULL,seq INTEGER PRIMARY KEY,body TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_import_checkpoints(
      import_id TEXT NOT NULL,stage_id TEXT PRIMARY KEY,stage_json TEXT NOT NULL,role TEXT NOT NULL) STRICT;
  `));
  function account(context: Context, scope: DatasetScope, bytes: number, capacityDeltaBytes = 0) {
    if (options.account) sync(() => options.account!(context, { ...scope, bytes, capacityDeltaBytes }));
  }
  function receipt(row: Record<string, unknown>): RecoveryImportReceipt {
    return { transferId: String(row.import_id), manifestSha256: String(row.manifest_hash), sourceCursor: JSON.parse(String(row.source_json)),
      ...(row.target_json ? { targetCursor: JSON.parse(String(row.target_json)) } : {}) };
  }
  function find(scope: DatasetScope, transferId: string, authorize: () => void) {
    journal.assertNotDeleted(scope,authorize); return db.prepare("SELECT * FROM dohc_dataset_imports WHERE import_id=? AND workspace_id=? AND dataset_id=?").get(identity(transferId), scope.workspaceId, scope.datasetId);
  }
  async function discard(context: Context, input: DatasetScope & { transferId: string; authorize(): void }) {
    const row = tx(() => {
      const row = find(input, input.transferId, input.authorize);
      if (!row) return;
      if (row.phase === "installed" || row.phase === "claimed") throw new Error("Installed recovery cannot be discarded.");
      db.prepare("UPDATE dohc_dataset_imports SET phase='discarding' WHERE import_id=?").run(input.transferId);
      return row;
    });
    if (!row) return;
    if (options.discardAttachments) await options.discardAttachments(context, { ...input, importId: input.transferId });
    // One manifest at a time; never load all checkpoint or metadata bodies into memory.
    for (;;) {
      input.authorize();
      const checkpoint = db.prepare("SELECT stage_json FROM dohc_dataset_import_checkpoints WHERE import_id=? LIMIT 1").get(input.transferId);
      if (!checkpoint) break;
      const stage = JSON.parse(String(checkpoint.stage_json)) as CheckpointStage;
      journal.discardCheckpoint({ stage, authorize: input.authorize, account(allocation) {
        account(context, input, allocation.bytes);
        db.prepare("DELETE FROM dohc_dataset_import_checkpoints WHERE stage_id=? AND import_id=?").run(stage.stageId, input.transferId);
      } });
    }
    tx(() => {
      const current = find(input, input.transferId, input.authorize);
      if (!current || current.phase !== "discarding") throw new Error("Recovery cleanup changed.");
      account(context, input, -Number(current.retained_bytes));
      db.prepare("DELETE FROM dohc_dataset_import_records WHERE import_id=?").run(input.transferId);
      db.prepare("DELETE FROM dohc_dataset_import_metadata WHERE import_id=?").run(input.transferId);
      db.prepare("DELETE FROM dohc_dataset_imports WHERE import_id=?").run(input.transferId);
      input.authorize();
    });
  }
  return {
    discard,
    claim(context: Context, input: DatasetScope & { transferId: string; manifestSha256: string; sourceCursor: DatasetCursor; oldHostStopped?: true; authorize(): void }): RecoveryImportReceipt {
      const row = tx(() => find(input, input.transferId, input.authorize));
      if (!row || (row.phase !== "installed" && row.phase !== "claimed") || row.manifest_hash !== input.manifestSha256 || !same(JSON.parse(String(row.source_json)), input.sourceCursor)) throw new Error("Recovery transfer is not installed with this identity.");
      if (row.phase === "claimed") return receipt(row);
      const head = JSON.parse(String(row.head_json)) as ValidatedDatasetRecovery["headCheckpoint"] & { stage: CheckpointStage; sourceState: string };
      if (head.sourceState !== "fenced" && !(options.allowOwnerRecoveryClaim && input.oldHostStopped === true)) throw new Error("Stop the old host before moving this Collection.");
      journal.claimInactiveCheckpoint({ expected: input.sourceCursor, hostEpoch: randomUUID(), approvedRevisionHash: input.sourceCursor.approvedRevisionHash,
        source: head.source, schemaSql: head.schemaSql, definitionJson: head.definitionJson, capacityBytes: head.capacityBytes, checkpoint: head.stage, authorize: input.authorize,
        account(allocation) {
          const current = find(input, input.transferId, input.authorize);
          if (!current || current.phase !== "installed" || current.manifest_hash !== input.manifestSha256) throw new Error("Recovery transfer claim changed.");
          account(context, input, allocation.bytes - allocation.stagedCreditBytes, allocation.capacityDeltaBytes);
          db.prepare("UPDATE dohc_dataset_imports SET phase='claimed',target_json=?,head_json=NULL WHERE import_id=?").run(JSON.stringify(allocation.cursor), input.transferId);
          db.prepare("DELETE FROM dohc_dataset_import_checkpoints WHERE import_id=?").run(input.transferId);
        } });
      return tx(() => { const claimed = find(input, input.transferId, input.authorize); if (!claimed || claimed.phase !== "claimed") throw new Error("Recovery claim acknowledgement is missing."); return receipt(claimed); });
    },
    status(input: DatasetScope & { transferId: string; authorize(): void }): RecoveryImportReceipt | null {
      return tx(() => { const row = find(input, input.transferId, input.authorize); return row && (row.phase === "installed" || row.phase === "claimed") ? receipt(row) : null; });
    },
    async install(context: Context, input: { transferId: string; manifestSha256: string; recovery: ValidatedDatasetRecovery; authorize(): void }): Promise<RecoveryImportReceipt> {
      const { recovery } = input, scope = { workspaceId: recovery.manifest.cursor.workspaceId, datasetId: recovery.manifest.cursor.datasetId };
      const importId = identity(input.transferId), ownerToken = randomUUID();
      if (!/^[a-f0-9]{64}$/.test(input.manifestSha256)) throw new Error("Invalid recovery manifest digest.");
      const prior = tx(() => {
        journal.assertNotDeleted(scope,input.authorize); const previous = db.prepare("SELECT * FROM dohc_dataset_imports WHERE import_id=?").get(importId);
        if (previous) {
          if (previous.workspace_id !== scope.workspaceId || previous.dataset_id !== scope.datasetId || previous.manifest_hash !== input.manifestSha256 || !same(JSON.parse(String(previous.source_json)), recovery.manifest.cursor)) throw new Error("Recovery import identity conflicts.");
          if (previous.phase !== "installed" && previous.phase !== "claimed") throw new Error("Recovery import is incomplete; discard it before retrying.");
          return receipt(previous);
        }
        if (db.prepare("SELECT 1 FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(scope.workspaceId, scope.datasetId)) throw new Error("This Collection already exists. Recovery does not replace existing data.");
        const bytes = Buffer.byteLength(JSON.stringify(recovery.manifest.cursor)) + 2048;
        account(context, scope, bytes);
        db.prepare("INSERT INTO dohc_dataset_imports VALUES(?,?,?,?,?,NULL,'staging',?,?,NULL)").run(importId, scope.workspaceId, scope.datasetId, input.manifestSha256, JSON.stringify(recovery.manifest.cursor), ownerToken, bytes);
        input.authorize(); return null;
      });
      if (prior) return prior;
      const authorize = () => {
        input.authorize(); const row = db.prepare("SELECT phase,owner_token FROM dohc_dataset_imports WHERE import_id=?").get(importId);
        if (!row || row.phase !== "staging" || row.owner_token !== ownerToken) throw new Error("Recovery staging was cancelled.");
      };
      const retain = (bytes: number) => { account(context, scope, bytes); db.prepare("UPDATE dohc_dataset_imports SET retained_bytes=retained_bytes+? WHERE import_id=?").run(bytes, importId); };
      async function checkpoint(blob: RecoveryBlob, sha256: string, role: string) {
        const stage = journal.stageCheckpoint({ scope, expectedBytes: blob.byteLength, sha256, authorize, account(allocation) {
          account(context, scope, allocation.bytes);
          db.prepare("INSERT INTO dohc_dataset_import_checkpoints VALUES(?,?,?,?)").run(importId, allocation.stage.stageId, JSON.stringify(allocation.stage), role);
        } });
        let index = 0;
        for await (const bytes of readValidatedBlob(blob)) { authorize(); journal.appendCheckpointChunk({ stage, index: index++, bytes, authorize }); }
        const sealed = journal.sealCheckpoint({ stage, authorize });
        tx(() => { authorize(); db.prepare("UPDATE dohc_dataset_import_checkpoints SET stage_json=? WHERE stage_id=?").run(JSON.stringify(sealed), stage.stageId); });
        return sealed;
      }
      try {
        let count = 0;
        for (const item of recovery.records()) {
          if (item.record.kind === "checkpoint" && same(item.record.cursor, recovery.manifest.checkpoint)) continue;
          authorize(); const body = JSON.stringify(item.record);
          let stage: CheckpointStage | undefined, blob: Uint8Array | null = null;
          const record = item.record;
          if (record.kind === "checkpoint") stage = await checkpoint(item.blob, record.sha256, "history");
          else {
            if (item.blob.byteLength > 16 * 1024 * 1024) throw new Error("Recovery event exceeds its limit.");
            blob = new Uint8Array(item.blob.byteLength); let offset = 0;
            for await (const bytes of readValidatedBlob(item.blob)) { authorize(); blob.set(bytes, offset); offset += bytes.byteLength; }
          }
          const storageBytes = Buffer.byteLength(body) * 2 + (blob?.byteLength ?? 0) + 2048;
          if (record.kind === "event" && storageBytes > 16 * 1024 * 1024) throw new Error("Recovery event metadata exceeds its limit.");
          tx(() => { authorize(); retain(storageBytes);
            db.prepare("INSERT INTO dohc_dataset_import_records VALUES(?,?,?,?,?,?,?)").run(importId, record.cursor.revision, record.kind, body, blob, stage ? JSON.stringify(stage) : null, storageBytes);
          });
          if (++count > 1_000_000) throw new Error("Recovery has too many records.");
        }
        const current = recovery.checkpoint;
        if (current.record.kind !== "checkpoint") throw new Error("This recovery file has no saved records.");
        const currentStage = await checkpoint(current.blob, current.record.sha256, "current");
        const headStage = await checkpoint(recovery.headCheckpoint.blob, recovery.headCheckpoint.sha256, "head");
        const headJson = JSON.stringify({ ...recovery.headCheckpoint, blob: undefined, stage: headStage, sourceState: recovery.manifest.sourceState });
        tx(() => { authorize(); retain(Buffer.byteLength(headJson) + Buffer.byteLength(JSON.stringify(recovery.catalog)) + 1024);
          db.prepare("UPDATE dohc_dataset_imports SET head_json=? WHERE import_id=?").run(headJson, importId); });
        for (const metadata of recovery.metadata()) {
          const body = JSON.stringify(metadata);
          tx(() => { authorize(); retain(Buffer.byteLength(body) + 512); db.prepare("INSERT INTO dohc_dataset_import_metadata(import_id,body) VALUES(?,?)").run(importId, body); });
        }
        for (const attachment of recovery.attachments()) {
          authorize();
          if (!options.installAttachment || !options.commitAttachments || !options.discardAttachments) throw new Error("This host cannot restore recovery attachments.");
          // Wrapping the stream ensures an adapter cannot silently skip verification.
          let consumed = false;
          const stream = (async function* () { for await (const bytes of readValidatedBlob(attachment.blob)) { authorize(); yield bytes; } consumed = true; })();
          await options.installAttachment(context, { ...scope, importId, file: attachment.file, stream });
          if (!consumed) throw new Error("Recovery attachment was not fully installed.");
        }
        return tx(() => {
          authorize(); const c = recovery.manifest.cursor, cp = current.record as Extract<JournalExportRecord, { kind: "checkpoint" }>;
          if (db.prepare("SELECT 1 FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?").get(scope.workspaceId, scope.datasetId)) throw new Error("This Collection already exists. Recovery does not replace existing data.");
          account(context, scope, recovery.headCheckpoint.capacityBytes, recovery.headCheckpoint.capacityBytes);
          const incomplete = db.prepare("SELECT 1 FROM dohc_dataset_import_checkpoints m JOIN dohc_dataset_checkpoints c ON c.stage_id=m.stage_id WHERE m.import_id=? AND (c.state!=1 OR c.workspace_id!=? OR c.dataset_id!=?) LIMIT 1").get(importId, scope.workspaceId, scope.datasetId);
          if (incomplete) throw new Error("dohc did not finish copying this recovery file's records. Try again.");
          db.prepare("UPDATE dohc_dataset_checkpoints SET state=2,reserved_bytes=0 WHERE stage_id IN(SELECT stage_id FROM dohc_dataset_import_checkpoints WHERE import_id=? AND role!='head')").run(importId);
          db.prepare("INSERT INTO dohc_dataset_journals VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)").run(scope.workspaceId, scope.datasetId, c.hostEpoch, c.approvedRevisionHash, cp.source, cp.schemaSql, cp.definitionJson, c.revision, c.digest, cp.capacityBytes, currentStage.stageId, cp.sha256, cp.cursor.revision, cp.cursor.digest, cp.previous ? JSON.stringify(cp.previous) : null);
          db.prepare(`INSERT INTO dohc_dataset_checkpoint_history SELECT ?,?,revision,json_extract(body,'$.cursor'),json_extract(body,'$.previous'),json_extract(body,'$.source'),json_extract(body,'$.schemaSql'),json_extract(body,'$.definitionJson'),json_extract(body,'$.capacityBytes'),json_extract(stage_json,'$.stageId'),json_extract(body,'$.sha256') FROM dohc_dataset_import_records WHERE import_id=? AND kind='checkpoint'`).run(scope.workspaceId, scope.datasetId, importId);
          db.prepare(`INSERT INTO dohc_dataset_events SELECT ?,?,revision,json_extract(body,'$.previousDigest'),json_extract(body,'$.cursor.digest'),json_extract(body,'$.cursor.hostEpoch'),json_extract(body,'$.cursor.approvedRevisionHash'),json_extract(body,'$.proposalId'),json_extract(body,'$.operation'),json_extract(body,'$.callerKey'),json_extract(body,'$.idempotencyKey'),json_extract(body,'$.payloadSha256'),json_extract(body,'$.resultJson'),blob,json_extract(body,'$.changesetSha256'),json_extract(body,'$.attachedFileIds'),json_extract(body,'$.recordedAtMs'),storage_bytes FROM dohc_dataset_import_records WHERE import_id=? AND kind='event'`).run(scope.workspaceId, scope.datasetId, importId);
          db.prepare(`INSERT INTO dohc_dataset_receipts SELECT workspace_id,dataset_id,caller_key,idempotency_key,payload_sha256,revision,result_json FROM dohc_dataset_events WHERE workspace_id=? AND dataset_id=?`).run(scope.workspaceId, scope.datasetId);
          db.prepare("INSERT INTO dohc_dataset_catalog VALUES(?,?,?,?)").run(scope.workspaceId, scope.datasetId, recovery.catalog.revisionJson, recovery.catalog.artifactsJson);
          db.prepare(`INSERT INTO dohc_dataset_catalog_history SELECT ?,?,json_extract(json_extract(body,'$.revisionJson'),'$.revision'),json_extract(body,'$.revisionJson'),json_extract(body,'$.artifactsJson') FROM dohc_dataset_import_metadata WHERE import_id=? AND json_extract(body,'$.kind')='catalog-revision'`).run(scope.workspaceId, scope.datasetId, importId);
          if (options.allowOwnerRecoveryClaim) {
            db.prepare("INSERT INTO dohc_dataset_recovered_permissions SELECT import_id,body FROM dohc_dataset_import_metadata WHERE import_id=? AND json_extract(body,'$.kind') IN ('binding','grant')").run(importId);
          } else {
          db.prepare(`INSERT INTO dohc_dataset_bindings SELECT ?,?,json_extract(body,'$.appId'),json_extract(body,'$.bindingJson'),json_extract(body,'$.token') FROM dohc_dataset_import_metadata WHERE import_id=? AND json_extract(body,'$.kind')='binding'`).run(scope.workspaceId, scope.datasetId, importId);
          db.prepare(`INSERT INTO dohc_dataset_data_grants SELECT ?,?,json_extract(body,'$.principalKey'),json_extract(body,'$.grantJson'),json_extract(body,'$.token') FROM dohc_dataset_import_metadata WHERE import_id=? AND json_extract(body,'$.kind')='grant'`).run(scope.workspaceId, scope.datasetId, importId);
          }
          db.prepare(`INSERT INTO dohc_dataset_lifecycle SELECT ?,?,json_extract(body,'$.archived'),json_extract(body,'$.generation'),json_extract(body,'$.reason'),json_extract(body,'$.archivedAtMs') FROM dohc_dataset_import_metadata WHERE import_id=? AND json_extract(body,'$.kind')='lifecycle'`).run(scope.workspaceId, scope.datasetId, importId);
          for (const row of db.prepare("SELECT body FROM dohc_dataset_import_metadata WHERE import_id=? AND json_extract(body,'$.kind')='attempt'").all(importId)) {
            const m = JSON.parse(String(row.body)) as Extract<import("./recovery-import.js").RecoveryMetadata, {kind: "attempt"}>;
            const json = JSON.stringify({attempt: m.attempt});
            const bytes = Buffer.byteLength(json) + [scope.workspaceId, scope.datasetId, m.appId, m.principalKey, m.operationId].reduce((sum, part) => sum + Buffer.byteLength(part), 0) + 512;
            // Metadata staging already reserved its body; charge only the final storage difference.
            account(context, scope, bytes - Buffer.byteLength(String(row.body)) - 512);
            db.prepare("INSERT INTO dohc_dataset_attempts VALUES(?,?,?,?,?,?,?,?)").run(scope.workspaceId, scope.datasetId, m.appId, m.principalKey, m.operationId, m.revisionSha256, json, bytes);
          }
          let cancelledAfter = 0;
          for (;;) {
            const rows = db.prepare("SELECT rowid,body FROM dohc_dataset_import_metadata WHERE import_id=? AND rowid>? AND json_extract(body,'$.kind')='cancelled-attempt' ORDER BY rowid LIMIT 64").all(importId, cancelledAfter);
            if (!rows.length) break;
            for (const row of rows) {
              const m = JSON.parse(String(row.body)) as Extract<import("./recovery-import.js").RecoveryMetadata, {kind: "cancelled-attempt"}>;
              const bytes = cancelledDatasetAttemptBytes(scope);
              account(context, scope, bytes - Buffer.byteLength(String(row.body)) - 512);
              db.prepare("INSERT INTO dohc_dataset_cancelled_attempts VALUES(?,?,?,?,?)").run(scope.workspaceId, scope.datasetId, m.retrySha256, m.reference, bytes);
              cancelledAfter = Number(row.rowid);
            }
          }
          if (options.commitAttachments) sync(() => options.commitAttachments!(context, { ...scope, importId }));
          db.prepare("UPDATE dohc_dataset_imports SET phase='installed' WHERE import_id=?").run(importId);
          db.prepare("DELETE FROM dohc_dataset_import_records WHERE import_id=?").run(importId);
          db.prepare("DELETE FROM dohc_dataset_import_metadata WHERE import_id=?").run(importId);
          db.prepare("DELETE FROM dohc_dataset_import_checkpoints WHERE import_id=? AND role!='head'").run(importId);
          input.authorize(); return { transferId: importId, manifestSha256: input.manifestSha256, sourceCursor: { ...c } };
        });
      } catch (error) {
        // A host transaction may commit and lose its acknowledgement. Never delete committed lineage.
        const row = db.prepare("SELECT * FROM dohc_dataset_imports WHERE import_id=?").get(importId);
        if (row && (row.phase === "installed" || row.phase === "claimed")) { input.authorize(); return receipt(row); }
        try { await discard(context, { ...scope, transferId: importId, authorize: input.authorize }); } catch { /* Durable ownership rows allow an authorized cleanup retry. */ }
        throw error;
      }
    },
  };
}
