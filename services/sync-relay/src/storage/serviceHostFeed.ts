import {createHash} from "node:crypto";
import type {StorageContext} from "./context";
import type {SqliteDb, SyncRelayLogRow} from "./types";
import {rowToLogRow} from "./rows";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, pathVisibleThroughShare} from "../shareFilter";
import {canonicalLiveSelector} from "./liveDocumentAuthority";
import {currentServiceHostEnrollments} from "./serviceHostEnrollment";

/** The op kinds that name one live document, and so may belong to a hosted one. */
export const HOSTED_DOCUMENT_OP_KINDS = ["moment.append", "ydoc.update", "live.audit.application", "live.audit.settlement", "live.audit.base"] as const;
const INDEX = "idx_sync_relay_log_hosted_documents";
const KINDS = HOSTED_DOCUMENT_OP_KINDS.map(kind => `'${kind}'`).join(",");
const OBJECT = `CASE op_kind WHEN 'live.audit.settlement' THEN json_extract(payload_json, '$.record.binding.objectId')
  WHEN 'live.audit.base' THEN json_extract(payload_json, '$.record.checkpoint.binding.objectId')
  ELSE json_extract(payload_json, '$.objectId') END`;

export function initializeServiceHostFeedIndex(db: SqliteDb): void {
  db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON sync_relay_log(workspace_id, ${OBJECT}, relay_seq) WHERE op_kind IN (${KINDS})`);
}

export interface ServiceHostFeedScope {
  readonly workspaceId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  /** Enrolled documents, object to enrolled path. The host may settle these at that path. */
  readonly hosted: ReadonlyMap<string, string>;
  /** The hosted documents no longer at their enrolled path. Their publications project nowhere. */
  readonly departed: ReadonlySet<string>;
  /** The hosted documents at their path that an active Edit grant covers now. The host may read only these. */
  readonly shared: ReadonlyMap<string, string>;
  /** Changes whenever `shared` or the workspace identity changes. */
  readonly token: string;
}

/** Statement-level snapshots; safe both on the request path and inside a write guard. */
export function readServiceHostFeedScope(storage: StorageContext, workspaceId: string): ServiceHostFeedScope | null {
  const enrollments = currentServiceHostEnrollments(storage, workspaceId);
  if (!enrollments.length) return null;
  // Current enrollments share the workspace's owner and identity.
  const {ownerUserId, replicationEpoch, streamIdentity} = enrollments[0]!;
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
    else if (selectors.some(selector => pathVisibleThroughShare(selector, row.path))) shared.set(row.objectId, row.path);
  }
  const token = createHash("sha256").update(JSON.stringify(["dohc-hosted-scope-v1", workspaceId, replicationEpoch, streamIdentity, [...shared]])).digest("hex");
  return Object.freeze({workspaceId, replicationEpoch, streamIdentity, hosted, departed, shared, token});
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
