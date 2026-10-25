import type {StorageContext} from "./context";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {LIVE_JOURNAL_TABLE} from "./schema";

// The retirement of one exact service activation, recorded on its row when
// Pause, Stop, the loss of its document's last Edit grant, or a Resume of a
// document held for an unadmitted edit fences live admission. It names the
// activation as the engine retires it. Once recorded it stays, and admission
// stays fenced, until the activation retires: Resume, a new share or a
// restored grant leaves it in place. A restore that fences the document
// carries it to the fenced generation, and its admission to the restore's
// accepted cursor. An authority-reducing change must
// always commit, so it charges no quota; its three integers are fixed-size
// row columns.
export interface ServiceActivationRetirement {
  readonly relayDatabaseNamespace: string;
  readonly activationId: string;
  readonly workspaceId: string;
  readonly mainVersionId: "main";
  readonly objectId: string;
  readonly lineageClaimId: string;
  /** The activation's bound path. */
  readonly path: string;
  readonly restoreFenceGeneration: number;
  /** F: the live-journal cursor the fence closed at. */
  readonly acceptedThrough: number;
  readonly requestedAtMs: number;
}

/** The exact activation a retirement names to the engine. */
export interface RetirementKey {
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly activationId: string;
  readonly restoreFenceGeneration: number;
  readonly acceptedThrough: number;
}

const COLUMNS =`relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
  json_extract(binding_json,'$.currentPath') AS path,retire_restore_generation,retire_accepted_cursor,retire_requested_at_ms`;
// Whether the activation row `table` names was captured under its workspace's current identity.
const currentIdentity = (table: string) => `EXISTS(SELECT 1 FROM sync_relay_workspaces current_identity
  WHERE current_identity.workspace_id=${table}.workspace_id
    AND current_identity.replication_epoch=json_extract(${table}.source_json,'$.replicationEpoch')
    AND current_identity.stream_identity=json_extract(${table}.source_json,'$.streamIdentity'))`;
/**
 * An obligation is open from its request until the activation retires, while the
 * workspace keeps the identity the activation was captured under. A later
 * identity leaves its lineage stale, so it could never retire.
 */
export const OPEN_RETIREMENT = `${SERVICE_ACTIVATIONS}.retire_requested_at_ms IS NOT NULL AND ${SERVICE_ACTIVATIONS}.retired_at_ms IS NULL
  AND ${currentIdentity(SERVICE_ACTIVATIONS)}`;

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Service activation retirement is damaged.");
  return value;
}
function retirement(value: Record<string, unknown>): ServiceActivationRetirement {
  if (typeof value.path !== "string" || value.main_version_id !== "main") throw new Error("Service activation retirement is damaged.");
  return Object.freeze({relayDatabaseNamespace: String(value.relay_database_namespace), activationId: String(value.activation_id),
    workspaceId: String(value.workspace_id), mainVersionId: "main", objectId: String(value.object_id), lineageClaimId: String(value.lineage_claim_id),
    path: value.path, restoreFenceGeneration: integer(value.retire_restore_generation), acceptedThrough: integer(value.retire_accepted_cursor),
    requestedAtMs: integer(value.retire_requested_at_ms)});
}

/** The document's open retirement obligation, if one is recorded. */
export function readServiceActivationRetirement(storage: StorageContext, document: {workspaceId: string; objectId: string}): ServiceActivationRetirement | null {
  const value = storage.db.prepare(`SELECT ${COLUMNS} FROM ${SERVICE_ACTIVATIONS}
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND ${OPEN_RETIREMENT} LIMIT 1`).get(document.workspaceId, document.objectId);
  return value ? retirement(value) : null;
}

/** Whether the document's activation has an open retirement obligation. */
export function serviceActivationRetirementOpen(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  return storage.db.prepare(`SELECT EXISTS(SELECT 1 FROM ${SERVICE_ACTIVATIONS}
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND ${OPEN_RETIREMENT}) AS open`).get(document.workspaceId, document.objectId)!.open === 1;
}

/** The workspace's open retirement obligations, by object. */
export function listServiceActivationRetirements(storage: StorageContext, workspaceId: string): ServiceActivationRetirement[] {
  return storage.db.prepare(`SELECT ${COLUMNS} FROM ${SERVICE_ACTIVATIONS} WHERE workspace_id=? AND ${OPEN_RETIREMENT} ORDER BY object_id`)
    .all(workspaceId).map(retirement);
}

/**
 * Records, inside the caller's transaction, the retirement of the prepared
 * activation of the document's current lineage, at its restore generation and
 * the lineage's last accepted journal cursor. An open obligation stays as it
 * was, whatever lineage is current now. Null when the document has no
 * prepared activation under the workspace's current identity.
 */
export function openServiceActivationRetirement(storage: StorageContext, document: {workspaceId: string; objectId: string}, nowMs: number): ServiceActivationRetirement | null {
  const open = readServiceActivationRetirement(storage, document);
  if (open) return open;
  const activation = storage.db.prepare(`SELECT a.relay_database_namespace,a.activation_id,a.lineage_claim_id,d.restore_fence_generation
    FROM ${SERVICE_ACTIVATIONS} a JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
    WHERE a.workspace_id=? AND a.main_version_id='main' AND a.object_id=? AND a.retire_requested_at_ms IS NULL AND d.lineage_state='current'
      AND ${currentIdentity("a")}`)
    .get(document.workspaceId, document.objectId);
  if (!activation) return null;
  const accepted = storage.db.prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM ${LIVE_JOURNAL_TABLE}
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`)
    .get(document.workspaceId, document.objectId, activation.lineage_claim_id)!;
  const changed = storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET retire_requested_at_ms=?,retire_restore_generation=?,retire_accepted_cursor=?
    WHERE relay_database_namespace=? AND activation_id=? AND retire_requested_at_ms IS NULL`)
    .run(integer(nowMs), integer(activation.restore_fence_generation), integer(accepted.cursor), activation.relay_database_namespace, activation.activation_id);
  if (changed.changes !== 1) throw new Error("Service activation retirement is damaged.");
  const recorded = storage.db.prepare(`SELECT ${COLUMNS} FROM ${SERVICE_ACTIVATIONS} WHERE relay_database_namespace=? AND activation_id=?`)
    .get(activation.relay_database_namespace, activation.activation_id);
  if (!recorded) throw new Error("Service activation retirement is damaged.");
  return retirement(recorded);
}

type LineageDocument = {workspaceId: string; objectId: string; lineageClaimId: string};

/**
 * Inside the transaction that moves the lineage's restore generation from
 * `from` to `to`, a restore fence or a native cancellation proving that fence
 * absent, moves its open obligation with it. Only the generation changes: an
 * open obligation fences admission, so its accepted-through is still
 * `acceptedThrough`, the journal cursor the fence closed at.
 */
export function moveServiceActivationRetirement(storage: StorageContext, document: LineageDocument, from: number, to: number, acceptedThrough: number): void {
  const where = `workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=? AND retire_restore_generation=? AND ${OPEN_RETIREMENT}`;
  const params = [document.workspaceId, document.objectId, document.lineageClaimId, integer(from)];
  const open = storage.db.prepare(`SELECT retire_accepted_cursor FROM ${SERVICE_ACTIVATIONS} WHERE ${where}`).all(...params);
  if (open.some(row => row.retire_accepted_cursor !== integer(acceptedThrough))) throw new Error("Service activation retirement is damaged.");
  storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET retire_restore_generation=? WHERE ${where}`).run(integer(to), ...params);
}

/**
 * Inside the transaction that admits a restore at `generation`, names the
 * restore's own accepted journal cursor as the open obligation's
 * accepted-through. An admitted restore always finishes, and its output up to
 * that cursor is then publishable under the retirement before it resumes. The
 * obligation keeps its activation, generation and request time.
 */
export function carryServiceActivationRetirement(storage: StorageContext, document: LineageDocument, generation: number, acceptedThrough: number): void {
  storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET retire_accepted_cursor=?
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=? AND retire_restore_generation=? AND ${OPEN_RETIREMENT}`)
    .run(integer(acceptedThrough), document.workspaceId, document.objectId, document.lineageClaimId, integer(generation));
}
