import type {SqliteDb} from "./types";

export const RELEASE_CLAIM_MIGRATION = "service-host-release-claim-v1";
export const RELEASE_CLAIM_COLUMN = "release_claim_json TEXT CHECK (release_claim_json IS NULL OR json_valid(release_claim_json))";
export const RELEASE_TOMBSTONES = "sync_relay_release_tombstones";
const sql = `CREATE TABLE ${RELEASE_TOMBSTONES} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  release_digest TEXT NOT NULL CHECK (length(release_digest)=64 AND release_digest NOT GLOB '*[^0-9a-f]*'),
  claim_digest TEXT NOT NULL CHECK (length(claim_digest)=64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  publication_fenced INTEGER NOT NULL CHECK (publication_fenced IN (0,1)),
  PRIMARY KEY (workspace_id,object_id,release_digest),
  UNIQUE (workspace_id,object_id,claim_digest),
  FOREIGN KEY (workspace_id,object_id) REFERENCES sync_relay_service_host_enrollments(workspace_id,object_id) ON DELETE CASCADE
) STRICT`;
export function initializeReleaseClaimSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(RELEASE_CLAIM_MIGRATION);
  if (!marked) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(RELEASE_TOMBSTONES) ||
      db.prepare("PRAGMA table_info(sync_relay_service_host_enrollments)").all().some(row => row.name === "release_claim_json")) {
      throw new Error("Unmarked release claim storage exists.");
    }
    db.exec(`ALTER TABLE sync_relay_service_host_enrollments ADD COLUMN ${RELEASE_CLAIM_COLUMN}`);
    db.exec(sql);
  }
  const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(RELEASE_TOMBSTONES);
  const column = db.prepare("PRAGMA table_info(sync_relay_service_host_enrollments)").all().find(row => row.name === "release_claim_json");
  const indexes = db.prepare(`PRAGMA index_list(${RELEASE_TOMBSTONES})`).all();
  if (row?.type !== "table" || typeof row.sql !== "string" || row.sql.replace(/\s+/g," ").trim() !== sql.replace(/\s+/g," ").trim() ||
    !column || column.cid !== 13 || column.type !== "TEXT" || column.notnull !== 0 || column.dflt_value !== null || column.pk !== 0 ||
    indexes.length !== 2 || indexes.some(index => index.unique !== 1 || index.partial !== 0 || !["pk","u"].includes(String(index.origin))) ||
    db.prepare(`PRAGMA foreign_key_check(${RELEASE_TOMBSTONES})`).all().length ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(RELEASE_TOMBSTONES)) throw new Error("Release claim storage is damaged.");
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(RELEASE_CLAIM_MIGRATION,Date.now());
}
