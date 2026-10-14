import {createHash} from "node:crypto";
import {parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier, type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {RelayReleaseClaim, RelayReleaseClaimSummary, RelayReleaseRequest, RelayReleaseResponse} from "@dohc/live-session-contract/release-claim";
import type {StorageContext} from "./context";
import {badRequest, notFound, ReleaseClaimRefusal} from "../errors";
import {SERVICE_HOST_ENROLLMENTS} from "./serviceHostEnrollment";
import {RELEASE_TOMBSTONES} from "./releaseClaimSchema";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";
import {liveJournalHistoryNamespace} from "./liveJournalHistory";
import {readAcceptedHistory, readAcceptedHistoryDeliveryMetadata, RestoreHistoryBudget} from "./liveAcceptedHistory";
import {decodeLiveDocumentAuthority, currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {assertWorkspaceQuota} from "./workspaces";
import type {SqliteDb} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Scope = Pick<RelayReleaseRequest,"document"|"replicationEpoch"|"streamIdentity"|"relayDatabaseNamespace"|"restoreFenceGeneration">;
type StoredClaim = RelayReleaseClaim & {releaseDigest: string};
function readClaim(value: unknown): StoredClaim | null {
  if (value == null) return null;
  const claim = JSON.parse(String(value)) as StoredClaim;
  const {digest: storedDigest, ...identity} = claim;
  if (digest(JSON.stringify(identity)) !== storedDigest) throw new Error("Release claim is damaged.");
  return claim;
}
function publicClaim(claim: StoredClaim): RelayReleaseClaim {
  const {releaseDigest: _releaseDigest, ...result} = claim; return result;
}
function claimSummary(claim: StoredClaim): RelayReleaseClaimSummary {
  const {proof: _proof, receipts: _receipts, ...anchor} = claim.anchor;
  return {digest:claim.digest,computerName:claim.computerName,anchor};
}
const enablementStatements = new WeakMap<SqliteDb,{claim: ReturnType<SqliteDb["prepare"]>; fence: ReturnType<SqliteDb["prepare"]>}>();
function enablementQueries(storage: StorageContext) {
  let queries=enablementStatements.get(storage.db);
  if (!queries) {
    queries={claim:storage.db.prepare(`SELECT release_claim_json,path FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`),
      fence:storage.db.prepare(`UPDATE ${RELEASE_TOMBSTONES} SET publication_fenced=1 WHERE workspace_id=? AND object_id=? AND publication_fenced=0`)};
    enablementStatements.set(storage.db,queries);
  }
  return queries;
}
function ownedEnrollment(storage: StorageContext, document: LiveDocumentKey, ownerUserId: string) {
  storage.captureStanding();
  if (!storage.workspaceIsOwnedBy(document.workspaceId, ownerUserId)) throw notFound();
  const row = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
    .get(document.workspaceId,document.objectId);
  if (row && row.owner_user_id !== ownerUserId) throw new ReleaseClaimRefusal("document-unavailable");
  return row;
}
export function requireNoReleaseClaim(storage: StorageContext, document: {workspaceId: string; objectId: string}, path?: string): void {
  const row = enablementQueries(storage).claim.get(document.workspaceId,document.objectId);
  const claim = readClaim(row?.release_claim_json);
  if (claim) throw new ReleaseClaimRefusal("release-claimed", claimSummary(claim), path ?? String(row!.path));
}
export function requireReleaseEnablement(storage: StorageContext, document: {workspaceId: string; objectId: string}, path?: string): void {
  requireNoReleaseClaim(storage,document,path);
  enablementQueries(storage).fence.run(document.workspaceId,document.objectId);
}
function currentScope(storage: StorageContext, scope: Scope, enrollment: Record<string,unknown>) {
  const {document} = scope;
  if (document.mainVersionId !== "main" || scope.relayDatabaseNamespace !== liveJournalHistoryNamespace(storage) ||
    storage.verifyWorkspaceIdentity({workspaceId: document.workspaceId, replicationEpoch: scope.replicationEpoch, streamIdentity: scope.streamIdentity}) !== "matched" ||
    enrollment.replication_epoch !== scope.replicationEpoch || enrollment.stream_identity !== scope.streamIdentity) throw new ReleaseClaimRefusal("workspace-changed");
  if (storage.db.prepare(`SELECT 1 FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND phase<>'resumed'`)
    .get(document.workspaceId,document.objectId)) throw new ReleaseClaimRefusal("restore-in-progress");
  const raw = storage.db.prepare("SELECT * FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current'")
    .get(document.workspaceId,document.objectId);
  if (!raw || raw.lineage_claim_id !== document.lineageClaimId || raw.restore_fence_generation !== scope.restoreFenceGeneration) throw new ReleaseClaimRefusal("restore-fenced");
  const authority = decodeLiveDocumentAuthority(storage.db,document,raw);
  const latest = storage.db.prepare("SELECT path FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND version_id='main' ORDER BY relay_seq DESC LIMIT 1")
    .get(document.workspaceId,document.objectId);
  if (!authority.open || authority.baselineSequence <= storage.getEpochLogFloor(document.workspaceId) ||
    typeof latest?.path !== "string" || !currentLiveDocumentMoment(storage,document,latest.path)) throw new ReleaseClaimRefusal("document-unavailable");
  const high = storage.db.prepare("SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?")
    .get(document.workspaceId,document.objectId,document.lineageClaimId)!;
  return {authority, cursor: Number(high.cursor)};
}
function historyAt(storage: StorageContext, scope: Scope, authority: ReturnType<typeof currentScope>["authority"], cursor: number) {
  const binding: LiveObjectBinding = authority.binding;
  return readAcceptedHistory(storage,{document:scope.document,namespace:scope.relayDatabaseNamespace,through:cursor,
    baseline:authority.baselineBytes,baselineDigest:authority.baselineDigest,originBinding:binding},new RestoreHistoryBudget(64*1024*1024,100_000));
}
function receiptsAt(storage: StorageContext, request: RelayReleaseRequest, through: number, eventCount: number) {
  const budget = new RestoreHistoryBudget(4*1024*1024,256);
  return (request.receiptDeliveryIds ?? []).map(deliveryId => {
    const metadata = readAcceptedHistoryDeliveryMetadata(storage,{document:request.document,namespace:request.relayDatabaseNamespace,through,eventCount,deliveryId},budget);
    if (metadata && metadata.accepted.binding.restoreFenceGeneration !== request.restoreFenceGeneration) throw new ReleaseClaimRefusal("restore-fenced");
    return {deliveryId,metadata};
  });
}
function tombstone(storage: StorageContext, document: LiveDocumentKey, releaseDigest: string) {
  return storage.db.prepare(`SELECT 1 FROM ${RELEASE_TOMBSTONES} WHERE workspace_id=? AND object_id=? AND release_digest=?`)
    .get(document.workspaceId,document.objectId,releaseDigest);
}
function setClaim(storage: StorageContext, document: LiveDocumentKey, claim: StoredClaim | null, old: unknown): void {
  const json = claim === null ? null : JSON.stringify(claim), charge = (json === null ? 0 : Buffer.byteLength(json)) - (old == null ? 0 : Buffer.byteLength(String(old)));
  if (charge > 0) assertWorkspaceQuota(storage,document.workspaceId,charge);
  storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET release_claim_json=?,accounted_bytes=accounted_bytes+? WHERE workspace_id=? AND object_id=?`)
    .run(json,charge,document.workspaceId,document.objectId);
  storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge,document.workspaceId);
}
export function releaseClaimRequest(storage: StorageContext, ownerUserId: string, raw: unknown, guard: () => void): RelayReleaseResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Invalid release request.");
  const request = raw as RelayReleaseRequest;
  if (Object.keys(request).some(key => !["action","document","replicationEpoch","streamIdentity","relayDatabaseNamespace","restoreFenceGeneration","releaseId","computerName","requireRetired","claimDigest","receiptDeliveryIds"].includes(key)) ||
    !["acquire","status","complete","abandon","catch-up"].includes(request.action) || typeof request.replicationEpoch !== "string" || !request.replicationEpoch ||
    typeof request.streamIdentity !== "string" || !request.streamIdentity || typeof request.relayDatabaseNamespace !== "string" || !request.relayDatabaseNamespace ||
    !Number.isSafeInteger(request.restoreFenceGeneration) || request.restoreFenceGeneration < 0 ||
    (request.requireRetired !== undefined && typeof request.requireRetired !== "boolean") ||
    (request.computerName !== undefined && (typeof request.computerName !== "string" || !request.computerName.trim() || request.computerName.length > 64))) throw badRequest("Invalid release request.");
  let document: LiveDocumentKey, releaseDigest: string | undefined;
  try {
    document = parseLiveDocumentKey(request.document);
    if (request.releaseId !== undefined) releaseDigest = digest(parseLiveUpdateDigest(request.releaseId));
    if (request.action === "acquire" || request.action === "complete") {if (!releaseDigest) throw Error();}
    if (request.action === "abandon") parseLiveUpdateDigest(request.claimDigest);
    if (request.receiptDeliveryIds !== undefined) {
      if (!Array.isArray(request.receiptDeliveryIds) || request.receiptDeliveryIds.length > 256 || new Set(request.receiptDeliveryIds).size !== request.receiptDeliveryIds.length) throw Error();
      request.receiptDeliveryIds.forEach(value => parseLiveUpdateIdentifier(value));
    }
  } catch {throw badRequest("Invalid release identity.");}
  const scope = {...request,document};
  const transact = request.action === "status" || request.action === "catch-up" ? storage.readTx.bind(storage) : storage.tx.bind(storage);
  return transact((): RelayReleaseResponse => {
    guard(); const enrollment = ownedEnrollment(storage,document,ownerUserId);
    if (releaseDigest && ["acquire","complete","status"].includes(request.action) && tombstone(storage,document,releaseDigest)) throw new ReleaseClaimRefusal("release-abandoned");
    if (!enrollment) {
      if (request.action === "complete") return {ok:true,status:"not-held"};
      throw new ReleaseClaimRefusal("document-unavailable");
    }
    const claim = readClaim(enrollment.release_claim_json);
    if (request.action === "complete") {
      if (claim?.releaseDigest === releaseDigest) setClaim(storage,document,null,enrollment.release_claim_json);
      return {ok:true,status:"not-held"};
    }
    if (request.action === "abandon") {
      if (storage.db.prepare(`SELECT 1 FROM ${RELEASE_TOMBSTONES} WHERE workspace_id=? AND object_id=? AND claim_digest=?`)
        .get(document.workspaceId,document.objectId,request.claimDigest)) return {ok:true,status:"not-held"};
      if (!claim || claim.digest !== request.claimDigest) throw new ReleaseClaimRefusal("release-changed",claim ? claimSummary(claim) : undefined);
      const charge = Buffer.byteLength(JSON.stringify([document.workspaceId,document.objectId,claim.releaseDigest,claim.digest,0]));
      setClaim(storage,document,null,enrollment.release_claim_json);
      storage.db.prepare(`INSERT INTO ${RELEASE_TOMBSTONES} VALUES (?,?,?,?,0)`).run(document.workspaceId,document.objectId,claim.releaseDigest,claim.digest);
      storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge,document.workspaceId);
      return {ok:true,status:"not-held"};
    }
    if (request.action === "status") {
      try {currentScope(storage,scope,enrollment);} catch (error) {
        if (!(error instanceof ReleaseClaimRefusal)) throw error; return {ok:true,status:"unresolved",code:error.code};
      }
      if (claim && claim.releaseDigest === releaseDigest) return {ok:true,status:"held",claim:claimSummary(claim)};
      return {ok:true,status:"not-held",...(claim ? {claim:claimSummary(claim)} : {})};
    }
    if (request.action === "acquire" && claim) {
      if (claim.releaseDigest !== releaseDigest) throw new ReleaseClaimRefusal("release-claimed",claimSummary(claim),String(enrollment.path));
      return {ok:true,status:"held",claim:publicClaim(claim)};
    }
    const {authority,cursor} = currentScope(storage,scope,enrollment);
    if (request.action === "catch-up") {
      if (enrollment.retired !== 1) throw new ReleaseClaimRefusal("live-again");
      const history = historyAt(storage,scope,authority,cursor);
      return {ok:true,history:{...history,checkpoint:{...history.checkpoint,bytes:Buffer.from(history.checkpoint.bytes).toString("base64")},
        events:history.events.map(event => ({metadata:event.metadata,updateBytes:Buffer.from(event.updateBytes).toString("base64")})),
        receipts:receiptsAt(storage,scope,cursor,history.proof.eventCount)}};
    }
    if (request.requireRetired && enrollment.retired !== 1) throw new ReleaseClaimRefusal("live-again");
    const history = historyAt(storage,scope,authority,cursor);
    const identity = {releaseDigest:releaseDigest!,computerName:request.computerName ?? "Computer",anchor:{document,
      relayDatabaseNamespace:scope.relayDatabaseNamespace,replicationEpoch:scope.replicationEpoch,streamIdentity:scope.streamIdentity,
      restoreFenceGeneration:scope.restoreFenceGeneration,cursor,proof:history.proof,receipts:receiptsAt(storage,scope,cursor,history.proof.eventCount)}};
    const acquired: StoredClaim = {...identity,digest:digest(JSON.stringify(identity))};
    setClaim(storage,document,acquired,enrollment.release_claim_json);
    storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop='retire',enabled=0,retired=1 WHERE workspace_id=? AND object_id=?`).run(document.workspaceId,document.objectId);
    return {ok:true,status:"held",claim:publicClaim(acquired)};
  });
}
