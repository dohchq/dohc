import type {StorageContext} from "./context";
import type {SqliteDb} from "./types";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";

// The retirement of one exact service activation, recorded when Pause or the
// loss of its document's last Edit grant fenced live admission. It names the
// activation as the engine retires it, and admission stays fenced while it is
// recorded: Resume, a new share or a restored grant leaves it in place. An
// authority-reducing change must always commit, so it charges no quota; one
// activation holds at most one. No restore of the document begins while it is
// recorded, and a restore unfinished when it is recorded carries it to the
// restored generation as it resumes.
export const SERVICE_ACTIVATION_RETIREMENTS = "sync_relay_service_activation_retirements";
const MIGRATION = "service-activation-retirements-v1";
const SQL = `CREATE TABLE ${SERVICE_ACTIVATION_RETIREMENTS} (
  relay_database_namespace TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  restore_fence_generation INTEGER NOT NULL CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
  accepted_through INTEGER NOT NULL CHECK (accepted_through BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (relay_database_namespace,activation_id),
  UNIQUE (workspace_id,main_version_id,object_id,lineage_claim_id),
  FOREIGN KEY (relay_database_namespace,activation_id) REFERENCES ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id) ON DELETE CASCADE
) STRICT`;

export interface ServiceActivationRetirement {
  readonly relayDatabaseNamespace: string;
  readonly activationId: string;
  readonly workspaceId: string;
  readonly mainVersionId: "main";
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly restoreFenceGeneration: number;
  /** The live-journal cursor the fence closed at. */
  readonly acceptedThrough: number;
}

export function initializeServiceActivationRetirementSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(MIGRATION);
  const existing = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_ACTIVATION_RETIREMENTS);
  if (!marked) {
    if (existing) throw new Error("Unmarked service activation retirement storage exists.");
    db.exec(SQL);
  } else if (!existing || existing.type !== "table" || typeof existing.sql !== "string" ||
    existing.sql.replace(/\s+/g, " ").trim() !== SQL.replace(/\s+/g, " ").trim()) throw new Error("Service activation retirement storage is damaged.");
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_ACTIVATION_RETIREMENTS})`).all();
  if (indexes.length !== 2 || indexes.some(row => row.unique !== 1 || row.partial !== 0 || (row.origin !== "pk" && row.origin !== "u")) ||
    db.prepare(`PRAGMA foreign_key_check(${SERVICE_ACTIVATION_RETIREMENTS})`).all().length ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_ACTIVATION_RETIREMENTS)) {
    throw new Error("Service activation retirement constraints are damaged.");
  }
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(MIGRATION, Date.now());
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Service activation retirement is damaged.");
  return value;
}
function retirement(value: Record<string, unknown>): ServiceActivationRetirement {
  return Object.freeze({relayDatabaseNamespace: String(value.relay_database_namespace), activationId: String(value.activation_id),
    workspaceId: String(value.workspace_id), mainVersionId: "main", objectId: String(value.object_id), lineageClaimId: String(value.lineage_claim_id),
    restoreFenceGeneration: integer(value.restore_fence_generation), acceptedThrough: integer(value.accepted_through)});
}

/** The pending retirement of the document's activation, if one is recorded. */
export function readServiceActivationRetirement(storage: StorageContext, document: {workspaceId: string; objectId: string}): ServiceActivationRetirement | null {
  const value = storage.db.prepare(`SELECT * FROM ${SERVICE_ACTIVATION_RETIREMENTS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? LIMIT 1`)
    .get(document.workspaceId, document.objectId);
  return value ? retirement(value) : null;
}

/** Whether a retirement of the document's activation is pending. */
export function serviceActivationRetirementPending(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  return storage.db.prepare(`SELECT EXISTS(SELECT 1 FROM ${SERVICE_ACTIVATION_RETIREMENTS} WHERE workspace_id=? AND main_version_id='main' AND object_id=?) AS pending`)
    .get(document.workspaceId, document.objectId)!.pending === 1;
}

// The lineage's last journal cursor: what its live admission accepted through.
function acceptedThrough(storage: StorageContext, document: {workspaceId: string; objectId: string; lineageClaimId: string}): number {
  return integer(storage.db.prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`).get(document.workspaceId, document.objectId, document.lineageClaimId)!.cursor);
}

/**
 * Inside the transaction a restore resumes in, carries the pending retirement
 * of its lineage to the restored generation and the restore's own journal
 * cursor, which is the lineage's last, so the engine accepts its key.
 */
export function carryServiceActivationRetirement(storage: StorageContext, document: {workspaceId: string; objectId: string; lineageClaimId: string}, restoreFenceGeneration: number): void {
  storage.db.prepare(`UPDATE ${SERVICE_ACTIVATION_RETIREMENTS} SET restore_fence_generation=?,accepted_through=?
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`)
    .run(integer(restoreFenceGeneration), acceptedThrough(storage, document), document.workspaceId, document.objectId, document.lineageClaimId);
}

/**
 * Records, inside the caller's transaction, the retirement of the activation
 * of the document's current lineage, keyed as the engine retires it. A
 * recorded retirement stays as it was. Null when the document has no activation.
 */
export function retireServiceActivation(storage: StorageContext, document: {workspaceId: string; objectId: string}): ServiceActivationRetirement | null {
  const activation = storage.db.prepare(`SELECT a.relay_database_namespace,a.activation_id,a.lineage_claim_id,d.restore_fence_generation FROM ${SERVICE_ACTIVATIONS} a
    JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
    WHERE a.workspace_id=? AND a.main_version_id='main' AND a.object_id=? AND d.lineage_state='current'`).get(document.workspaceId, document.objectId);
  if (!activation) return null;
  const lineageClaimId = String(activation.lineage_claim_id);
  storage.db.prepare(`INSERT OR IGNORE INTO ${SERVICE_ACTIVATION_RETIREMENTS}(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
    restore_fence_generation,accepted_through) VALUES (?,?,?,'main',?,?,?,?)`)
    .run(activation.relay_database_namespace, activation.activation_id, document.workspaceId, document.objectId, lineageClaimId,
      integer(activation.restore_fence_generation), acceptedThrough(storage, {...document, lineageClaimId}));
  const recorded = storage.db.prepare(`SELECT * FROM ${SERVICE_ACTIVATION_RETIREMENTS} WHERE relay_database_namespace=? AND activation_id=?`)
    .get(activation.relay_database_namespace, activation.activation_id);
  if (!recorded) throw new Error("Service activation retirement is damaged.");
  return retirement(recorded);
}
