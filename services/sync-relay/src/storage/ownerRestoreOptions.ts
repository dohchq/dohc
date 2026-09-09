import {isDeepStrictEqual} from "node:util";
import {validateUserWritePath} from "@dohc/workspace-core";
import {parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier, type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {badRequest, notFound, relayError} from "../errors";
import {MAX_LOG_PAGE_SIZE, MAX_PAYLOAD_JSON_BYTES} from "../wireLimits";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, visibleSharePath} from "../shareFilter";
import {authorityInteger, canonicalLiveSelector, currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {liveJournalHistoryNamespace} from "./liveJournalHistory";
import {retainedRestoreLifecycle} from "./liveRestoreLifecycleStorage";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";
import type {StopRestoreIntent, StopRestoreLookup, StopRestoreOperation, StopRestoreRecipient} from "./liveRestoreOperation";
import {readStopRestoreInTransaction} from "./liveRestoreOperation";
import type {StorageContext} from "./context";
import type {SyncRelayShareRow} from "./types";

export type OwnerRestoreOptionsInput = {workspaceId: string; ownerUserId: string; path: string; beforeCursor?: number};
export type OwnerRestoreStatus = {
  operationId: string; document: LiveDocumentKey; path: string; phase: StopRestoreOperation["phase"];
  intent: Omit<StopRestoreIntent, "ownerUserId">; proposalDigest: string | null;
};
export type OwnerRestoreOptions = {
  document: LiveDocumentKey; path: string;
  grants: Array<StopRestoreRecipient & {shareId: string; generation: number}>;
  points: Array<{cursor: number; receivedAtMs: number | null; kind: "baseline" | "accepted"; receiptDigest: string}>;
  nextBeforeCursor: number | null;
  pendingOperation: Pick<OwnerRestoreStatus, "operationId" | "phase" | "proposalDigest"> | null;
};

const key = (document: LiveDocumentKey) => [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
const whereDocument = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
function bounded(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes > MAX_PAYLOAD_JSON_BYTES) {
    throw relayError("payload_too_large", "Restore options or status exceed the metadata limit.");
  }
}
function owned(storage: StorageContext, workspaceId: string, ownerUserId: string) {
  if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
}
function retired(): never {throw relayError("conflict", "The restore point is no longer retained for this document.");}

/** Read authenticated receipt metadata without loading proposal or document blobs. */
export function readOwnerRestoreStatus(storage: StorageContext, input: StopRestoreLookup): OwnerRestoreStatus {
  return storage.readTx(() => statusInTransaction(storage, input));
}
function statusInTransaction(storage: StorageContext, input: StopRestoreLookup): OwnerRestoreStatus {
  owned(storage, input.workspaceId, input.ownerUserId);
  const operationId = parseLiveUpdateIdentifier(input.operationId), namespace = liveJournalHistoryNamespace(storage);
  const header = storage.db.prepare(`SELECT length(CAST(intent_json AS BLOB))+length(CAST(basis_json AS BLOB))+
    COALESCE(length(CAST(terminal_json AS BLOB)),0)+COALESCE(length(CAST(applied_json AS BLOB)),0)+
    COALESCE(length(CAST(native_receipt_json AS BLOB)),0) AS bytes FROM ${LIVE_RESTORE_OPERATIONS}
    WHERE relay_database_namespace=? AND operation_id=? AND workspace_id=?`).get(namespace, operationId, input.workspaceId);
  if (!header) throw notFound();
  bounded(Number(header.bytes));
  const operation = readStopRestoreInTransaction(storage, {...input, operationId});
  if (!operation || operation.intent.ownerUserId !== input.ownerUserId || operation.basis.namespace !== namespace) throw notFound();
  let proposalDigest: string | null = null;
  if (["relay-admitted", "native-applied", "settled", "resumed"].includes(operation.phase)) {
    const retained = retainedRestoreLifecycle(storage.db, namespace, operationId, MAX_PAYLOAD_JSON_BYTES);
    const lifecycle = retained?.lifecycle;
    const binding = lifecycle?.admitted.accepted.binding;
    if (!lifecycle || retained!.row.workspace_id !== input.workspaceId || lifecycle.phase !== operation.phase ||
      !binding || !isDeepStrictEqual({workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
        objectId: binding.objectId, lineageClaimId: binding.lineageClaimId}, operation.intent.document) ||
      lifecycle.preparation.fence.operation.operationId !== operationId ||
      lifecycle.admitted.accepted.authority.principalId !== input.ownerUserId ||
      (operation.phase === "resumed" && (!lifecycle.resume || !lifecycle.settlement?.materialized))) {
      throw relayError("conflict", "The retained restore status could not be verified.");
    }
    proposalDigest = lifecycle.proposalDigest;
  }
  const {ownerUserId: _owner, ...intent} = operation.intent;
  const status = {operationId, document: intent.document, path: operation.basis.binding.currentPath,
    phase: operation.phase, intent, proposalDigest};
  bounded(Buffer.byteLength(JSON.stringify(status)));
  return status;
}

export function readOwnerRestoreOptions(storage: StorageContext, input: OwnerRestoreOptionsInput): OwnerRestoreOptions {
  return storage.readTx(() => {
    owned(storage, input.workspaceId, input.ownerUserId);
    const workspaceId = parseLiveUpdateIdentifier(input.workspaceId);
    const checked = typeof input.path === "string" && validateUserWritePath(input.path);
    if (!checked || !checked.ok || checked.normalized !== input.path) throw badRequest("Invalid restore path.");
    const beforeCursor = input.beforeCursor === undefined ? undefined : authorityInteger(input.beforeCursor, 1);
    const namespace = liveJournalHistoryNamespace(storage);
    const row = storage.db.prepare(`SELECT workspace_id,main_version_id,object_id,lineage_claim_id,baseline_digest,
      baseline_moment_relay_seq FROM sync_relay_live_documents
      WHERE workspace_id=? AND main_version_id='main' AND current_path=? AND lineage_state='current' LIMIT 2`)
      .all(workspaceId, input.path);
    if (row.length !== 1) throw notFound();
    const current = row[0]!, document = parseLiveDocumentKey({workspaceId, mainVersionId: current.main_version_id,
      objectId: current.object_id, lineageClaimId: current.lineage_claim_id});
    if (Number(current.baseline_moment_relay_seq) <= storage.getEpochLogFloor(workspaceId) ||
      !currentLiveDocumentMoment(storage, document, input.path)) retired();
    const result: OwnerRestoreOptions = {document, path: input.path, grants: [], points: [], nextBeforeCursor: null, pendingOperation: null};
    const pending = storage.db.prepare(`SELECT operation_id FROM ${LIVE_RESTORE_OPERATIONS}
      WHERE relay_database_namespace=? AND ${whereDocument} AND phase<>'resumed' ORDER BY invalidated_at_ms DESC LIMIT 2`)
      .all(namespace, ...key(document));
    if (pending.length > 1) throw relayError("conflict", "More than one restore operation is pending.");
    if (pending[0]) {
      const status = statusInTransaction(storage, {workspaceId, ownerUserId: input.ownerUserId,
        operationId: parseLiveUpdateIdentifier(pending[0].operation_id)});
      result.pendingOperation = {operationId: status.operationId, phase: status.phase, proposalDigest: status.proposalDigest};
    }
    let bytes = Buffer.byteLength(JSON.stringify(result));
    const charge = (value: unknown) => {bytes += Buffer.byteLength(JSON.stringify(value)) + 1; bounded(bytes);};
    for (const header of storage.db.prepare(`SELECT g.rowid AS grant_rowid,
      length(CAST(s.selector_json AS BLOB))+length(CAST(s.share_id AS BLOB))+length(CAST(g.grant_id AS BLOB))+
      COALESCE(length(CAST(g.principal_user_id AS BLOB)),0)+COALESCE(length(CAST(g.principal_email AS BLOB)),0) AS bytes
      FROM sync_relay_share_grants g JOIN sync_relay_shares s USING(share_id)
      WHERE s.workspace_id=? AND s.granter_user_id=? AND g.status='active' AND g.access='edit' ORDER BY g.grant_id`)
      .iterate(workspaceId, input.ownerUserId)) {
      bounded(Number(header.bytes));
      const grant = storage.db.prepare(`SELECT s.share_id,s.selector_json,s.created_at_ms,g.grant_id,g.generation,
        g.principal_kind,g.principal_user_id,g.principal_email FROM sync_relay_share_grants g
        JOIN sync_relay_shares s USING(share_id) WHERE g.rowid=?`).get(header.grant_rowid)!;
      const share: SyncRelayShareRow = {shareId: String(grant.share_id), workspaceId, granterUserId: input.ownerUserId,
        selectorJson: String(grant.selector_json), createdAtMs: Number(grant.created_at_ms)};
      const stored = parseStoredAnyShareSelectorJson(share.selectorJson), selector = stored && effectiveShareSelector(stored, "edit");
      if (!selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector) ||
        visibleSharePath(selector, input.path) !== input.path) continue;
      const principalKind = grant.principal_kind;
      if (principalKind !== "user" && principalKind !== "email" && principalKind !== "link") throw new Error("Invalid grant recipient.");
      const recipient: OwnerRestoreOptions["grants"][number] = {shareId: parseLiveUpdateIdentifier(grant.share_id), grantId: parseLiveUpdateIdentifier(grant.grant_id),
        generation: authorityInteger(grant.generation, 1), principalKind,
        userId: grant.principal_user_id === null ? null : parseLiveUpdateIdentifier(grant.principal_user_id),
        email: grant.principal_email === null ? null : String(grant.principal_email)};
      charge(recipient); result.grants.push(recipient);
    }
    if (beforeCursor !== undefined && !storage.db.prepare(`SELECT 1 FROM sync_relay_live_update_journal
      WHERE relay_database_namespace=? AND ${whereDocument} AND journal_cursor=?`).get(namespace, ...key(document), beforeCursor)) retired();
    for (const point of storage.db.prepare(`SELECT journal_cursor,received_at_ms,update_digest FROM sync_relay_live_update_journal
      WHERE relay_database_namespace=? AND ${whereDocument} AND journal_cursor<=? ORDER BY journal_cursor DESC LIMIT ?`)
      .iterate(namespace, ...key(document), beforeCursor === undefined ? Number.MAX_SAFE_INTEGER : beforeCursor - 1, MAX_LOG_PAGE_SIZE + 1)) {
      if (result.points.length === MAX_LOG_PAGE_SIZE) {result.nextBeforeCursor = result.points.at(-1)!.cursor; break;}
      const value = {cursor: authorityInteger(point.journal_cursor, 1), receivedAtMs: authorityInteger(point.received_at_ms),
        kind: "accepted" as const, receiptDigest: parseLiveUpdateDigest(point.update_digest)};
      charge(value); result.points.push(value);
    }
    if (result.nextBeforeCursor === null) {
      if (result.points.length === MAX_LOG_PAGE_SIZE) result.nextBeforeCursor = result.points.at(-1)!.cursor;
      else {
        const baseline = {cursor: 0, receivedAtMs: null, kind: "baseline" as const, receiptDigest: parseLiveUpdateDigest(current.baseline_digest)};
        charge(baseline); result.points.push(baseline);
      }
    }
    bounded(Buffer.byteLength(JSON.stringify(result)));
    return result;
  });
}
