import { isDeepStrictEqual } from "node:util";
import {
  parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier,
  type LiveDocumentKey,
} from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";
import { revokeShareGrantInTransaction } from "./shares";
import { assertWorkspaceQuota } from "./workspaces";
import { LIVE_RESTORE_OPERATIONS as table } from "./liveRestoreOperationSchema";
import { effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, visibleSharePath } from "../shareFilter";
import { canonicalLiveSelector, currentLiveDocumentMoment } from "./liveDocumentAuthority";
import { requireLiveJournalHistory } from "./liveJournalHistory";

export type StopRestoreIntent = {
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

type StopRestoreOperation = {
  intent: StopRestoreIntent;
  phase: "authority-invalidated" | "fenced";
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
  const dependents = input.expectedDependentGrantIds.map(value => parseLiveUpdateIdentifier(value)).sort();
  if (new Set(dependents).size !== dependents.length) throw new TypeError("Duplicate dependent grant.");
  const document = parseLiveDocumentKey(input.document);
  if (document.mainVersionId !== "main") refuse();
  return { operationId: parseLiveUpdateIdentifier(input.operationId), ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId),
    document, shareId: parseLiveUpdateIdentifier(input.shareId), grantId: parseLiveUpdateIdentifier(input.grantId),
    expectedGrantGeneration: integer(input.expectedGrantGeneration, 1, Number.MAX_SAFE_INTEGER - 1),
    expectedDependentGrantIds: dependents, expectedFence: integer(input.expectedFence, 1, Number.MAX_SAFE_INTEGER - 1),
    restorePointCursor: integer(input.restorePointCursor), restorePointReceiptDigest: parseLiveUpdateDigest(input.restorePointReceiptDigest) };
}
function owner(storage: StorageContext, workspaceId: string, ownerUserId: string): void {
  if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) refuse();
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
  return { intent, phase: row.phase as StopRestoreOperation["phase"], oldFence: Number(row.old_fence),
    newFence: row.new_fence === null ? null : Number(row.new_fence), cutoverCursor: row.cutover_cursor === null ? null : Number(row.cutover_cursor),
    revokedGeneration: Number(row.revoked_generation), invalidatedAtMs: Number(row.invalidated_at_ms),
    fencedAtMs: row.fenced_at_ms === null ? null : Number(row.fenced_at_ms) };
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
    // Fund the final cutoff metadata before invalidation so fencing cannot run out of quota.
    const charge = Buffer.byteLength(JSON.stringify([intent.operationId, ...key(intent.document), intentJson, "authority-invalidated",
      intent.expectedFence, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, intent.expectedGrantGeneration + 1, at, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]));
    assertWorkspaceQuota(storage, intent.document.workspaceId, charge);
    const revoked = revokeShareGrantInTransaction(storage, { shareId: intent.shareId, grantId: intent.grantId,
      revokedAtMs: at, expectedDependentGrantIds: intent.expectedDependentGrantIds });
    if (!revoked.ok) refuse();
    storage.db.prepare(`INSERT INTO ${table}(operation_id,workspace_id,main_version_id,object_id,lineage_claim_id,intent_json,phase,
      old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
      VALUES (?,?,?,?,?,?,'authority-invalidated',?,NULL,NULL,?,?,NULL,?)`)
      .run(intent.operationId, ...key(intent.document), intentJson, intent.expectedFence, revoked.grant.generation, at, charge);
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
    if (saved.phase === "fenced") return saved;
    const { intent } = saved, grant = storage.getShareGrant(intent.grantId);
    if (at < saved.invalidatedAtMs || !grant || grant.status !== "revoked" || grant.generation !== saved.revokedGeneration || grant.revokedAtMs !== saved.invalidatedAtMs) refuse();
    requireAvailableJournalCursor(storage);
    const cutover = integer(Number(storage.db.prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(...key(intent.document))!.cursor), 0, Number.MAX_SAFE_INTEGER - 1);
    const changed = storage.db.prepare(`UPDATE sync_relay_live_documents SET admission_state='closed',restore_fence_generation=?
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND admission_state='open' AND restore_fence_generation=?`)
      .run(saved.oldFence + 1, ...key(intent.document), saved.oldFence);
    if (Number(changed.changes) !== 1) refuse();
    const advanced = storage.db.prepare(`UPDATE ${table} SET phase='fenced',new_fence=?,cutover_cursor=?,fenced_at_ms=? WHERE operation_id=?`)
      .run(saved.oldFence + 1, cutover, at, operationId);
    if (Number(advanced.changes) !== 1) refuse();
    return read(storage, operationId, workspaceId)!;
  });
}
