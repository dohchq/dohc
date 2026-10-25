import { visibleSharePath } from "@dohc/security-contract/share-selector";
import {requireResumedBinding,retainedRestoreLifecycle} from "./liveRestoreLifecycleStorage";
import {readServiceActivationOrigin} from "./serviceActivationOrigin";
import {readServiceActivation,serviceActivationState} from "./serviceActivationAccess";
import {moveServiceActivationRetirement} from "./serviceActivationRetirement";
import {SERVICE_HOST_ENROLLMENTS} from "./serviceHostEnrollment";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseHostControlIdentifier } from "@dohc/live-session-contract/host-control";
import {
  parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt, type LiveUpdateReceipt, type LiveDocumentKey,
} from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";
import { relayError } from "../errors";
import { revokeShareGrantInTransaction } from "./shares";
import { readCurrentShareGrant } from "./currentShareGrant";
import { assertWorkspaceQuota } from "./workspaces";
import { LIVE_RESTORE_OPERATIONS as table, UNFINISHED_RESTORE } from "./liveRestoreOperationSchema";
import { effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson } from "../shareFilter";
import { canonicalLiveSelector, currentLiveDocumentMoment, decodeLiveDocumentAuthorityStructure } from "./liveDocumentAuthority";
import { requireLiveJournalHistory, liveJournalHistoryNamespace } from "./liveJournalHistory";
import type { StoredLiveDocumentAuthority } from "./types";
import { decodeJournalRow, verifyJournalRow } from "./liveUpdateJournal";
import { parseNativeRestoreFenceReceipt, type NativeRestoreCancellation, type NativeRestoreCancellationAnswer, type NativeRestoreFence,
  type NativeRestoreFenceReceipt } from "../liveRestoreFence";
import { initialAcceptedHistoryDigest } from "../liveAcceptedHistory";
import { LIVE_RESTORE_CANCELLATIONS } from "./liveRestoreCancellationSchema";

export type StopRestoreIntent = {
  deliveryKind: "bootstrap" | "owner";
  operationId: string;
  ownerUserId: string;
  document: LiveDocumentKey;
  shareId: string;
  grantId: string;
  expectedGrantGeneration: number;
  expectedDependentGrantIds: readonly string[];
  expectedFence: number;
  restorePointCursor: number;
  restorePointReceiptDigest: string;
};

export type StopRestoreBasis = {
  binding: LiveObjectBinding;
  ownerBinding: LiveObjectBinding;
  baselineDigest: string;
  baselineByteLength: number;
  projectedDigest: string;
  projectedLength: number;
  baselineSequence: number;
  registeredAtMs: number;
  namespace: string;
  hostMode: "service" | "device";
  hostId: string;
  ownerOrigin: string | null;
};
export type StopRestoreApplied = {
  operationId: string;
  binding: LiveObjectBinding;
  kind: "bootstrap" | "owner";
  namespace: string;
  hostMode: "service" | "device";
  hostId: string;
  sourceId: string;
  localYDocSequence: number;
  terminal: LiveUpdateReceipt | null;
};
export type StopRestoreLookup = { operationId: string; workspaceId: string; ownerUserId: string };
export type StopRestorePlanInput = {
  operationId: string; ownerUserId: string; document: LiveDocumentKey;
  shareId: string; grantId: string; restorePointCursor: number; restorePointReceiptDigest: string; maxOutputBytes: number;
};
export type StopRestoreRecipient = {
  grantId: string; principalKind: "user" | "email" | "link"; userId: string | null; email: string | null;
};
export type StopRestorePlan = {
  intent: StopRestoreIntent; path: string; recipients: StopRestoreRecipient[];
};
export type StopRestoreOperation = {
  intent: StopRestoreIntent;
  basis: StopRestoreBasis;
  terminal: LiveUpdateReceipt | null;
  applied: StopRestoreApplied | null;
  nativeReceipt: NativeRestoreFenceReceipt | null;
  phase: "authority-invalidated" | "fenced" | "old-cut-applied" | "native-fenced" | "relay-admitted" | "native-applied" | "settled" | "resumed" | "declined";
  previousOperationId: string | null;
  oldFence: number;
  newFence: number | null;
  cutoverCursor: number | null;
  revokedGeneration: number;
  invalidatedAtMs: number;
  fencedAtMs: number | null;
  declinedAtMs: number | null;
};

const integer = (value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("Invalid restore integer.");
  return value;
};
const key = (document: LiveDocumentKey) => [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
function refuse(): never { throw new Error("Live restore operation conflicts with current authority."); }
function snapshot(input: StopRestoreIntent): StopRestoreIntent {
  if (input.deliveryKind !== "bootstrap" && input.deliveryKind !== "owner") throw new TypeError("Restore delivery kind is required at initiation.");
  const dependents = input.expectedDependentGrantIds.map(value => parseLiveUpdateIdentifier(value)).sort();
  if (new Set(dependents).size !== dependents.length) throw new TypeError("Duplicate dependent grant.");
  const document = parseLiveDocumentKey(input.document);
  if (document.mainVersionId !== "main") refuse();
  return { deliveryKind: input.deliveryKind, operationId: parseLiveUpdateIdentifier(input.operationId), ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId),
    document, shareId: parseLiveUpdateIdentifier(input.shareId), grantId: parseLiveUpdateIdentifier(input.grantId),
    expectedGrantGeneration: integer(input.expectedGrantGeneration, 1, Number.MAX_SAFE_INTEGER - 1),
    expectedDependentGrantIds: dependents, expectedFence: integer(input.expectedFence, 1, Number.MAX_SAFE_INTEGER - 1),
    restorePointCursor: integer(input.restorePointCursor), restorePointReceiptDigest: parseLiveUpdateDigest(input.restorePointReceiptDigest) };
}
function owner(storage: StorageContext, workspaceId: string, ownerUserId: string): void {
  if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) refuse();
}
// A fence would strand a pending service activation: it can no longer complete,
// and service restore continues only a completed one. A retiring activation
// retires before a restore begins; one that starts retiring during a restore
// is carried by its fence.
function requireNoPendingActivation(storage: StorageContext, document: LiveDocumentKey): void {
  const state = serviceActivationState(readServiceActivation(storage, document));
  if (state === "pending") throw relayError("conflict", "Live editing is still starting. Try again in a moment.");
  if (state === "retiring") throw relayError("conflict", "Live editing is still stopping. Try again in a moment.");
  if (state !== "absent" && state !== "completed") refuse();
}
// The operation row records the revocation it made. Account deletion may purge
// that grant; its absence ends the same authority for good.
export function stopRestoreRevocationHolds(storage: StorageContext, operation: StopRestoreOperation): boolean {
  const grant = storage.getShareGrant(operation.intent.grantId);
  return !grant || (grant.status === "revoked" && grant.generation === operation.revokedGeneration && grant.revokedAtMs === operation.invalidatedAtMs);
}
function requireUnretiredEnrollment(storage: StorageContext, document: LiveDocumentKey): void {
  // Enrollments are main-only and keyed by workspace/object, even after a path moves.
  if (document.mainVersionId !== "main" || storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=? AND retired=1`)
    .get(document.workspaceId, document.objectId)) refuse();
}
function basis(storage: StorageContext, intent: StopRestoreIntent, authority: StoredLiveDocumentAuthority): StopRestoreBasis {
  const share = storage.getShare(intent.shareId), control = storage.getLiveHostControl();
  const storedSelector = share && parseStoredAnyShareSelectorJson(share.selectorJson);
  const selector = storedSelector && effectiveShareSelector(storedSelector,"edit");
  if (!share || share.workspaceId !== intent.document.workspaceId || share.granterUserId !== intent.ownerUserId ||
    !selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share,selector) || !control ||
    !currentLiveDocumentMoment(storage, intent.document, authority.binding.currentPath) ||
    authority.baselineSequence <= storage.getEpochLogFloor(intent.document.workspaceId)) refuse();
  const namespace = liveJournalHistoryNamespace(storage);
  const ownerOrigin = storage.db.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?")
    .get(namespace,...key(intent.document),control.configuredHostId)?.origin_json;
  if (ownerOrigin !== undefined && typeof ownerOrigin !== "string") refuse();
  return { binding: authority.binding, ownerBinding: parseLiveObjectBinding({...authority.binding, selectorPaths: selector.paths}),
    baselineDigest: authority.baselineDigest, baselineByteLength: authority.baselineBytes.byteLength,
    projectedDigest: authority.projectedDigest, projectedLength: authority.projectedLength,
    baselineSequence: authority.baselineSequence, registeredAtMs: authority.registeredAtMs,
    namespace, hostMode: control.configuredMode, hostId: control.configuredHostId,ownerOrigin: ownerOrigin ?? null };
}
function parseBasis(value: StopRestoreBasis): StopRestoreBasis {
  if (value.hostMode !== "service" && value.hostMode !== "device") refuse();
  if (value.ownerOrigin !== null && typeof value.ownerOrigin !== "string") refuse();
  return {binding: parseLiveObjectBinding(value.binding), ownerBinding: parseLiveObjectBinding(value.ownerBinding),
    baselineDigest: parseLiveUpdateDigest(value.baselineDigest), baselineByteLength: integer(value.baselineByteLength,1,20_971_520),
    projectedDigest: parseLiveUpdateDigest(value.projectedDigest), projectedLength: integer(value.projectedLength,0,2_097_152),
    baselineSequence: integer(value.baselineSequence,1), registeredAtMs: integer(value.registeredAtMs),
    namespace: parseLiveUpdateIdentifier(value.namespace), hostMode: value.hostMode, hostId: parseHostControlIdentifier(value.hostId),ownerOrigin: value.ownerOrigin};
}
export function requireStopRestoreOwnerOrigin(storage: StorageContext, basis: StopRestoreBasis): void {
  if (basis.ownerOrigin === null) return;
  const origin = JSON.parse(basis.ownerOrigin);
  parseLiveUpdateDigest(origin?.originEvidenceDigest);
  parseLiveUpdateDigest(origin?.originHistoryEvidenceDigest);
  integer(origin?.originEventCount);
  const originalBinding=parseLiveObjectBinding(origin.originalBinding);
  requireResumedBinding(storage.db,basis.namespace,originalBinding,basis.ownerBinding);
  const activation = readServiceActivationOrigin(storage,basis.namespace,basis.binding,origin.adoptionId);
  const source = activation ? activation.source : storage.db.prepare("SELECT moment_id AS sourceMomentId FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?")
    .get(basis.binding.workspaceId,basis.binding.objectId,basis.baselineSequence);
  if (activation && (activation.baseline.relaySequence !== basis.baselineSequence || activation.baseline.projectedDigest !== basis.projectedDigest ||
    activation.baseline.projectedLength !== basis.projectedLength || activation.baseline.registeredAtMs !== basis.registeredAtMs ||
    activation.source.currentPath !== originalBinding.currentPath || activation.source.nativeHeadSequence !== origin.expectedLocalSequence)) refuse();
  if (!origin || origin.relayDatabaseNamespace !== basis.namespace || origin.sourceMomentId !== source?.sourceMomentId ||
    origin.sourceDigest !== (activation?.source.sourceDigest ?? basis.projectedDigest) || origin.sourceByteLength !== (activation?.source.sourceByteLength ?? basis.projectedLength) ||
    origin.baselineMomentRelaySequence !== basis.baselineSequence || origin.baselineRegisteredAtMs !== basis.registeredAtMs ||
    origin.bindingDigest !== createHash("sha256").update(JSON.stringify(originalBinding)).digest("hex")) refuse();
}
function authority(storage: StorageContext, intent: StopRestoreIntent, checkedBaseline?: Uint8Array): StoredLiveDocumentAuthority {
  const columns = checkedBaseline ? "workspace_id,main_version_id,object_id,lineage_claim_id,current_path,restore_fence_generation,replaces_lineage_claim_id,registered_at_ms,lineage_state,admission_state,retired_at_ms,baseline_digest,baseline_projected_sha256,baseline_projected_byte_length,baseline_moment_relay_seq,baseline_bytes=? AS baseline_matches" : "*";
  const row = storage.db.prepare(`SELECT ${columns} FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`)
    .get(...(checkedBaseline ? [checkedBaseline] : []),...key(intent.document));
  if (!row) refuse();
  if (checkedBaseline && row.baseline_matches !== 1) refuse();
  const saved = decodeLiveDocumentAuthorityStructure(storage.db,intent.document,checkedBaseline ? {...row,baseline_bytes:checkedBaseline} : row);
  if (!checkedBaseline && createHash("sha256").update(saved.baselineBytes).digest("hex") !== saved.baselineDigest) refuse();
  return saved;
}
function requireAvailableJournalCursor(storage: StorageContext): void {
  const rows = storage.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_relay_live_update_journal'").all();
  const maximum = storage.db.prepare("SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal").get()!.cursor;
  const sequence = rows.length === 0 ? 0 : integer(Number(rows[0]!.seq));
  if (rows.length > 1 || sequence < integer(Number(maximum)) || sequence === Number.MAX_SAFE_INTEGER) refuse();
}
function read(storage: StorageContext, operationId: string, workspaceId: string): StopRestoreOperation | null {
  const namespace=liveJournalHistoryNamespace(storage);
  const row = storage.db.prepare(`SELECT * FROM ${table} WHERE relay_database_namespace=? AND operation_id=? AND workspace_id=?`).get(namespace,operationId, workspaceId);
  if (!row) return null;
  const intent = snapshot(JSON.parse(String(row.intent_json)) as StopRestoreIntent);
  if (intent.operationId !== operationId || !isDeepStrictEqual(key(intent.document),
    [row.workspace_id, row.main_version_id, row.object_id, row.lineage_claim_id]) || intent.expectedFence !== row.old_fence) refuse();
  const savedBasis = parseBasis(JSON.parse(String(row.basis_json)));
  if (savedBasis.namespace!==namespace) refuse();
  if (!isDeepStrictEqual(key(savedBasis.binding),key(intent.document)) || savedBasis.binding.restoreFenceGeneration !== intent.expectedFence) refuse();
  const terminal = row.terminal_json === null ? null : JSON.parse(String(row.terminal_json));
  const applied = row.applied_json === null ? null : JSON.parse(String(row.applied_json)) as StopRestoreApplied;
  if (applied) {
    if (applied.operationId !== intent.operationId || !isDeepStrictEqual(applied.binding,intent.deliveryKind === "owner" ? savedBasis.ownerBinding : savedBasis.binding) ||
      applied.kind !== intent.deliveryKind || applied.namespace !== savedBasis.namespace || applied.hostMode !== savedBasis.hostMode ||
      applied.hostId !== savedBasis.hostId || !isDeepStrictEqual(applied.terminal,terminal)) refuse();
    parseLiveUpdateIdentifier(applied.sourceId); integer(applied.localYDocSequence);
  }
  const nativeReceipt = row.native_receipt_json === null ? null : parseNativeRestoreFenceReceipt(JSON.parse(String(row.native_receipt_json)));
  if (row.phase !== "declined" && !["authority-invalidated","fenced","old-cut-applied"].includes(String(row.phase)) !== (nativeReceipt !== null)) refuse();
  if (nativeReceipt && (!applied || !isDeepStrictEqual(nativeReceipt.operation, nativeRestoreFence(applied, Number(row.new_fence))))) refuse();
  return { intent, basis: savedBasis, terminal: terminal === null ? null : parseLiveUpdateReceipt(terminal), applied, nativeReceipt,
    previousOperationId:row.previous_operation_id===null?null:parseLiveUpdateIdentifier(row.previous_operation_id),
    phase: row.phase as StopRestoreOperation["phase"], oldFence: Number(row.old_fence),
    newFence: row.new_fence === null ? null : Number(row.new_fence), cutoverCursor: row.cutover_cursor === null ? null : Number(row.cutover_cursor),
    revokedGeneration: Number(row.revoked_generation), invalidatedAtMs: Number(row.invalidated_at_ms),
    fencedAtMs: row.fenced_at_ms === null ? null : Number(row.fenced_at_ms),
    declinedAtMs: row.declined_at_ms === null ? null : Number(row.declined_at_ms) };
}

export function nativeRestoreFence(applied: StopRestoreApplied, newFence: number): NativeRestoreFence {
  return {operationId: applied.operationId, relayDatabaseNamespace: applied.namespace, oldBinding: structuredClone(applied.binding),
    hostId: applied.hostId, newFence, origin: {kind: applied.kind, id: applied.sourceId},
    terminal: applied.terminal ? {...applied.terminal} : null, appliedSequence: applied.localYDocSequence};
}
// The largest cut, application and fence evidence the operation can save.
// Identifiers refuse controls, so a backslash is their longest JSON character.
function maximumFenceEvidence(intent: StopRestoreIntent, basis: StopRestoreBasis) {
  const receipt = {deliveryId: "\\".repeat(512),updateDigest: "f".repeat(64),journalCursor: Number.MAX_SAFE_INTEGER,acceptingHostEpoch: Number.MAX_SAFE_INTEGER};
  const applied = {operationId: intent.operationId,binding: intent.deliveryKind === "owner" ? basis.ownerBinding : basis.binding,
    kind: "bootstrap",namespace: basis.namespace,hostMode: basis.hostMode,
    hostId: basis.hostId,sourceId: "\\".repeat(512),localYDocSequence: Number.MAX_SAFE_INTEGER,terminal: receipt};
  const nativeReceipt = {operation: nativeRestoreFence(applied as StopRestoreApplied, Number.MAX_SAFE_INTEGER),
    localHeadSequence: Number.MAX_SAFE_INTEGER, recordedAtMs: Number.MAX_SAFE_INTEGER};
  return {receipt, applied, nativeReceipt};
}
const cancellationBytes = (operation: Pick<StopRestoreOperation, "intent" | "basis">, requestedAtMs: number,
  outcome: StopRestoreCancellationRow["outcome"], acknowledgmentJson: string | null, journalCursor: number | null) =>
  Buffer.byteLength(JSON.stringify([operation.basis.namespace, operation.intent.operationId, operation.intent.document.workspaceId,
    requestedAtMs, outcome, acknowledgmentJson, journalCursor]));
/** The bytes a Decline's request and its host's largest answer can take, funded as the restore begins. */
function cancellationReservation(intent: StopRestoreIntent, basis: StopRestoreBasis): number {
  const maximum = maximumFenceEvidence(intent, basis), binding = {...maximum.applied.binding, restoreFenceGeneration: Number.MAX_SAFE_INTEGER};
  const answer = {status: "fenceCancelled", hostId: basis.hostId, generation: Number.MAX_SAFE_INTEGER, binding, receipt: {fence: maximum.nativeReceipt, binding,
    endpoint: {terminalReceipt: maximum.receipt, eventCount: Number.MAX_SAFE_INTEGER, historyEvidenceDigest: "f".repeat(64)}, recordedAtMs: Number.MAX_SAFE_INTEGER}};
  return cancellationBytes({intent, basis}, Number.MAX_SAFE_INTEGER, "fence-cancelled", JSON.stringify(answer), Number.MAX_SAFE_INTEGER);
}

/** Read the exact access to stop. Initiation rechecks these coordinates in its write. */
export function readStopRestorePlan(storage: StorageContext, input: StopRestorePlanInput): StopRestorePlan {
  const document = parseLiveDocumentKey(input.document), limit = integer(input.maxOutputBytes, 1);
  return storage.readTx(() => {
    owner(storage, document.workspaceId, input.ownerUserId);
    requireLiveJournalHistory(storage);
    const current = readCurrentShareGrant(storage, {grantId: input.grantId});
    if (!current || current.share.shareId !== input.shareId || current.share.workspaceId !== document.workspaceId ||
      current.share.granterUserId !== input.ownerUserId) refuse();
    const {share, grant} = current;
    const row = storage.db.prepare(`SELECT restore_fence_generation,baseline_digest,current_path FROM sync_relay_live_documents
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND admission_state='open'`).get(...key(document));
    if (!row) refuse();
    requireUnretiredEnrollment(storage, document);
    requireNoPendingActivation(storage, document);
    const storedSelector = parseStoredAnyShareSelectorJson(share.selectorJson);
    const selector = storedSelector && effectiveShareSelector(storedSelector, grant.access);
    if (!selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector) ||
      visibleSharePath(selector, String(row.current_path)) !== row.current_path) refuse();
    const cursor = integer(input.restorePointCursor);
    const digest = cursor === 0 ? row.baseline_digest : storage.db.prepare(`SELECT update_digest FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND journal_cursor=?`).get(...key(document), cursor)?.update_digest;
    if (parseLiveUpdateDigest(input.restorePointReceiptDigest) !== digest) refuse();
    const recipients: StopRestoreRecipient[] = [{grantId: grant.grantId, principalKind: grant.principalKind,
      userId: grant.principalUserId, email: grant.principalEmail}];
    const dependentIds: string[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(recipients));
    if (grant.principalKind === "link") {
      for (const dependent of storage.db.prepare(`SELECT grant_id,principal_kind,principal_user_id,principal_email FROM sync_relay_share_grants
        WHERE parent_grant_id=? AND status='active' ORDER BY grant_id`).iterate(grant.grantId)) {
        if (dependent.principal_kind !== "user" || typeof dependent.principal_user_id !== "string" ||
          (dependent.principal_email !== null && typeof dependent.principal_email !== "string")) refuse();
        const recipient: StopRestoreRecipient = {grantId: parseLiveUpdateIdentifier(dependent.grant_id), principalKind: "user",
          userId: dependent.principal_user_id, email: dependent.principal_email};
        bytes += Buffer.byteLength(JSON.stringify(recipient)) + Buffer.byteLength(JSON.stringify(recipient.grantId)) + 2;
        if (bytes > limit) throw new Error("The complete affected access list exceeds its output budget.");
        recipients.push(recipient); dependentIds.push(recipient.grantId);
      }
    }
    let intent = snapshot({operationId: input.operationId, ownerUserId: input.ownerUserId, document, shareId: share.shareId,
      grantId: grant.grantId, deliveryKind: "bootstrap", expectedGrantGeneration: grant.generation,
      expectedDependentGrantIds: dependentIds, expectedFence: Number(row.restore_fence_generation),
      restorePointCursor: cursor, restorePointReceiptDigest: parseLiveUpdateDigest(digest)});
    const savedBasis = basis(storage, intent, authority(storage, intent));
    if (savedBasis.ownerOrigin !== null) { requireStopRestoreOwnerOrigin(storage, savedBasis); intent = {...intent, deliveryKind: "owner"}; }
    const plan = {intent, path: String(row.current_path), recipients};
    if (Buffer.byteLength(JSON.stringify(plan)) > limit) throw new Error("The complete affected access list exceeds its output budget.");
    return plan;
  });
}

export function beginStopRestore(storage: StorageContext, input: StopRestoreIntent, now: number): StopRestoreOperation {
  const intent = snapshot(input), at = integer(now);
  return storage.tx(() => {
    owner(storage, intent.document.workspaceId, intent.ownerUserId);
    requireLiveJournalHistory(storage);
    requireUnretiredEnrollment(storage, intent.document);
    const saved = read(storage, intent.operationId, intent.document.workspaceId);
    if (saved) { if (!isDeepStrictEqual(saved.intent, intent)) refuse(); return saved; }
    const namespace=liveJournalHistoryNamespace(storage);
    if (storage.db.prepare(`SELECT 1 FROM ${table} WHERE relay_database_namespace=? AND operation_id=?`).get(namespace,intent.operationId)) refuse();
    requireAvailableJournalCursor(storage);
    const document = storage.db.prepare(`SELECT restore_fence_generation,baseline_digest,baseline_moment_relay_seq,current_path FROM sync_relay_live_documents
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND admission_state='open'`).get(...key(intent.document));
    if (!document || document.restore_fence_generation !== intent.expectedFence ||
      Number(document.baseline_moment_relay_seq) <= storage.getEpochLogFloor(intent.document.workspaceId) ||
      !currentLiveDocumentMoment(storage, intent.document, String(document.current_path))) refuse();
    requireNoPendingActivation(storage, intent.document);
    const existing = storage.db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND ${UNFINISHED_RESTORE}`).get(...key(intent.document).slice(0, 3));
    if (existing) refuse();
    // The chain follows the fences restores advanced. One declined before its
    // fence left the document's generation as it was.
    const previous=storage.db.prepare(`SELECT operation_id,new_fence,lineage_claim_id,phase FROM ${table} WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND new_fence IS NOT NULL ORDER BY new_fence DESC LIMIT 1`)
      .get(namespace,...key(intent.document).slice(0,3));
    if (previous && (previous.phase!=="resumed" || previous.new_fence!==intent.expectedFence || previous.lineage_claim_id!==intent.document.lineageClaimId)) refuse();
    const previousOperationId=previous?parseLiveUpdateIdentifier(previous.operation_id):null;
    if (previousOperationId) {
      const completed=retainedRestoreLifecycle(storage.db,namespace,previousOperationId);
      if (!completed?.lifecycle.resume || completed.lifecycle.resume.binding.restoreFenceGeneration!==intent.expectedFence ||
        !isDeepStrictEqual(key(completed.lifecycle.resume.binding),key(intent.document))) refuse();
    }
    const current = readCurrentShareGrant(storage, {grantId: intent.grantId, generation: intent.expectedGrantGeneration});
    if (!current || current.share.shareId !== intent.shareId || current.share.workspaceId !== intent.document.workspaceId ||
      current.share.granterUserId !== intent.ownerUserId) refuse();
    const {share, grant} = current;
    const storedSelector = parseStoredAnyShareSelectorJson(share.selectorJson);
    const selector = storedSelector && effectiveShareSelector(storedSelector, grant.access);
    if (!selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector) ||
      visibleSharePath(selector, String(document.current_path)) !== document.current_path ||
      (grant.principalKind !== "link" && intent.expectedDependentGrantIds.length !== 0)) refuse();
    const point = intent.restorePointCursor === 0 ? document.baseline_digest : storage.db.prepare(`SELECT update_digest FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND journal_cursor=?`).get(...key(intent.document), intent.restorePointCursor)?.update_digest;
    if (point !== intent.restorePointReceiptDigest) refuse();
    if (storage.db.prepare("SELECT 1 FROM sync_relay_share_grants WHERE parent_grant_id=? AND status='active' AND generation>=? LIMIT 1")
      .get(intent.grantId, Number.MAX_SAFE_INTEGER)) refuse();
    const intentJson = JSON.stringify(intent);
    const initialBasis = basis(storage,intent,authority(storage,intent)), basisJson = JSON.stringify(initialBasis);
    if (intent.deliveryKind === "bootstrap" && initialBasis.ownerOrigin !== null) refuse();
    if (intent.deliveryKind === "owner") requireStopRestoreOwnerOrigin(storage,initialBasis);
    // Fund the final cutoff metadata and a Decline's evidence before invalidation so neither can run out of quota.
    const maximum = maximumFenceEvidence(intent, initialBasis);
    const charge = Buffer.byteLength(JSON.stringify([intent.operationId, namespace, previousOperationId, ...key(intent.document), intentJson, basisJson, JSON.stringify(maximum.receipt),JSON.stringify(maximum.applied),JSON.stringify(maximum.nativeReceipt), "authority-invalidated",
      intent.expectedFence, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, intent.expectedGrantGeneration + 1, at, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])) +
      cancellationReservation(intent, initialBasis);
    assertWorkspaceQuota(storage, intent.document.workspaceId, charge);
    const revoked = revokeShareGrantInTransaction(storage, { shareId: intent.shareId, grantId: intent.grantId,
      revokedAtMs: at, expectedDependentGrantIds: intent.expectedDependentGrantIds });
    if (!revoked.ok) refuse();
    storage.db.prepare(`INSERT INTO ${table}(operation_id,relay_database_namespace,previous_operation_id,workspace_id,main_version_id,object_id,lineage_claim_id,intent_json,basis_json,phase,
      old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
      VALUES (?,?,?,?,?,?,?,?,?,'authority-invalidated',?,NULL,NULL,?,?,NULL,?)`)
      .run(intent.operationId, namespace,previousOperationId,...key(intent.document), intentJson, basisJson, intent.expectedFence, revoked.grant.generation, at, charge);
    storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, intent.document.workspaceId);
    return read(storage, intent.operationId, intent.document.workspaceId)!;
  });
}

export function readStopRestore(storage: StorageContext, input: StopRestoreLookup): StopRestoreOperation | null {
  return storage.readTx(()=>readStopRestoreInTransaction(storage,input));
}
export function readStopRestoreInTransaction(storage: StorageContext, input: StopRestoreLookup): StopRestoreOperation | null {
  const operationId = parseLiveUpdateIdentifier(input.operationId), workspaceId = parseLiveUpdateIdentifier(input.workspaceId), userId = parseLiveUpdateIdentifier(input.ownerUserId);
  owner(storage,workspaceId,userId);return read(storage,operationId,workspaceId);
}

export function advanceStopRestoreFence(storage: StorageContext, input: { operationId: string; workspaceId: string; ownerUserId: string }, now: number): StopRestoreOperation {
  const operationId = parseLiveUpdateIdentifier(input.operationId), workspaceId = parseLiveUpdateIdentifier(input.workspaceId), userId = parseLiveUpdateIdentifier(input.ownerUserId), at = integer(now);
  return storage.tx(() => {
    owner(storage, workspaceId, userId);
    requireLiveJournalHistory(storage);
    const saved = read(storage, operationId, workspaceId);
    if (!saved) refuse();
    if (saved.phase === "declined") throw relayError("conflict", "This restore was declined. Start a new restore to restore the file.");
    if (saved.phase !== "authority-invalidated") return saved;
    const { intent } = saved;
    if (at < saved.invalidatedAtMs || !stopRestoreRevocationHolds(storage, saved)) refuse();
    // A file that left its frozen path ends the restore before the host takes part.
    if (continueStopRestoreInTransaction(storage, saved, at) === "declined") return read(storage, operationId, workspaceId)!;
    requireAvailableJournalCursor(storage);
    const current = authority(storage,intent);
    if (!current.current || !current.open || !isDeepStrictEqual(basis(storage,intent,current),saved.basis)) refuse();
    const cutover = integer(Number(storage.db.prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(...key(intent.document))!.cursor), 0, Number.MAX_SAFE_INTEGER - 1);
    const changed = storage.db.prepare(`UPDATE sync_relay_live_documents SET admission_state='closed',restore_fence_generation=?
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND admission_state='open' AND restore_fence_generation=?`)
      .run(saved.oldFence + 1, ...key(intent.document), saved.oldFence);
    if (Number(changed.changes) !== 1) refuse();
    moveServiceActivationRetirement(storage, intent.document, saved.oldFence, saved.oldFence + 1, cutover);
    const raw = cutover === 0 ? null : storage.db.prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(cutover);
    const last = raw ? decodeJournalRow(storage.db,raw) : null;
    if (last) verifyJournalRow(last);
    const terminal = last?.admitted.metadata.accepted.receipt ?? null;
    const advanced = storage.db.prepare(`UPDATE ${table} SET phase='fenced',new_fence=?,cutover_cursor=?,fenced_at_ms=?,terminal_json=? WHERE relay_database_namespace=? AND operation_id=? AND phase='authority-invalidated'`)
      .run(saved.oldFence + 1, cutover, at, JSON.stringify(terminal),saved.basis.namespace, operationId);
    if (Number(advanced.changes) !== 1) refuse();
    return read(storage, operationId, workspaceId)!;
  });
}

/** Phases a restore is fenced in but not admitted, where only the host's answer can end it. */
const CANCELLABLE: readonly StopRestoreOperation["phase"][] = ["fenced", "old-cut-applied", "native-fenced"];
type StopRestoreCancellationRow = {requestedAtMs: number; outcome: "cancelled" | "fence-cancelled" | null; acknowledgmentJson: string | null; journalCursor: number | null; accountedBytes: number};
function cancellation(storage: StorageContext, operation: StopRestoreOperation): StopRestoreCancellationRow | null {
  const row = storage.db.prepare(`SELECT requested_at_ms,outcome,acknowledgment_json,journal_cursor,accounted_bytes FROM ${LIVE_RESTORE_CANCELLATIONS} WHERE relay_database_namespace=? AND operation_id=?`)
    .get(operation.basis.namespace, operation.intent.operationId);
  if (!row) return null;
  // A host's answer leaves the operation declined; a request alone leaves it where the fence put it.
  if ((row.outcome === null) !== CANCELLABLE.includes(operation.phase) || (row.outcome !== null && operation.phase !== "declined")) refuse();
  const saved: StopRestoreCancellationRow = {requestedAtMs: integer(Number(row.requested_at_ms)), outcome: row.outcome as StopRestoreCancellationRow["outcome"],
    acknowledgmentJson: row.acknowledgment_json === null ? null : String(row.acknowledgment_json),
    journalCursor: row.journal_cursor === null ? null : integer(Number(row.journal_cursor), 1), accountedBytes: integer(Number(row.accounted_bytes), 1)};
  if (saved.accountedBytes !== cancellationBytes(operation, saved.requestedAtMs, saved.outcome, saved.acknowledgmentJson, saved.journalCursor)) refuse();
  return saved;
}
// Moves a cancellation row's bytes out of its operation's reservation. The workspace's usage does not change.
function chargeCancellation(storage: StorageContext, operation: StopRestoreOperation, bytes: number, previous: number): void {
  if (bytes > cancellationReservation(operation.intent, operation.basis)) refuse();
  if (Number(storage.db.prepare(`UPDATE ${table} SET accounted_bytes=accounted_bytes-? WHERE relay_database_namespace=? AND operation_id=? AND accounted_bytes>?`)
    .run(bytes - previous, operation.basis.namespace, operation.intent.operationId, bytes - previous).changes) !== 1) refuse();
}
function requestCancellation(storage: StorageContext, operation: StopRestoreOperation, at: number): void {
  const bytes = cancellationBytes(operation, at, null, null, null);
  chargeCancellation(storage, operation, bytes, 0);
  storage.db.prepare(`INSERT INTO ${LIVE_RESTORE_CANCELLATIONS}(relay_database_namespace,operation_id,workspace_id,requested_at_ms,accounted_bytes) VALUES (?,?,?,?,?)`)
    .run(operation.basis.namespace, operation.intent.operationId, operation.intent.document.workspaceId, at, bytes);
}
function declineBeforeFence(storage: StorageContext, operation: StopRestoreOperation, at: number): StopRestoreOperation {
  const declined = storage.db.prepare(`UPDATE ${table} SET phase='declined',declined_at_ms=? WHERE relay_database_namespace=? AND operation_id=? AND phase='authority-invalidated'`)
    .run(at, operation.basis.namespace, operation.intent.operationId);
  if (Number(declined.changes) !== 1) refuse();
  return read(storage, operation.intent.operationId, operation.intent.document.workspaceId)!;
}
/**
 * Whether the workspace keeps the identity the restore began under. A rotation
 * raises the log floor to the log's tip, at or past the restore's baseline,
 * and supersedes the restore at every phase that still advances.
 */
export function stopRestoreIdentityHolds(storage: StorageContext, operation: StopRestoreOperation): boolean {
  return operation.basis.baselineSequence > storage.getEpochLogFloor(operation.intent.document.workspaceId);
}
/**
 * Whether the object a restore froze has left its frozen path in main: its
 * latest moment names another path or none, or another object has taken that
 * path since. A workspace identity rotation refuses instead. A moment the live
 * document cannot use, such as one with invalid evidence, still holds the path.
 */
function departedFrozenPath(storage: StorageContext, operation: StopRestoreOperation): boolean {
  const {document} = operation.intent, path = operation.basis.binding.currentPath;
  if (!stopRestoreIdentityHolds(storage, operation)) refuse();
  const latest = storage.db.prepare(`SELECT path FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND version_id='main' ORDER BY relay_seq DESC LIMIT 1`)
    .get(document.workspaceId, document.objectId);
  if (!latest) refuse();
  return latest.path !== path || storage.objectIdAtPathInVersion({workspaceId: document.workspaceId, versionId: "main", path}) !== document.objectId;
}
/** Whether the restore's object still holds its frozen path. Admission refuses otherwise. */
export function stopRestoreHoldsFrozenPath(storage: StorageContext, operation: StopRestoreOperation): boolean {
  return !departedFrozenPath(storage, operation);
}
/** How a restore goes on: at its frozen path, by its host's cancellation, or not at all. */
export type StopRestoreContinuation = "continue" | "cancel" | "declined";
/**
 * Called in the serialized writer Decline and admission share. A restore
 * that is not admitted ends once its frozen path departs, as a Decline would:
 * at once before its fence, and otherwise by recording the request its
 * fencing host then answers. An admitted restore finishes at its frozen path,
 * under the workspace identity it began in.
 */
export function continueStopRestoreInTransaction(storage: StorageContext, operation: StopRestoreOperation, now: number): StopRestoreContinuation {
  const at = integer(now);
  if (operation.phase === "declined") return "declined";
  if (operation.phase !== "authority-invalidated" && !CANCELLABLE.includes(operation.phase)) {
    if (operation.phase !== "resumed" && !stopRestoreIdentityHolds(storage, operation)) refuse();
    return "continue";
  }
  if (operation.phase !== "authority-invalidated" && cancellation(storage, operation)) return "cancel";
  if (!departedFrozenPath(storage, operation)) return "continue";
  if (at < operation.invalidatedAtMs) refuse();
  if (operation.phase === "authority-invalidated") {declineBeforeFence(storage, operation, at); return "declined";}
  requestCancellation(storage, operation, at);
  return "cancel";
}
/** Whether the owner declined this restore after its fence. Admission refuses from then on. */
export function stopRestoreDeclineRecorded(storage: StorageContext, operation: StopRestoreOperation): boolean {
  return cancellation(storage, operation) !== null;
}
/** The binding the host held for the operation at its old generation. */
function nativeBinding(operation: StopRestoreOperation): LiveObjectBinding {
  return operation.intent.deliveryKind === "owner" ? operation.basis.ownerBinding : operation.basis.binding;
}
// The journal cursor the next accepted delivery would take, consumed by a
// control entry so it orders among deliveries without being one.
function allocateJournalCursor(storage: StorageContext): number {
  requireAvailableJournalCursor(storage);
  const name = "sync_relay_live_update_journal";
  if (storage.db.prepare("SELECT 1 FROM sqlite_sequence WHERE name=?").get(name)) storage.db.prepare("UPDATE sqlite_sequence SET seq=seq+1 WHERE name=?").run(name);
  else storage.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES (?,1)").run(name);
  return integer(Number(storage.db.prepare("SELECT seq FROM sqlite_sequence WHERE name=?").get(name)!.seq), 1);
}

/**
 * Ends a restore the relay has not admitted. Before its fence this finishes
 * Decline at once, in the same serialized writer as the fence, so at most
 * one of them takes the operation; the document keeps its generation and its
 * open retirement's key. After its fence this records the request, so relay
 * admission refuses from then on, and the operation waits for the fencing
 * host's answer. Access stays revoked either way.
 */
export function declineStopRestore(storage: StorageContext, input: StopRestoreLookup, now: number): StopRestoreOperation {
  const operationId = parseLiveUpdateIdentifier(input.operationId), workspaceId = parseLiveUpdateIdentifier(input.workspaceId), userId = parseLiveUpdateIdentifier(input.ownerUserId), at = integer(now);
  return storage.tx(() => {
    owner(storage, workspaceId, userId);
    requireLiveJournalHistory(storage);
    const saved = read(storage, operationId, workspaceId);
    if (!saved) refuse();
    if (saved.phase === "declined") return saved;
    if (at < saved.invalidatedAtMs) refuse();
    if (CANCELLABLE.includes(saved.phase)) {
      if (!cancellation(storage, saved)) requestCancellation(storage, saved, at);
      return saved;
    }
    if (saved.phase !== "authority-invalidated") {
      throw relayError("conflict", "The restore is already being applied, so it can no longer be declined. Retry to finish it.");
    }
    return declineBeforeFence(storage, saved, at);
  });
}

/** The native cancellation a recorded Decline still needs from the fencing host, or null once it is answered. */
export function readStopRestoreCancellation(storage: StorageContext, input: StopRestoreLookup): NativeRestoreCancellation | null {
  owner(storage, input.workspaceId, input.ownerUserId);
  const operation = read(storage, input.operationId, input.workspaceId);
  if (!operation) refuse();
  const requested = cancellation(storage, operation);
  if (!requested) refuse();
  if (requested.outcome !== null) return null;
  const {document} = operation.intent;
  return {operationId: operation.intent.operationId, objectId: document.objectId, lineageClaimId: document.lineageClaimId,
    hostId: operation.basis.hostId, newFence: operation.newFence!};
}

/**
 * Records the fencing host's durable answer to a recorded Decline, inside
 * the caller's transaction. `cancelled` proves no native fence committed:
 * the document and its open retirement go back to the old generation, and
 * the operation keeps no fence. `fenceCancelled` proves the committed fence
 * ended before any application: the document and its retirement stay at the
 * new generation, and the receipt takes its own journal cursor ahead of any
 * successor's delivery. Admission stays closed either way.
 */
export function acknowledgeStopRestoreCancellation(storage: StorageContext, input: StopRestoreLookup, answer: NativeRestoreCancellationAnswer, now: number): StopRestoreOperation {
  owner(storage, input.workspaceId, input.ownerUserId);
  const at = integer(now), saved = read(storage, input.operationId, input.workspaceId);
  if (!saved) refuse();
  const requested = cancellation(storage, saved);
  if (!requested) refuse();
  if (requested.outcome !== null) {
    if (!isDeepStrictEqual(JSON.parse(requested.acknowledgmentJson!), answer)) refuse();
    return saved;
  }
  const {document} = saved.intent, newFence = saved.newFence!, cutover = saved.cutoverCursor!;
  if (answer.hostId !== saved.basis.hostId || at < saved.invalidatedAtMs) refuse();
  const generation = storage.db.prepare(`SELECT 1 FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?
    AND restore_fence_generation=? AND lineage_state='current' AND admission_state='closed'`).get(...key(document), newFence);
  if (!generation) refuse();
  const where = `relay_database_namespace=? AND operation_id=? AND phase=?`, params = [saved.basis.namespace, saved.intent.operationId, saved.phase];
  let journalCursor: number | null = null;
  if (answer.status === "cancelled") {
    if (saved.nativeReceipt || answer.generation !== saved.oldFence || !isDeepStrictEqual(answer.binding, nativeBinding(saved))) refuse();
    if (Number(storage.db.prepare(`UPDATE sync_relay_live_documents SET restore_fence_generation=? WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND restore_fence_generation=?`)
      .run(saved.oldFence, ...key(document), newFence).changes) !== 1) refuse();
    moveServiceActivationRetirement(storage, document, newFence, saved.oldFence, cutover);
    if (Number(storage.db.prepare(`UPDATE ${table} SET phase='declined',declined_at_ms=?,new_fence=NULL,cutover_cursor=NULL,fenced_at_ms=NULL,terminal_json=NULL,applied_json=NULL,native_receipt_json=NULL WHERE ${where}`)
      .run(at, ...params).changes) !== 1) refuse();
  } else {
    const {receipt} = answer;
    if (!saved.applied || !isDeepStrictEqual(receipt.fence.operation, nativeRestoreFence(saved.applied, newFence)) ||
      !isDeepStrictEqual(receipt.binding, {...nativeBinding(saved), restoreFenceGeneration: newFence}) ||
      (saved.nativeReceipt && !isDeepStrictEqual(receipt.fence, saved.nativeReceipt))) refuse();
    // The endpoint the host froze is the relay's accepted history through the cutover.
    const terminal = cutover === 0 ? null : storage.db.prepare(`SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?
      AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(cutover, ...key(document));
    const digest = terminal ? terminal.accepted_evidence_digest : initialAcceptedHistoryDigest(saved.basis.namespace, document);
    if ((cutover !== 0 && !terminal) || receipt.endpoint.eventCount !== (terminal ? Number(terminal.accepted_event_count) : 0) ||
      receipt.endpoint.historyEvidenceDigest !== digest) refuse();
    journalCursor = allocateJournalCursor(storage);
    if (Number(storage.db.prepare(`UPDATE ${table} SET phase='declined',declined_at_ms=?,native_receipt_json=? WHERE ${where}`)
      .run(at, JSON.stringify(receipt.fence), ...params).changes) !== 1) refuse();
  }
  const outcome = answer.status === "cancelled" ? "cancelled" : "fence-cancelled", acknowledgmentJson = JSON.stringify(answer);
  const bytes = cancellationBytes(saved, requested.requestedAtMs, outcome, acknowledgmentJson, journalCursor);
  chargeCancellation(storage, saved, bytes, requested.accountedBytes);
  if (Number(storage.db.prepare(`UPDATE ${LIVE_RESTORE_CANCELLATIONS} SET outcome=?,acknowledgment_json=?,journal_cursor=?,accounted_bytes=? WHERE relay_database_namespace=? AND operation_id=? AND outcome IS NULL`)
    .run(outcome, acknowledgmentJson, journalCursor, bytes, saved.basis.namespace, saved.intent.operationId).changes) !== 1) refuse();
  return read(storage, input.operationId, input.workspaceId)!;
}

// Called inside the delivery store's transaction. It grants no public historical authority.
export function requireStopRestoreCut(storage: StorageContext, input: StopRestoreLookup, checkedBaseline?: Uint8Array): {operation: StopRestoreOperation; authority: StoredLiveDocumentAuthority} {
  owner(storage,input.workspaceId,input.ownerUserId);
  const operation = read(storage,input.operationId,input.workspaceId);
  // A recorded Decline holds the fence, preparation and admission until the host answers it.
  if (!operation || operation.phase === "authority-invalidated" || operation.phase === "declined" || cancellation(storage,operation)) refuse();
  const current = authority(storage,operation.intent,checkedBaseline);
  if (!current.current || current.open || current.binding.restoreFenceGeneration !== operation.newFence) refuse();
  const historical = {...current,open: true,binding: {...current.binding,restoreFenceGeneration: operation.oldFence}};
  if (!isDeepStrictEqual(basis(storage,operation.intent,historical),operation.basis)) refuse();
  if (!stopRestoreRevocationHolds(storage, operation)) refuse();
  const raw = storage.db.prepare("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor DESC LIMIT 1").get(...key(operation.intent.document));
  const terminal = raw ? parseLiveUpdateReceipt({deliveryId: raw.delivery_id,updateDigest: raw.update_digest,journalCursor: raw.journal_cursor,acceptingHostEpoch: raw.accepting_host_epoch}) : null;
  if (!isDeepStrictEqual(terminal,operation.terminal) || (terminal?.journalCursor ?? 0) !== operation.cutoverCursor) refuse();
  return {operation,authority: historical};
}
