import {createHash} from "node:crypto";
import type {StorageContext} from "./context";
import type {SqliteDb, SyncRelayLogRow} from "./types";
import {rowToLogRow} from "./rows";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, pathVisibleThroughShare} from "../shareFilter";
import {canonicalLiveSelector} from "./liveDocumentAuthority";
import {currentServiceHostEnrollments} from "./serviceHostEnrollment";
import {listServiceActivationRetirements, type ServiceActivationRetirement} from "./serviceActivationRetirement";

/** The op kinds that name one live document, and so may belong to a hosted one. */
export const HOSTED_DOCUMENT_OP_KINDS = ["moment.append", "ydoc.update", "live.audit.application", "live.audit.settlement", "live.audit.base"] as const;
const INDEX = "idx_sync_relay_log_hosted_documents";
const CONFLICT_EFFECT_INDEX = "idx_sync_relay_log_conflict_effects";
const CONFLICT_EFFECT_WHERE = "op_kind='moment.append' AND json_type(payload_json, '$.conflictId')='text'";
const KINDS = HOSTED_DOCUMENT_OP_KINDS.map(kind => `'${kind}'`).join(",");
const OBJECT = `CASE op_kind WHEN 'live.audit.settlement' THEN json_extract(payload_json, '$.record.binding.objectId')
  WHEN 'live.audit.base' THEN json_extract(payload_json, '$.record.checkpoint.binding.objectId')
  ELSE json_extract(payload_json, '$.objectId') END`;

export function initializeServiceHostFeedIndex(db: SqliteDb): void {
  db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON sync_relay_log(workspace_id, ${OBJECT}, relay_seq) WHERE op_kind IN (${KINDS})`);
  db.exec(`CREATE INDEX IF NOT EXISTS ${CONFLICT_EFFECT_INDEX} ON sync_relay_log(workspace_id, json_extract(payload_json, '$.objectId'), relay_seq)
    WHERE ${CONFLICT_EFFECT_WHERE}`);
}

export interface ServiceHostFeedScope {
  readonly workspaceId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  /** Enabled enrolled documents, object to enrolled path. The host may settle these at that path until their release. */
  readonly hosted: ReadonlyMap<string, string>;
  /** The hosted documents no longer at their enrolled path. Their publications project nowhere. */
  readonly departed: ReadonlySet<string>;
  /**
   * The hosted documents at their path that an active Edit grant covers now
   * and that their owner has not paused or stopped. The host may read only these.
   */
  readonly shared: ReadonlyMap<string, string>;
  /**
   * The documents whose activation has an open retirement obligation, by
   * object. They are neither hosted nor shared, even once Resume enabled
   * them again, until their activation retires.
   */
  readonly settling: ReadonlyMap<string, ServiceActivationRetirement>;
  /** Changes whenever `shared` or the workspace identity changes. */
  readonly token: string;
}

/** Statement-level snapshots; safe both on the request path and inside a write guard. */
export function readServiceHostFeedScope(storage: StorageContext, workspaceId: string): ServiceHostFeedScope | null {
  const all = currentServiceHostEnrollments(storage, workspaceId);
  let ownerUserId: string, replicationEpoch: string, streamIdentity: string;
  if (all.length) {
    // Current enrollments share the workspace's owner and identity.
    ({ownerUserId, replicationEpoch, streamIdentity} = all[0]!);
  } else {
    // A Stop can leave an undrained row with enabled=0, and an open retirement
    // outlasts the drain. Keep the hosted credential alive so the host can
    // observe the empty scope and retire it, and finish that retirement.
    const workspace = storage.currentServiceHostWorkspace(workspaceId, true);
    if (!workspace) return null;
    ({ownerUserId, replicationEpoch, streamIdentity} = workspace);
    const token = createHash("sha256").update(JSON.stringify(["dohc-hosted-scope-v1", workspace.workspaceId, replicationEpoch, streamIdentity, []])).digest("hex");
    return Object.freeze({workspaceId: workspace.workspaceId, replicationEpoch, streamIdentity, hosted: new Map<string, string>(), departed: new Set<string>(),
      shared: new Map<string, string>(), settling: settlingScope(storage, workspace.workspaceId), token});
  }
  const settling = settlingScope(storage, workspaceId), enrollments = all.filter(row => !settling.has(row.objectId));
  const selectors = storage.db.prepare(`SELECT s.share_id,s.workspace_id,s.granter_user_id,s.selector_json,s.created_at_ms
    FROM sync_relay_shares s INDEXED BY idx_sync_relay_shares_service_candidates WHERE s.workspace_id=? AND s.granter_user_id=?
      AND EXISTS(SELECT 1 FROM sync_relay_share_grants g WHERE g.share_id=s.share_id AND g.status='active' AND g.access='edit')`)
    .all(workspaceId, ownerUserId).flatMap(value => {
      const share = {shareId: String(value.share_id), workspaceId: String(value.workspace_id), granterUserId: String(value.granter_user_id),
        selectorJson: String(value.selector_json), createdAtMs: Number(value.created_at_ms)};
      const parsed = parseStoredAnyShareSelectorJson(share.selectorJson), selector = parsed && effectiveShareSelector(parsed, "edit");
      return selector && isLiveEditShareSelector(selector) && canonicalLiveSelector(share, selector) ? [selector] : [];
    });
  const hosted = new Map<string, string>(), departed = new Set<string>(), shared = new Map<string, string>();
  for (const row of enrollments) {
    hosted.set(row.objectId, row.path);
    if (storage.objectIdAtPathInVersion({workspaceId, versionId: "main", path: row.path}) !== row.objectId) departed.add(row.objectId);
    // A Pause cuts reads at once, like a revoked grant, while the enabled
    // binding stays writable until the host releases it.
    else if (row.ownerStop === null && selectors.some(selector => pathVisibleThroughShare(selector, row.path))) shared.set(row.objectId, row.path);
  }
  const token = createHash("sha256").update(JSON.stringify(["dohc-hosted-scope-v1", workspaceId, replicationEpoch, streamIdentity, [...shared]])).digest("hex");
  return Object.freeze({workspaceId, replicationEpoch, streamIdentity, hosted, departed, shared, settling, token});
}
function settlingScope(storage: StorageContext, workspaceId: string): ReadonlyMap<string, ServiceActivationRetirement> {
  return new Map(listServiceActivationRetirements(storage, workspaceId).map(row => [row.objectId, row]));
}

/** One document's rows after a relay sequence, in relay order. Callers still decide each row. */
export function listServiceHostDocumentRows(storage: StorageContext, input: {
  workspaceId: string; objectId: string; afterRelaySeq: number; limit: number;
}): SyncRelayLogRow[] {
  return storage.db.prepare(`SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq,
      admitted_author_snapshot_json, settlement_admission_json
    FROM sync_relay_log INDEXED BY ${INDEX}
    WHERE workspace_id=? AND ${OBJECT}=? AND op_kind IN (${KINDS}) AND relay_seq>? ORDER BY relay_seq LIMIT ?`)
    .all(input.workspaceId, input.objectId, input.afterRelaySeq, input.limit).map(rowToLogRow);
}

/** The relay sequence of the document's latest Y.Doc update, or 0 while it has none. */
export function latestServiceHostDocumentUpdate(storage: StorageContext, input: {workspaceId: string; objectId: string}): number {
  const row = storage.db.prepare(`SELECT relay_seq FROM sync_relay_log INDEXED BY ${INDEX}
    WHERE workspace_id=? AND ${OBJECT}=? AND op_kind IN (${KINDS}) AND op_kind='ydoc.update' ORDER BY relay_seq DESC LIMIT 1`)
    .get(input.workspaceId, input.objectId);
  return row ? Number(row.relay_seq) : 0;
}

/** A retained conflict effect whose parent the hosted feed never serves, even on re-enrollment. */
export function hasServiceHostConflictEffect(storage: StorageContext, input: {workspaceId: string; objectId: string}): boolean {
  return !!storage.db.prepare(`SELECT 1 FROM sync_relay_log AS effect INDEXED BY ${CONFLICT_EFFECT_INDEX}
    WHERE workspace_id=? AND json_extract(payload_json, '$.objectId')=? AND relay_seq>? AND ${CONFLICT_EFFECT_WHERE}
      AND json_extract(payload_json, '$.versionId')='main'
      AND length(json_extract(payload_json, '$.conflictId'))>0
      AND json_type(payload_json, '$.conflictEffectIndex')='integer' AND json_extract(payload_json, '$.conflictEffectIndex')>=0
      AND EXISTS(SELECT 1 FROM sync_relay_log AS parent WHERE parent.workspace_id=effect.workspace_id AND parent.origin_id=effect.origin_id
        AND parent.origin_seq=effect.origin_seq-json_extract(effect.payload_json, '$.conflictEffectIndex')-1
        AND parent.op_kind='conflict.resolve' AND json_extract(parent.payload_json, '$.targetVersionId')='main'
        AND json_extract(parent.payload_json, '$.conflictId')=json_extract(effect.payload_json, '$.conflictId')
        AND json_extract(parent.payload_json, '$.effects[' || json_extract(effect.payload_json, '$.conflictEffectIndex') || '].momentId')=
          json_extract(effect.payload_json, '$.momentId')) LIMIT 1`)
    .get(input.workspaceId, input.objectId, storage.getEpochLogFloor(input.workspaceId));
}
