import { createHash, randomBytes } from "node:crypto";
import { APP_BACKEND_OPERATION_FILES, appBackendFileSignatureMatches, parseAppBackendFile, parseAppBackendUploadRequest, type AppBackendFile, type AppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { DatasetAuthority } from "@dohc/app-backend-runtime/dataset-host";
import type { StorageContext } from "./context";
import { badRequest, notFound, relayError } from "../errors";

interface Scope { workspaceId: string; datasetId: string }
interface FileRow { metadata: string; principal_key: string; app_id: string; attached_revision: number | null; expires_at_ms: number }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

/** File bytes, journal commits and quota accounting share the relay's transaction. */
export function createDatasetFiles(storage: StorageContext, account: (workspaceId: string, datasetId: string, bytes: number) => void, nowMs: () => number) {
  storage.tx(() => storage.db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_dataset_files(
    workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,file_id TEXT NOT NULL,
    principal_key TEXT NOT NULL,app_id TEXT NOT NULL,retry_key TEXT NOT NULL,
    metadata TEXT NOT NULL,content BLOB NOT NULL,expires_at_ms INTEGER NOT NULL,
    attached_revision INTEGER,storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
    PRIMARY KEY(workspace_id,dataset_id,file_id),
    UNIQUE(workspace_id,dataset_id,principal_key,app_id,retry_key),
    FOREIGN KEY(workspace_id,dataset_id) REFERENCES sync_relay_dataset_usage(workspace_id,dataset_id) ON DELETE CASCADE) STRICT;
    CREATE INDEX IF NOT EXISTS sync_relay_dataset_files_staged ON sync_relay_dataset_files(workspace_id,dataset_id,expires_at_ms) WHERE attached_revision IS NULL;`));
  function read(scope: Scope, fileId: string): FileRow | undefined {
    if (!fileIdPattern.test(fileId)) throw badRequest("Invalid dataset file.");
    return storage.db.prepare("SELECT metadata,principal_key,app_id,attached_revision,expires_at_ms FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=?")
      .get(scope.workspaceId, scope.datasetId, fileId) as FileRow | undefined;
  }
  const usable = (row: FileRow, authority: DatasetAuthority) => (row.attached_revision !== null || row.expires_at_ms > nowMs()) &&
    (authority.caller.kind === "owner" || (row.principal_key === authority.principalKey && row.app_id === (authority.appId ?? "")));
  function bytes(scope: Scope, fileId: string, row: FileRow) {
    const file = parseAppBackendFile(JSON.parse(row.metadata));
    const content = storage.db.prepare("SELECT content FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=?").get(scope.workspaceId, scope.datasetId, fileId)!.content as Uint8Array;
    if (content.byteLength !== file.byteLength || digest(content) !== file.sha256) throw relayError("conflict", "File integrity check failed.");
    return {file, bytesBase64: Buffer.from(content).toString("base64")};
  }
  return {
    upload(scope: Scope, authority: DatasetAuthority, raw: AppBackendUploadRequest, authorize: () => void) {
      const input = parseAppBackendUploadRequest(raw), bytes = Buffer.from(input.bytesBase64, "base64"), sha256 = digest(bytes);
      if (!appBackendFileSignatureMatches(input.contentType, bytes)) throw badRequest("File content does not match its type.");
      return storage.tx(() => {
        authorize();
        const now = nowMs(), appId = authority.appId ?? "";
        const stale = storage.db.prepare("SELECT file_id,storage_bytes FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND attached_revision IS NULL AND expires_at_ms<=? LIMIT 128")
          .all(scope.workspaceId, scope.datasetId, now);
        for (const row of stale) {
          storage.db.prepare("DELETE FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND file_id=?").run(scope.workspaceId, scope.datasetId, String(row.file_id));
          account(scope.workspaceId, scope.datasetId, -Number(row.storage_bytes));
        }
        const existing = storage.db.prepare("SELECT metadata FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND principal_key=? AND app_id=? AND retry_key=?")
          .get(scope.workspaceId, scope.datasetId, authority.principalKey, appId, input.idempotencyKey);
        if (existing) {
          const file = parseAppBackendFile(JSON.parse(String(existing.metadata)));
          if (file.sha256 !== sha256 || file.name !== input.name || file.contentType !== input.contentType) throw relayError("conflict", "This retry key was already used for another upload.");
          authorize(); return {file, replayed: true};
        }
        const count = storage.db.prepare("SELECT count(*) AS count FROM sync_relay_dataset_files WHERE workspace_id=? AND dataset_id=? AND principal_key=? AND app_id=? AND attached_revision IS NULL")
          .get(scope.workspaceId, scope.datasetId, authority.principalKey, appId)!.count;
        if (Number(count) >= APP_BACKEND_OPERATION_FILES) throw relayError("conflict", "Submit pending uploads before uploading more files.");
        const file: AppBackendFile = {fileId: randomBytes(24).toString("base64url"), name: input.name, contentType: input.contentType, byteLength: bytes.byteLength, sha256};
        const metadata = JSON.stringify(file), storageBytes = bytes.byteLength + Buffer.byteLength(metadata) + Buffer.byteLength(authority.principalKey + appId + input.idempotencyKey) + 384;
        storage.db.prepare("INSERT INTO sync_relay_dataset_files VALUES(?,?,?,?,?,?,?,?,?,NULL,?)")
          .run(scope.workspaceId, scope.datasetId, file.fileId, authority.principalKey, appId, input.idempotencyKey, metadata, bytes, now + 86_400_000, storageBytes);
        account(scope.workspaceId, scope.datasetId, storageBytes);
        authorize(); return {file, replayed: false};
      });
    },
    resources(scope: Scope, authority: DatasetAuthority, input: unknown) {
      const ids = new Set<string>();
      function collect(value: unknown): void {
        if (typeof value === "string" && fileIdPattern.test(value)) ids.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      }
      collect(input);
      const files: AppBackendFile[] = [];
      for (const id of ids) { const row = read(scope, id); if (row && usable(row, authority)) files.push(parseAppBackendFile(JSON.parse(row.metadata))); }
      if (files.length > APP_BACKEND_OPERATION_FILES) throw badRequest(`An action can attach at most ${APP_BACKEND_OPERATION_FILES} files.`);
      const captured = new Set(files.map(file => file.fileId));
      return { files, accountAndAttach(allocation: {revision: number; bytes: number; attachedFileIds: readonly string[]}) {
        for (const fileId of allocation.attachedFileIds) {
          const row = read(scope, fileId);
          if (!captured.has(fileId) || !row || !usable(row, authority)) throw notFound();
          storage.db.prepare("UPDATE sync_relay_dataset_files SET attached_revision=coalesce(attached_revision,?) WHERE workspace_id=? AND dataset_id=? AND file_id=?")
            .run(allocation.revision, scope.workspaceId, scope.datasetId, fileId);
        }
        account(scope.workspaceId, scope.datasetId, allocation.bytes);
      }};
    },
    /** Call only from the host's authorized read-operation disclosure transaction. */
    readAttached(scope: Scope, fileId: string, result: unknown) {
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 || (result as {fileId?: unknown}).fileId !== fileId) throw notFound();
      const row = read(scope, fileId);
      if (!row || row.attached_revision === null) throw notFound();
      return bytes(scope, fileId, row);
    },
    /** The authenticated workspace owner can inspect pending as well as attached files. */
    readOwner(scope: Scope, fileId: string) {
      const row = read(scope, fileId);
      if (!row || (row.attached_revision === null && row.expires_at_ms <= nowMs())) throw notFound();
      return bytes(scope, fileId, row);
    },
  };
}
