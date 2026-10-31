import type {StorageContext} from "./context";
import type {PutBlobResult, SqliteDb} from "./types";
import {type PutBlobInput, putBlobInTransaction} from "./blobs";

// The blobs a workspace's service host proved it holds by uploading them. A
// hosted write may name these whether or not any row it can read does. Proof
// lives as long as the blob it names, so the workspace quota bounds both, and
// ends early when the workspace stops being hosted and nothing in it settles.
export const SERVICE_HOST_UPLOADS = "sync_relay_service_host_uploads";
const MIGRATION = "service-host-uploads-v1";
const SQL = `CREATE TABLE ${SERVICE_HOST_UPLOADS} (
  workspace_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, sha256),
  FOREIGN KEY (workspace_id, sha256) REFERENCES sync_relay_blobs(workspace_id, sha256) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`;

export function initializeServiceHostUploadSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(MIGRATION);
  const existing = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_HOST_UPLOADS);
  if (!marked) {
    if (existing) throw new Error("Unmarked service host upload storage exists.");
    db.exec(SQL);
  } else if (!existing || existing.type !== "table" || typeof existing.sql !== "string" ||
    existing.sql.replace(/\s+/g, " ").trim() !== SQL.replace(/\s+/g, " ").trim()) throw new Error("Service host upload storage is damaged.");
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_HOST_UPLOADS})`).all();
  if (indexes.length !== 1 || indexes[0]!.unique !== 1 || indexes[0]!.partial !== 0 || indexes[0]!.origin !== "pk" ||
    db.prepare(`PRAGMA foreign_key_check(${SERVICE_HOST_UPLOADS})`).all().length ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_HOST_UPLOADS)) throw new Error("Service host upload constraints are damaged.");
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(MIGRATION, Date.now());
}

/** Stores the bytes and the host's proof of holding them in one commit. */
export function putServiceHostBlob(storage: StorageContext, input: PutBlobInput): PutBlobResult {
  return storage.tx(() => {
    const put = putBlobInTransaction(storage, input);
    storage.db.prepare(`INSERT OR IGNORE INTO ${SERVICE_HOST_UPLOADS}(workspace_id,sha256) VALUES (?,?)`).run(input.workspaceId, input.sha256);
    return put;
  });
}

export function serviceHostUploaded(storage: StorageContext, workspaceId: string, sha256: string): boolean {
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_UPLOADS} WHERE workspace_id=? AND sha256=?`).get(workspaceId, sha256) !== undefined;
}

export function forgetServiceHostUploads(storage: StorageContext, workspaceId: string): void {
  storage.db.prepare(`DELETE FROM ${SERVICE_HOST_UPLOADS} WHERE workspace_id=?`).run(workspaceId);
}
