import type {SqliteDb} from "./types";

export const ORDINARY_ACTIVATION_BASES="sync_relay_live_document_ordinary_bases";
const marker="ordinary-live-baseline-v1";
const schema=`CREATE TABLE ${ORDINARY_ACTIVATION_BASES} (
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  base_relay_seq INTEGER NOT NULL CHECK (base_relay_seq BETWEEN 1 AND 9007199254740991),
  base_origin_id TEXT NOT NULL,
  base_origin_seq INTEGER NOT NULL CHECK (base_origin_seq BETWEEN 0 AND 9007199254740991),
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  current_path TEXT NOT NULL,
  projected_sha256 TEXT NOT NULL CHECK (length(projected_sha256)=64 AND projected_sha256 NOT GLOB '*[^0-9a-f]*'),
  projected_byte_length INTEGER NOT NULL CHECK (projected_byte_length BETWEEN 0 AND 2097152),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (workspace_id,main_version_id,object_id,lineage_claim_id),
  FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
    REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
) STRICT`;
export function initializeOrdinaryActivationBasis(db:SqliteDb){
  const marked=db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker);
  const row=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(ORDINARY_ACTIVATION_BASES);
  if(!marked){if(row)throw new Error("Unmarked ordinary activation basis exists.");db.exec(schema);}
  else if(!row||row.type!=="table"||typeof row.sql!=="string"||row.sql.replace(/\s+/g," ").trim()!==schema.replace(/\s+/g," ").trim())throw new Error("Ordinary activation basis is damaged.");
  const indexes=db.prepare(`PRAGMA index_list(${ORDINARY_ACTIVATION_BASES})`).all();
  if(indexes.length!==1||indexes[0]!.unique!==1||indexes[0]!.partial!==0||indexes[0]!.origin!=="pk"||
    db.prepare(`PRAGMA foreign_key_check(${ORDINARY_ACTIVATION_BASES})`).all().length||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(ORDINARY_ACTIVATION_BASES))throw new Error("Ordinary activation basis constraints are damaged.");
  if(!marked)db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(marker,Date.now());
}

export function readOrdinaryActivationBasis(db:SqliteDb,document:{workspaceId:string;mainVersionId:string;objectId:string;lineageClaimId:string}){
  return db.prepare(`SELECT * FROM ${ORDINARY_ACTIVATION_BASES} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`)
    .get(document.workspaceId,document.mainVersionId,document.objectId,document.lineageClaimId);
}
