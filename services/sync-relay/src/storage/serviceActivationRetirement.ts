import type {StorageContext} from "./context";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {LIVE_JOURNAL_TABLE} from "./schema";

// The retirement of one exact service activation, recorded on its row when
// Stop, or a Resume of a document held for an unadmitted edit, fences live
// admission. It names the activation as the engine retires it. Once recorded
// it stays as it was, and admission stays fenced, until the activation
// retires: Resume, a new share or a restored grant leaves it in place. An
// authority-reducing change must always commit, so it charges no quota; its
// three integers are fixed-size row columns.
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
// An obligation is open from Stop until the activation retires.
const OPEN = "retire_requested_at_ms IS NOT NULL AND retired_at_ms IS NULL";

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
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND ${OPEN} LIMIT 1`).get(document.workspaceId, document.objectId);
  return value ? retirement(value) : null;
}

/** Whether the document's activation has an open retirement obligation. */
export function serviceActivationRetirementOpen(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  return storage.db.prepare(`SELECT EXISTS(SELECT 1 FROM ${SERVICE_ACTIVATIONS}
    WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND ${OPEN}) AS open`).get(document.workspaceId, document.objectId)!.open === 1;
}

/** The workspace's open retirement obligations, by object. */
export function listServiceActivationRetirements(storage: StorageContext, workspaceId: string): ServiceActivationRetirement[] {
  return storage.db.prepare(`SELECT ${COLUMNS} FROM ${SERVICE_ACTIVATIONS} WHERE workspace_id=? AND ${OPEN} ORDER BY object_id`)
    .all(workspaceId).map(retirement);
}

/**
 * Records, inside the caller's transaction, the retirement of the prepared
 * activation of the document's current lineage, at its restore generation and
 * the lineage's last accepted journal cursor. A recorded obligation stays as
 * it was. Null when the document has no prepared activation.
 */
export function openServiceActivationRetirement(storage: StorageContext, document: {workspaceId: string; objectId: string}, nowMs: number): ServiceActivationRetirement | null {
  const activation = storage.db.prepare(`SELECT a.relay_database_namespace,a.activation_id,a.lineage_claim_id,a.retire_requested_at_ms,d.restore_fence_generation
    FROM ${SERVICE_ACTIVATIONS} a JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
    WHERE a.workspace_id=? AND a.main_version_id='main' AND a.object_id=? AND a.retired_at_ms IS NULL AND d.lineage_state='current'`)
    .get(document.workspaceId, document.objectId);
  if (!activation) return null;
  if (activation.retire_requested_at_ms === null) {
    const accepted = storage.db.prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM ${LIVE_JOURNAL_TABLE}
      WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`)
      .get(document.workspaceId, document.objectId, activation.lineage_claim_id)!;
    const changed = storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET retire_requested_at_ms=?,retire_restore_generation=?,retire_accepted_cursor=?
      WHERE relay_database_namespace=? AND activation_id=? AND retire_requested_at_ms IS NULL`)
      .run(integer(nowMs), integer(activation.restore_fence_generation), integer(accepted.cursor), activation.relay_database_namespace, activation.activation_id);
    if (changed.changes !== 1) throw new Error("Service activation retirement is damaged.");
  }
  const recorded = storage.db.prepare(`SELECT ${COLUMNS} FROM ${SERVICE_ACTIVATIONS} WHERE relay_database_namespace=? AND activation_id=?`)
    .get(activation.relay_database_namespace, activation.activation_id);
  if (!recorded) throw new Error("Service activation retirement is damaged.");
  return retirement(recorded);
}
