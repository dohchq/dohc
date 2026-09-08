import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseHostControlIdentifier } from "@dohc/live-session-contract/host-control";
import {
  parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt, type LiveUpdateReceipt, type LiveDocumentKey,
} from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";
import { revokeShareGrantInTransaction } from "./shares";
import { assertWorkspaceQuota } from "./workspaces";
import { LIVE_RESTORE_OPERATIONS as table } from "./liveRestoreOperationSchema";
import { effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, visibleSharePath } from "../shareFilter";
import { canonicalLiveSelector, currentLiveDocumentMoment, decodeLiveDocumentAuthorityStructure } from "./liveDocumentAuthority";
import { requireLiveJournalHistory, liveJournalHistoryNamespace } from "./liveJournalHistory";
import type { StoredLiveDocumentAuthority } from "./types";
import { decodeJournalRow, verifyJournalRow } from "./liveUpdateJournal";
import { parseNativeRestoreFenceReceipt, type NativeRestoreFence, type NativeRestoreFenceReceipt } from "../liveRestoreFence";

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
export type StopRestoreOperation = {
  intent: StopRestoreIntent;
  basis: StopRestoreBasis;
  terminal: LiveUpdateReceipt | null;
  applied: StopRestoreApplied | null;
  nativeReceipt: NativeRestoreFenceReceipt | null;
  phase: "authority-invalidated" | "fenced" | "old-cut-applied" | "native-fenced";
  oldFence: number;
  newFence: number | null;
  cutoverCursor: number | null;
  revokedGeneration: number;
  invalidatedAtMs: number;
  fencedAtMs: number | null;
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
  const source = storage.db.prepare("SELECT moment_id FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?")
    .get(basis.binding.workspaceId,basis.binding.objectId,basis.baselineSequence);
  if (!origin || origin.relayDatabaseNamespace !== basis.namespace || origin.sourceMomentId !== source?.moment_id ||
    origin.sourceDigest !== basis.projectedDigest || origin.sourceByteLength !== basis.projectedLength ||
    origin.baselineMomentRelaySequence !== basis.baselineSequence || origin.baselineRegisteredAtMs !== basis.registeredAtMs ||
    origin.bindingDigest !== createHash("sha256").update(JSON.stringify(basis.ownerBinding)).digest("hex")) refuse();
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
  const row = storage.db.prepare(`SELECT * FROM ${table} WHERE operation_id=? AND workspace_id=?`).get(operationId, workspaceId);
  if (!row) return null;
  const intent = snapshot(JSON.parse(String(row.intent_json)) as StopRestoreIntent);
  if (intent.operationId !== operationId || !isDeepStrictEqual(key(intent.document),
    [row.workspace_id, row.main_version_id, row.object_id, row.lineage_claim_id]) || intent.expectedFence !== row.old_fence) refuse();
  const savedBasis = parseBasis(JSON.parse(String(row.basis_json)));
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
  if ((row.phase === "native-fenced") !== (nativeReceipt !== null)) refuse();
  if (nativeReceipt && (!applied || !isDeepStrictEqual(nativeReceipt.operation, nativeRestoreFence(applied, Number(row.new_fence))))) refuse();
  return { intent, basis: savedBasis, terminal: terminal === null ? null : parseLiveUpdateReceipt(terminal), applied, nativeReceipt,
    phase: row.phase as StopRestoreOperation["phase"], oldFence: Number(row.old_fence),
    newFence: row.new_fence === null ? null : Number(row.new_fence), cutoverCursor: row.cutover_cursor === null ? null : Number(row.cutover_cursor),
    revokedGeneration: Number(row.revoked_generation), invalidatedAtMs: Number(row.invalidated_at_ms),
    fencedAtMs: row.fenced_at_ms === null ? null : Number(row.fenced_at_ms) };
}

export function nativeRestoreFence(applied: StopRestoreApplied, newFence: number): NativeRestoreFence {
  return {operationId: applied.operationId, relayDatabaseNamespace: applied.namespace, oldBinding: structuredClone(applied.binding),
    hostId: applied.hostId, newFence, origin: {kind: applied.kind, id: applied.sourceId},
    terminal: applied.terminal ? {...applied.terminal} : null, appliedSequence: applied.localYDocSequence};
}

// Internal storage operation. No network or desktop route initiates restoration.
export function beginStopRestore(storage: StorageContext, input: StopRestoreIntent, now: number): StopRestoreOperation {
  const intent = snapshot(input), at = integer(now);
  return storage.tx(() => {
    owner(storage, intent.document.workspaceId, intent.ownerUserId);
    requireLiveJournalHistory(storage);
    const saved = read(storage, intent.operationId, intent.document.workspaceId);
    if (saved) { if (!isDeepStrictEqual(saved.intent, intent)) refuse(); return saved; }
    if (storage.db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).get(intent.operationId)) refuse();
    requireAvailableJournalCursor(storage);
    const document = storage.db.prepare(`SELECT restore_fence_generation,baseline_digest,baseline_moment_relay_seq,current_path FROM sync_relay_live_documents
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND admission_state='open'`).get(...key(intent.document));
    if (!document || document.restore_fence_generation !== intent.expectedFence ||
      Number(document.baseline_moment_relay_seq) <= storage.getEpochLogFloor(intent.document.workspaceId) ||
      !currentLiveDocumentMoment(storage, intent.document, String(document.current_path))) refuse();
    const existing = storage.db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND main_version_id=? AND object_id=?`).get(...key(intent.document).slice(0, 3));
    if (existing) refuse();
    const share = storage.getShare(intent.shareId), grant = storage.getShareGrant(intent.grantId);
    if (!share || share.workspaceId !== intent.document.workspaceId || share.granterUserId !== intent.ownerUserId ||
      !grant || grant.shareId !== intent.shareId || grant.generation !== intent.expectedGrantGeneration || grant.status !== "active") refuse();
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
    // Fund the final cutoff metadata before invalidation so fencing cannot run out of quota.
    const maximumReceipt = {deliveryId: "\\".repeat(512),updateDigest: "f".repeat(64),journalCursor: Number.MAX_SAFE_INTEGER,acceptingHostEpoch: Number.MAX_SAFE_INTEGER};
    const maximumApplied = {operationId: intent.operationId,binding: intent.deliveryKind === "owner" ? initialBasis.ownerBinding : initialBasis.binding,
      kind: "bootstrap",namespace: initialBasis.namespace,hostMode: initialBasis.hostMode,
      hostId: initialBasis.hostId,sourceId: "\\".repeat(512),localYDocSequence: Number.MAX_SAFE_INTEGER,terminal: maximumReceipt};
    const maximumNativeReceipt = {operation: nativeRestoreFence(maximumApplied as StopRestoreApplied, Number.MAX_SAFE_INTEGER),
      localHeadSequence: Number.MAX_SAFE_INTEGER, recordedAtMs: Number.MAX_SAFE_INTEGER};
    const charge = Buffer.byteLength(JSON.stringify([intent.operationId, ...key(intent.document), intentJson, basisJson, JSON.stringify(maximumReceipt),JSON.stringify(maximumApplied),JSON.stringify(maximumNativeReceipt), "authority-invalidated",
      intent.expectedFence, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, intent.expectedGrantGeneration + 1, at, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]));
    assertWorkspaceQuota(storage, intent.document.workspaceId, charge);
    const revoked = revokeShareGrantInTransaction(storage, { shareId: intent.shareId, grantId: intent.grantId,
      revokedAtMs: at, expectedDependentGrantIds: intent.expectedDependentGrantIds });
    if (!revoked.ok) refuse();
    storage.db.prepare(`INSERT INTO ${table}(operation_id,workspace_id,main_version_id,object_id,lineage_claim_id,intent_json,basis_json,phase,
      old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
      VALUES (?,?,?,?,?,?,?,'authority-invalidated',?,NULL,NULL,?,?,NULL,?)`)
      .run(intent.operationId, ...key(intent.document), intentJson, basisJson, intent.expectedFence, revoked.grant.generation, at, charge);
    storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, intent.document.workspaceId);
    return read(storage, intent.operationId, intent.document.workspaceId)!;
  });
}

export function readStopRestore(storage: StorageContext, input: { operationId: string; workspaceId: string; ownerUserId: string }): StopRestoreOperation | null {
  const operationId = parseLiveUpdateIdentifier(input.operationId), workspaceId = parseLiveUpdateIdentifier(input.workspaceId), userId = parseLiveUpdateIdentifier(input.ownerUserId);
  return storage.readTx(() => { owner(storage, workspaceId, userId); return read(storage, operationId, workspaceId); });
}

export function advanceStopRestoreFence(storage: StorageContext, input: { operationId: string; workspaceId: string; ownerUserId: string }, now: number): StopRestoreOperation {
  const operationId = parseLiveUpdateIdentifier(input.operationId), workspaceId = parseLiveUpdateIdentifier(input.workspaceId), userId = parseLiveUpdateIdentifier(input.ownerUserId), at = integer(now);
  return storage.tx(() => {
    owner(storage, workspaceId, userId);
    requireLiveJournalHistory(storage);
    const saved = read(storage, operationId, workspaceId);
    if (!saved) refuse();
    if (saved.phase !== "authority-invalidated") return saved;
    const { intent } = saved, grant = storage.getShareGrant(intent.grantId);
    if (at < saved.invalidatedAtMs || !grant || grant.status !== "revoked" || grant.generation !== saved.revokedGeneration || grant.revokedAtMs !== saved.invalidatedAtMs) refuse();
    requireAvailableJournalCursor(storage);
    const current = authority(storage,intent);
    if (!current.current || !current.open || !isDeepStrictEqual(basis(storage,intent,current),saved.basis)) refuse();
    const cutover = integer(Number(storage.db.prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(...key(intent.document))!.cursor), 0, Number.MAX_SAFE_INTEGER - 1);
    const changed = storage.db.prepare(`UPDATE sync_relay_live_documents SET admission_state='closed',restore_fence_generation=?
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND admission_state='open' AND restore_fence_generation=?`)
      .run(saved.oldFence + 1, ...key(intent.document), saved.oldFence);
    if (Number(changed.changes) !== 1) refuse();
    const raw = cutover === 0 ? null : storage.db.prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(cutover);
    const last = raw ? decodeJournalRow(storage.db,raw) : null;
    if (last) verifyJournalRow(last);
    const terminal = last?.admitted.metadata.accepted.receipt ?? null;
    const advanced = storage.db.prepare(`UPDATE ${table} SET phase='fenced',new_fence=?,cutover_cursor=?,fenced_at_ms=?,terminal_json=? WHERE operation_id=?`)
      .run(saved.oldFence + 1, cutover, at, JSON.stringify(terminal), operationId);
    if (Number(advanced.changes) !== 1) refuse();
    return read(storage, operationId, workspaceId)!;
  });
}

// Called inside the delivery store's transaction. It grants no public historical authority.
export function requireStopRestoreCut(storage: StorageContext, input: StopRestoreLookup, checkedBaseline?: Uint8Array): {operation: StopRestoreOperation; authority: StoredLiveDocumentAuthority} {
  owner(storage,input.workspaceId,input.ownerUserId);
  const operation = read(storage,input.operationId,input.workspaceId);
  if (!operation || operation.phase === "authority-invalidated") refuse();
  const current = authority(storage,operation.intent,checkedBaseline);
  if (!current.current || current.open || current.binding.restoreFenceGeneration !== operation.newFence) refuse();
  const historical = {...current,open: true,binding: {...current.binding,restoreFenceGeneration: operation.oldFence}};
  if (!isDeepStrictEqual(basis(storage,operation.intent,historical),operation.basis)) refuse();
  const grant = storage.getShareGrant(operation.intent.grantId);
  if (!grant || grant.status !== "revoked" || grant.generation !== operation.revokedGeneration || grant.revokedAtMs !== operation.invalidatedAtMs) refuse();
  const raw = storage.db.prepare("SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor DESC LIMIT 1").get(...key(operation.intent.document));
  const terminal = raw ? parseLiveUpdateReceipt({deliveryId: raw.delivery_id,updateDigest: raw.update_digest,journalCursor: raw.journal_cursor,acceptingHostEpoch: raw.accepting_host_epoch}) : null;
  if (!isDeepStrictEqual(terminal,operation.terminal) || (terminal?.journalCursor ?? 0) !== operation.cutoverCursor) refuse();
  return {operation,authority: historical};
}
