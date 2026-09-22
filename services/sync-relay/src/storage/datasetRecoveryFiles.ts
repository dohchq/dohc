import { createHash } from "node:crypto";
import { APP_BACKEND_UPLOAD_BYTES, appBackendFileSignatureMatches, parseAppBackendFile } from "@dohc/security-contract/app-backend";
import type { DatasetScope, DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { RecoveryAttachment } from "@dohc/app-backend-runtime/recovery-export";
import type { StorageContext } from "./context";

interface ImportFile extends DatasetScope {importId: string; file: RecoveryAttachment; stream: AsyncIterable<Uint8Array>}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Imports keep file bytes private until their journal and catalog become visible together. */
export function createDatasetRecoveryFiles(storage: StorageContext, account: (scope: DatasetScope, bytes: number) => void, authorize: (scope: DatasetScope) => void) {
  storage.tx(() => storage.db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_dataset_import_files(
    import_id TEXT NOT NULL,workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,file_id TEXT NOT NULL,
    metadata TEXT NOT NULL,content BLOB NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
    storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),PRIMARY KEY(import_id,file_id)) STRICT;
    CREATE INDEX IF NOT EXISTS sync_relay_dataset_import_files_scope ON sync_relay_dataset_import_files(workspace_id,dataset_id,import_id);`));
  return {
    capture(scope: DatasetScope, cursor: DatasetCursor): RecoveryAttachment[] {
      authorize(scope);
      const rows = storage.db.prepare("SELECT metadata,attached_revision FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND attached_revision IS NOT NULL AND attached_revision<=? ORDER BY file_id LIMIT 4097")
        .all(scope.workspaceId, scope.datasetId, cursor.revision);
      if (rows.length > 4096) throw new Error("Dataset recovery contains too many attachments.");
      return rows.map(row => ({...parseAppBackendFile(JSON.parse(String(row.metadata))), revision: Number(row.attached_revision)}));
    },
    async *open(scope: DatasetScope, file: RecoveryAttachment) {
      for (let offset = 0; offset < file.byteLength; offset += 1024 * 1024) {
        authorize(scope);
        const row = storage.db.prepare("SELECT substr(content,?,?) AS bytes FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=? AND attached_revision=?")
          .get(offset + 1, Math.min(1024 * 1024, file.byteLength - offset), scope.workspaceId, scope.datasetId, file.fileId, file.revision);
        if (!row || !(row.bytes instanceof Uint8Array)) throw new Error("Dataset attachment is unavailable.");
        yield row.bytes;
      }
    },
    async install(input: ImportFile) {
      authorize(input);
      const {revision, ...raw} = input.file, file = parseAppBackendFile(raw);
      if (!Number.isSafeInteger(revision) || revision < 1 || file.byteLength > APP_BACKEND_UPLOAD_BYTES) throw new Error("Dataset attachment exceeds the host limit.");
      const metadata = JSON.stringify(file), bytes = new Uint8Array(file.byteLength);
      let offset = 0;
      for await (const chunk of input.stream) {
        authorize(input);
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1024 * 1024 || offset + chunk.byteLength > bytes.byteLength) throw new Error("Dataset attachment stream exceeds its declared length.");
        bytes.set(chunk, offset); offset += chunk.byteLength;
      }
      if (offset !== bytes.byteLength || digest(bytes) !== file.sha256 || !appBackendFileSignatureMatches(file.contentType, bytes)) throw new Error("Dataset attachment integrity check failed.");
      storage.tx(() => {
        authorize(input);
        const storageBytes = bytes.byteLength + Buffer.byteLength(metadata) + Buffer.byteLength(input.importId) + 640;
        account(input, storageBytes);
        storage.db.prepare("INSERT INTO sync_relay_dataset_import_files VALUES(?,?,?,?,?,?,?,?)")
          .run(input.importId, input.workspaceId, input.datasetId, file.fileId, metadata, bytes, revision, storageBytes);
        authorize(input);
      });
    },
    /** Runs inside the installer's journal/catalog commit transaction. Bytes stay charged. */
    commit(input: DatasetScope & {importId: string}) {
      authorize(input);
      storage.db.prepare(`INSERT INTO sync_relay_dataset_files(workspace_id,dataset_id,file_id,principal_key,app_id,retry_key,metadata,content,expires_at_ms,attached_revision,storage_bytes)
        SELECT workspace_id,dataset_id,file_id,'recovery','',file_id,metadata,content,0,revision,storage_bytes FROM sync_relay_dataset_import_files WHERE import_id=? AND workspace_id=? AND dataset_id=?`)
        .run(input.importId, input.workspaceId, input.datasetId);
      storage.db.prepare("DELETE FROM sync_relay_dataset_import_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").run(input.importId, input.workspaceId, input.datasetId);
    },
    async discard(input: DatasetScope & {importId: string}) {
      storage.tx(() => {
        authorize(input);
        const bytes = Number(storage.db.prepare("SELECT coalesce(sum(storage_bytes),0) AS bytes FROM sync_relay_dataset_import_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").get(input.importId, input.workspaceId, input.datasetId)!.bytes);
        if (bytes) account(input, -bytes);
        storage.db.prepare("DELETE FROM sync_relay_dataset_import_files WHERE import_id=? AND workspace_id=? AND dataset_id=?").run(input.importId, input.workspaceId, input.datasetId);
      });
    },
  };
}
