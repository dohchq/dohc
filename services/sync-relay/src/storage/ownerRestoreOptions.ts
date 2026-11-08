import { visibleSharePath } from "@dohc/security-contract/share-selector";
import {isDeepStrictEqual} from "node:util";
import {validateUserWritePath} from "@dohc/workspace-core";
import {parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseServerDerivedLiveUpdateAuthority,
  type LiveDocumentKey, type ServerDerivedLiveUpdateAuthority} from "@dohc/live-session-contract/live-update-admission";
import {badRequest, notFound, relayError} from "../errors";
import {MAX_LOG_PAGE_SIZE, MAX_PAYLOAD_JSON_BYTES} from "../wireLimits";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson} from "../shareFilter";
import {authorityInteger, canonicalLiveSelector, currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {liveJournalHistoryNamespace} from "./liveJournalHistory";
import {retainedRestoreLifecycle} from "./liveRestoreLifecycleStorage";
import {LIVE_RESTORE_OPERATIONS, UNFINISHED_RESTORE} from "./liveRestoreOperationSchema";
import type {StopRestoreIntent, StopRestoreLookup, StopRestoreOperation, StopRestoreRecipient} from "./liveRestoreOperation";
import {readStopRestoreInTransaction, requireStopRestorable} from "./liveRestoreOperation";
import type {StorageContext} from "./context";
import type {SyncRelayShareRow} from "./types";
import {ticketRecord} from "../liveTicketInputs";

export type OwnerRestoreGrantCursor = {
  shareCreatedAtMs: number; shareId: string; grantCreatedAtMs: number | null; grantId: string | null;
};
export type OwnerRestoreOptionsInput = {
  workspaceId: string; ownerUserId: string; path: string; beforeCursor?: number; grantCursor?: OwnerRestoreGrantCursor;
};
export type OwnerRestoreStatus = {
  operationId: string; document: LiveDocumentKey; path: string; phase: StopRestoreOperation["phase"];
  intent: Omit<StopRestoreIntent, "ownerUserId">; proposalDigest: string | null;
};
export type OwnerRestoreOptions = {
  document: LiveDocumentKey; path: string;
  grants: Array<StopRestoreRecipient & {shareId: string; generation: number}>;
  // Who the relay accepted each change from; none for the baseline.
  points: Array<{cursor: number; receivedAtMs: number | null; kind: "baseline" | "accepted"; receiptDigest: string;
    authority: ServerDerivedLiveUpdateAuthority | null}>;
  // The named recipient behind each grant a point names, once per grant. The
  // route adds each account's email, in room this page already holds for it.
  authors: StopRestoreRecipient[];
  nextBeforeCursor: number | null;
  nextGrantCursor: OwnerRestoreGrantCursor | null;
  pendingOperation: Pick<OwnerRestoreStatus, "operationId" | "phase" | "proposalDigest"> | null;
};

// One restore the owner has not finished or declined, at its file's current path.
export type OwnerUnfinishedRestore = Pick<OwnerRestoreStatus, "operationId" | "path" | "phase" | "proposalDigest">;
// `unreadable` counts this page's restores whose status could not be read.
export type OwnerUnfinishedRestores = {restores: OwnerUnfinishedRestore[]; unreadable: number; nextCursor: string | null};
const UNFINISHED_RESTORE_PAGE = 50;

/** The longest account email the route adds to a grant or an author. */
export const MAX_RESTORE_EMAIL_BYTES = 320;
// Identifiers are at most 512 bytes and at most double when escaped. One
// accepted point with its named author and email stays under 6 KiB. The
// baseline and both continuation cursors stay under 4 KiB.
const MAX_RESTORE_POINT_BYTES = 6 * 1024, RESTORE_TAIL_BYTES = 4 * 1024;
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

export function parseOwnerRestoreGrantCursor(value: unknown): OwnerRestoreGrantCursor {
  try {
    const row = ticketRecord(value, ["shareCreatedAtMs", "shareId", "grantCreatedAtMs", "grantId"]);
    if ((row.grantCreatedAtMs === null) !== (row.grantId === null)) throw new Error();
    return {shareCreatedAtMs: authorityInteger(row.shareCreatedAtMs), shareId: parseLiveUpdateIdentifier(row.shareId),
      grantCreatedAtMs: row.grantCreatedAtMs === null ? null : authorityInteger(row.grantCreatedAtMs),
      grantId: row.grantId === null ? null : parseLiveUpdateIdentifier(row.grantId)};
  } catch {throw badRequest("Invalid restore grant cursor.");}
}

function grantPage(storage: StorageContext, input: OwnerRestoreOptionsInput, charge: (value: unknown, reserve?: number) => void,
  fits: (value: unknown, reserve: number) => boolean) {
  let cursor = input.grantCursor === undefined ? null : parseOwnerRestoreGrantCursor(input.grantCursor);
  let resumeShare = cursor?.grantId != null, inspected = 0, selectorBytes = 0;
  const grants: OwnerRestoreOptions["grants"] = [];
  // Leave one source-row slot for a grant after opening a matching share.
  while (inspected < MAX_LOG_PAGE_SIZE - 1) {
    const columns = "share_id,granter_user_id,created_at_ms,length(CAST(selector_json AS BLOB)) AS bytes";
    const header = resumeShare
      ? storage.db.prepare(`SELECT ${columns} FROM sync_relay_shares WHERE workspace_id=? AND share_id=? AND created_at_ms=?`)
        .get(input.workspaceId, cursor!.shareId, cursor!.shareCreatedAtMs)
      : storage.db.prepare(`SELECT ${columns} FROM sync_relay_shares INDEXED BY idx_sync_relay_shares_workspace
        WHERE workspace_id=? AND (created_at_ms,share_id)>(?,?) ORDER BY created_at_ms,share_id LIMIT 1`)
        .get(input.workspaceId, cursor?.shareCreatedAtMs ?? -1, cursor?.shareId ?? "");
    inspected++;
    if (!header) {
      if (resumeShare) {resumeShare = false; continue;}
      return {grants, nextGrantCursor: null};
    }
    const shareId = parseLiveUpdateIdentifier(header.share_id), shareCreatedAtMs = authorityInteger(header.created_at_ms);
    const afterShare: OwnerRestoreGrantCursor = {shareId, shareCreatedAtMs, grantCreatedAtMs: null, grantId: null};
    if (header.granter_user_id !== input.ownerUserId) {cursor = afterShare; resumeShare = false; continue;}
    const bytes = authorityInteger(header.bytes) + Buffer.byteLength(shareId) + Buffer.byteLength(input.ownerUserId);
    bounded(bytes);
    if (bytes > MAX_PAYLOAD_JSON_BYTES - selectorBytes) return {grants, nextGrantCursor: cursor};
    selectorBytes += bytes;
    const selectorJson = storage.db.prepare("SELECT selector_json FROM sync_relay_shares WHERE share_id=?").get(shareId)!.selector_json;
    const share: SyncRelayShareRow = {shareId, workspaceId: input.workspaceId, granterUserId: input.ownerUserId,
      selectorJson: String(selectorJson), createdAtMs: shareCreatedAtMs};
    const stored = parseStoredAnyShareSelectorJson(share.selectorJson), selector = stored && effectiveShareSelector(stored, "edit");
    if (!selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector) ||
      visibleSharePath(selector, input.path) !== input.path) {cursor = afterShare; resumeShare = false; continue;}
    const grantTime = resumeShare ? cursor!.grantCreatedAtMs! : -1, grantId = resumeShare ? cursor!.grantId! : "";
    for (const row of storage.db.prepare(`SELECT grant_id,created_at_ms,status,access,
      COALESCE(length(CAST(principal_user_id AS BLOB)),0)+COALESCE(length(CAST(principal_email AS BLOB)),0) AS bytes
      FROM sync_relay_share_grants INDEXED BY idx_sync_relay_share_grants_restore_page
      WHERE share_id=? AND (created_at_ms,grant_id)>(?,?) ORDER BY created_at_ms,grant_id LIMIT ?`)
      .iterate(shareId, grantTime, grantId, MAX_LOG_PAGE_SIZE - inspected)) {
      inspected++;
      const previous = cursor;
      cursor = {shareId, shareCreatedAtMs, grantCreatedAtMs: authorityInteger(row.created_at_ms), grantId: parseLiveUpdateIdentifier(row.grant_id)};
      if (row.status === "active" && row.access === "edit") {
        bounded(authorityInteger(row.bytes) + Buffer.byteLength(cursor.grantId!));
        const grant = storage.db.prepare(`SELECT generation,principal_kind,principal_user_id,principal_email
          FROM sync_relay_share_grants WHERE share_id=? AND grant_id=?`).get(shareId, cursor.grantId)!;
        const principalKind = grant.principal_kind;
        if (principalKind !== "user" && principalKind !== "email" && principalKind !== "link") throw new Error("Invalid grant recipient.");
        const recipient: OwnerRestoreOptions["grants"][number] = {shareId, grantId: cursor.grantId!,
          generation: authorityInteger(grant.generation, 1), principalKind,
          userId: grant.principal_user_id === null ? null : parseLiveUpdateIdentifier(grant.principal_user_id),
          email: grant.principal_email === null ? null : String(grant.principal_email)};
        const reserve = recipient.principalKind === "user" ? MAX_RESTORE_EMAIL_BYTES : 0;
        // A full page ends before this grant, and the next page starts with it.
        if (grants.length > 0 && !fits(recipient, reserve)) return {grants, nextGrantCursor: previous};
        charge(recipient, reserve); grants.push(recipient);
      }
      if (inspected === MAX_LOG_PAGE_SIZE) return {grants, nextGrantCursor: cursor};
    }
    cursor = afterShare; resumeShare = false;
  }
  return {grants, nextGrantCursor: cursor};
}

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

/** The workspace's unfinished restores, one per document, in operation ID order. */
export function readOwnerUnfinishedRestores(storage: StorageContext, input: {workspaceId: string; ownerUserId: string; after?: string}): OwnerUnfinishedRestores {
  return storage.readTx(() => {
    owned(storage, input.workspaceId, input.ownerUserId);
    const workspaceId = parseLiveUpdateIdentifier(input.workspaceId), namespace = liveJournalHistoryNamespace(storage);
    const after = input.after === undefined ? "" : parseLiveUpdateIdentifier(input.after);
    const rows = storage.db.prepare(`SELECT operation_id,(SELECT current_path FROM sync_relay_live_documents d WHERE d.workspace_id=o.workspace_id AND
      d.main_version_id=o.main_version_id AND d.object_id=o.object_id AND d.lineage_claim_id=o.lineage_claim_id) AS current_path
      FROM ${LIVE_RESTORE_OPERATIONS} o WHERE relay_database_namespace=? AND workspace_id=? AND ${UNFINISHED_RESTORE} AND operation_id>?
      ORDER BY operation_id LIMIT ?`).all(namespace, workspaceId, after, UNFINISHED_RESTORE_PAGE + 1);
    const page = rows.slice(0, UNFINISHED_RESTORE_PAGE), restores: OwnerUnfinishedRestore[] = [];
    // One restore whose status fails its checks is counted, not listed, so
    // the rest stay findable.
    for (const row of page) {
      try {
        const status = statusInTransaction(storage, {workspaceId, ownerUserId: input.ownerUserId, operationId: parseLiveUpdateIdentifier(row.operation_id)});
        restores.push({operationId: status.operationId, path: String(row.current_path), phase: status.phase, proposalDigest: status.proposalDigest});
      } catch {}
    }
    const result = {restores, unreadable: page.length - restores.length,
      nextCursor: rows.length > UNFINISHED_RESTORE_PAGE ? String(page.at(-1)!.operation_id) : null};
    bounded(Buffer.byteLength(JSON.stringify(result)));
    return result;
  });
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
    const result: OwnerRestoreOptions = {document, path: input.path, grants: [], points: [], authors: [], nextBeforeCursor: null,
      nextGrantCursor: null, pendingOperation: null};
    const pending = storage.db.prepare(`SELECT operation_id FROM ${LIVE_RESTORE_OPERATIONS}
      WHERE relay_database_namespace=? AND ${whereDocument} AND ${UNFINISHED_RESTORE} ORDER BY invalidated_at_ms DESC LIMIT 2`)
      .all(namespace, ...key(document));
    if (pending.length > 1) throw relayError("conflict", "More than one restore operation is pending.");
    if (pending[0]) {
      const status = statusInTransaction(storage, {workspaceId, ownerUserId: input.ownerUserId,
        operationId: parseLiveUpdateIdentifier(pending[0].operation_id)});
      result.pendingOperation = {operationId: status.operationId, phase: status.phase, proposalDigest: status.proposalDigest};
    } else requireStopRestorable(storage, document);
    let bytes = Buffer.byteLength(JSON.stringify(result));
    const charge = (value: unknown, reserve = 0) => {bytes += Buffer.byteLength(JSON.stringify(value)) + 1 + reserve; bounded(bytes);};
    // Grants leave room for a restore point, the baseline, and the cursors.
    const fits = (value: unknown, reserve: number) => bytes + Buffer.byteLength(JSON.stringify(value)) + 1 + reserve <=
      MAX_PAYLOAD_JSON_BYTES - MAX_RESTORE_POINT_BYTES - RESTORE_TAIL_BYTES;
    Object.assign(result, grantPage(storage, input, charge, fits));
    if (beforeCursor !== undefined && !storage.db.prepare(`SELECT 1 FROM sync_relay_live_update_journal
      WHERE relay_database_namespace=? AND ${whereDocument} AND journal_cursor=?`).get(namespace, ...key(document), beforeCursor)) retired();
    for (const point of storage.db.prepare(`SELECT journal_cursor,received_at_ms,update_digest,principal_kind,principal_id,grant_id,
      grant_generation FROM sync_relay_live_update_journal
      WHERE relay_database_namespace=? AND ${whereDocument} AND journal_cursor<=? ORDER BY journal_cursor DESC LIMIT ?`)
      .iterate(namespace, ...key(document), beforeCursor === undefined ? Number.MAX_SAFE_INTEGER : beforeCursor - 1, MAX_LOG_PAGE_SIZE + 1)) {
      if (result.points.length === MAX_LOG_PAGE_SIZE) {result.nextBeforeCursor = result.points.at(-1)!.cursor; break;}
      const value = {cursor: authorityInteger(point.journal_cursor, 1), receivedAtMs: authorityInteger(point.received_at_ms),
        kind: "accepted" as const, receiptDigest: parseLiveUpdateDigest(point.update_digest),
        authority: parseServerDerivedLiveUpdateAuthority({principalKind: point.principal_kind, principalId: point.principal_id,
          grantId: point.grant_id, grantGeneration: point.grant_generation === null ? null : authorityInteger(point.grant_generation, 1)})};
      const {principalKind, principalId, grantId} = value.authority;
      const author: StopRestoreRecipient | null = principalKind === "named" && !result.authors.some(known => known.grantId === grantId)
        ? {grantId: grantId!, principalKind: "user", userId: principalId, email: null} : null;
      const cost = Buffer.byteLength(JSON.stringify(value)) + 1 + (author ? Buffer.byteLength(JSON.stringify(author)) + 1 + MAX_RESTORE_EMAIL_BYTES : 0);
      // Many long authorities end the page early, leaving room for the
      // baseline and the cursors; the next page continues from here.
      if (result.points.length > 0 && bytes + cost > MAX_PAYLOAD_JSON_BYTES - RESTORE_TAIL_BYTES) {
        result.nextBeforeCursor = result.points.at(-1)!.cursor; break;
      }
      bytes += cost; bounded(bytes); result.points.push(value);
      if (author) result.authors.push(author);
    }
    if (result.nextBeforeCursor === null) {
      if (result.points.length === MAX_LOG_PAGE_SIZE) result.nextBeforeCursor = result.points.at(-1)!.cursor;
      else {
        const baseline = {cursor: 0, receivedAtMs: null, kind: "baseline" as const, receiptDigest: parseLiveUpdateDigest(current.baseline_digest),
          authority: null};
        charge(baseline); result.points.push(baseline);
      }
    }
    bounded(Buffer.byteLength(JSON.stringify(result)));
    return result;
  });
}
