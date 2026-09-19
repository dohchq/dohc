import {randomBytes} from "node:crypto";
import type {StorageContext} from "./context";
import type {SqliteDb, SyncRelayShareRow} from "./types";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import {validateUserWritePath} from "@dohc/workspace-core";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, visibleSharePath} from "../shareFilter";
import {parseWorkspaceId} from "../requestInputs";
import {canonicalLiveSelector, currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {assertWorkspaceQuota} from "./workspaces";
import {badRequest, notFound, relayError} from "../errors";

export const SERVICE_HOST_ENROLLMENTS = "sync_relay_service_host_enrollments";
export const SERVICE_HOST_MAX_DOCUMENTS = 64;
export const SERVICE_HOST_MAX_WORKSPACES = 16;
const MIGRATION = "service-host-enrollments-v1";
const SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  credential_nonce TEXT NOT NULL CHECK (length(credential_nonce)=64 AND credential_nonce NOT GLOB '*[^0-9a-f]*'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;

export interface ServiceHostEnrollment {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly path: string;
  readonly ownerUserId: string;
  readonly shareId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  readonly credentialNonce: string;
  readonly enabled: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface EnrollServiceHostDocumentInput {
  workspaceId: string; path: string; shareId: string; ownerUserId: string; nowMs: number; guard(): void;
}
export interface SetServiceHostEnrollmentEnabledInput {
  workspaceId: string; path: string; ownerUserId: string; enabled: boolean; nowMs: number; guard(): void;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid service host enrollment timestamp.");
  return value;
}
function canonicalPath(value: string): string {
  const checked = validateUserWritePath(value);
  if (!checked.ok || checked.normalized !== value || liveDocumentKindForPath(value) !== "richdoc") throw badRequest("Service host enrollment requires a rich document path.");
  return value;
}
function row(value: Record<string, unknown>): ServiceHostEnrollment {
  const text = (key: string) => parseLiveUpdateIdentifier(value[key], key);
  const createdAtMs = timestamp(value.created_at_ms), updatedAtMs = timestamp(value.updated_at_ms);
  if (updatedAtMs < createdAtMs || (value.enabled !== 0 && value.enabled !== 1) ||
    typeof value.credential_nonce !== "string" || !/^[0-9a-f]{64}$/.test(value.credential_nonce)) throw new Error("Service host enrollment is damaged.");
  return Object.freeze({workspaceId: parseWorkspaceId(value.workspace_id), objectId: text("object_id"), path: canonicalPath(String(value.path)),
    ownerUserId: text("owner_user_id"), shareId: text("share_id"), replicationEpoch: text("replication_epoch"),
    streamIdentity: text("stream_identity"), credentialNonce: value.credential_nonce, enabled: value.enabled === 1, createdAtMs, updatedAtMs});
}
export function initializeServiceHostEnrollmentSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(MIGRATION);
  const existing = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_HOST_ENROLLMENTS);
  if (!marked) {
    if (existing) throw new Error("Unmarked service host enrollment storage exists.");
    db.exec(SQL);
  } else if (!existing || existing.type !== "table" || typeof existing.sql !== "string" ||
    existing.sql.replace(/\s+/g, " ").trim() !== SQL.replace(/\s+/g, " ").trim()) throw new Error("Service host enrollment storage is damaged.");
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_HOST_ENROLLMENTS})`).all();
  if (indexes.length !== 2 || indexes.some(index => index.unique !== 1 || index.partial !== 0 || (index.origin !== "pk" && index.origin !== "u")) ||
    db.prepare(`PRAGMA foreign_key_check(${SERVICE_HOST_ENROLLMENTS})`).all().length ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_HOST_ENROLLMENTS)) throw new Error("Service host enrollment constraints are damaged.");
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)").run(MIGRATION, Date.now());
}
function ownedIdentity(storage: StorageContext, workspaceId: string, ownerUserId: string) {
  if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
  const identity = storage.getWorkspaceIdentity(workspaceId);
  if (!identity) throw relayError("conflict", "Sync this workspace before enabling live editing.");
  return identity;
}
function assertCurrent(storage: StorageContext, enrollment: ServiceHostEnrollment, ownerUserId: string) {
  const identity = ownedIdentity(storage, enrollment.workspaceId, ownerUserId);
  if (enrollment.ownerUserId !== ownerUserId || enrollment.replicationEpoch !== identity.replicationEpoch || enrollment.streamIdentity !== identity.streamIdentity) {
    throw relayError("conflict", "Service host enrollment belongs to an obsolete workspace identity.");
  }
}
function assertOwnedEditableDocument(storage: StorageContext, input: {workspaceId: string; path: string; shareId: string; ownerUserId: string}): string {
  const share = storage.getShare(input.shareId);
  if (!share || share.workspaceId !== input.workspaceId || share.granterUserId !== input.ownerUserId) throw notFound();
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
  const effective = parsed && effectiveShareSelector(parsed, "edit");
  if (!effective || !isLiveEditShareSelector(effective) || !canonicalLiveSelector(share, effective) || visibleSharePath(effective, input.path) !== input.path) {
    throw badRequest("Service host enrollment requires an owner edit share covering this path.");
  }
  const objectId = storage.objectIdAtPathInVersion({workspaceId: input.workspaceId, versionId: "main", path: input.path});
  if (!objectId || !currentLiveDocumentMoment(storage, {workspaceId: input.workspaceId, mainVersionId: "main", objectId, lineageClaimId: "0".repeat(64)}, input.path)) {
    throw relayError("conflict", "Service host enrollment requires a current main document.");
  }
  return objectId;
}
function read(storage: StorageContext, workspaceId: string, path: string) {
  const value = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND path=?`).get(workspaceId, path);
  return value ? row(value) : null;
}
export function enrollServiceHostDocument(storage: StorageContext, input: EnrollServiceHostDocumentInput): ServiceHostEnrollment {
  return enrollServiceHostDocuments(storage, [input])[0]!;
}
/** A folder selection either enrolls completely or leaves all prior rows unchanged. */
export function enrollServiceHostDocuments(storage: StorageContext, inputs: readonly EnrollServiceHostDocumentInput[]): readonly ServiceHostEnrollment[] {
  if (inputs.length > SERVICE_HOST_MAX_DOCUMENTS) throw badRequest("This server supports up to 64 live documents.");
  const standing = storage.captureStanding();
  return storage.tx(() => {standing(); return inputs.map(input => enrollInsideTransaction(storage, input));});
}
function enrollInsideTransaction(storage: StorageContext, input: EnrollServiceHostDocumentInput): ServiceHostEnrollment {
  const workspaceId = parseWorkspaceId(input.workspaceId), path = canonicalPath(input.path), shareId = parseLiveUpdateIdentifier(input.shareId, "share ID"),
    ownerUserId = parseLiveUpdateIdentifier(input.ownerUserId, "owner ID"), nowMs = timestamp(input.nowMs);
    input.guard();
    const identity = ownedIdentity(storage, workspaceId, ownerUserId);
    const objectId = assertOwnedEditableDocument(storage, {workspaceId, path, shareId, ownerUserId});
    const current = read(storage, workspaceId, path);
    if (current) {
      assertCurrent(storage, current, ownerUserId);
      if (current.objectId !== objectId) throw relayError("conflict", "Service host enrollment path belongs to another document.");
      storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=1,updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
        .run(Math.max(nowMs, current.updatedAtMs), workspaceId, objectId);
      return read(storage, workspaceId, path)!;
    }
    if (storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId)) throw relayError("conflict", "Service host enrollment document moved from its retained path.");
    const all = storage.db.prepare(`SELECT workspace_id FROM ${SERVICE_HOST_ENROLLMENTS} LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS + 1);
    if (all.length >= SERVICE_HOST_MAX_DOCUMENTS || (!all.some(row => row.workspace_id === workspaceId) && new Set(all.map(row => row.workspace_id)).size >= SERVICE_HOST_MAX_WORKSPACES)) throw relayError("quota_exceeded", "Service host enrollment capacity is full.");
    const credentialNonce = randomBytes(32).toString("hex");
    const charge = Buffer.byteLength(JSON.stringify([workspaceId, objectId, path, ownerUserId, shareId, identity.replicationEpoch, identity.streamIdentity, credentialNonce])) + 64;
    assertWorkspaceQuota(storage, workspaceId, charge);
    storage.db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,credential_nonce,enabled,created_at_ms,updated_at_ms,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`)
      .run(workspaceId, objectId, path, ownerUserId, shareId, identity.replicationEpoch, identity.streamIdentity, credentialNonce, nowMs, nowMs, charge);
    storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, workspaceId);
    return read(storage, workspaceId, path)!;
}
export function listServiceHostEnrollments(storage: StorageContext, workspaceId?: string): readonly ServiceHostEnrollment[] {
  return storage.readLiveAuthority(() => {
    const values = workspaceId === undefined
      ? storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY workspace_id,path LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS + 1)
      : storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? ORDER BY path LIMIT ?`).all(parseWorkspaceId(workspaceId), SERVICE_HOST_MAX_DOCUMENTS + 1);
    if (values.length > SERVICE_HOST_MAX_DOCUMENTS || new Set(values.map(value => value.workspace_id)).size > SERVICE_HOST_MAX_WORKSPACES) throw new Error("Service host enrollment capacity is damaged.");
    return values.map(row);
  });
}
/** One SQL snapshot; safe both on the request path and inside a write guard. */
export function listCurrentServiceHostEnrollments(storage: StorageContext, workspaceId: string): readonly ServiceHostEnrollment[] {
  storage.captureStanding();
  const values = storage.db.prepare(`SELECT e.* FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
    WHERE e.workspace_id=? AND e.enabled=1 AND e.owner_user_id=w.owner_user_id
      AND e.replication_epoch=w.replication_epoch AND e.stream_identity=w.stream_identity
    ORDER BY e.path LIMIT ?`).all(parseWorkspaceId(workspaceId), SERVICE_HOST_MAX_DOCUMENTS + 1);
  if (values.length > SERVICE_HOST_MAX_DOCUMENTS) throw new Error("Service host enrollment capacity is damaged.");
  return values.map(row);
}
export function setServiceHostEnrollmentEnabled(storage: StorageContext, input: SetServiceHostEnrollmentEnabledInput): ServiceHostEnrollment | null {
  const workspaceId = parseWorkspaceId(input.workspaceId), path = canonicalPath(input.path), nowMs = timestamp(input.nowMs);
  if (typeof input.enabled !== "boolean") throw new Error("Invalid service host enrollment state.");
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing(); input.guard();
    const current = read(storage, workspaceId, path);
    if (!current || current.ownerUserId !== input.ownerUserId || !storage.workspaceIsOwnedBy(workspaceId, input.ownerUserId)) return null;
    if (input.enabled) {
      assertCurrent(storage, current, input.ownerUserId);
      if (assertOwnedEditableDocument(storage, current) !== current.objectId) throw new Error("Service host enrollment path belongs to another document.");
    }
    storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=?,updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
      .run(Number(input.enabled), Math.max(nowMs, current.updatedAtMs), workspaceId, current.objectId);
    return read(storage, workspaceId, path);
  });
}

/** Absence preserves explicitly configured hosts; a retained enrollment always fences its document. */
export function serviceHostDocumentEnabled(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  const value = storage.db.prepare(`SELECT e.enabled,e.owner_user_id,e.replication_epoch,e.stream_identity,
    w.owner_user_id AS current_owner,w.replication_epoch AS current_epoch,w.stream_identity AS current_stream
    FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
    WHERE e.workspace_id=? AND e.object_id=?`).get(document.workspaceId, document.objectId);
  return !value || (value.enabled === 1 && value.owner_user_id === value.current_owner &&
    value.replication_epoch === value.current_epoch && value.stream_identity === value.current_stream);
}

export function listServiceHostCandidateShares(storage: StorageContext, limit = SERVICE_HOST_MAX_DOCUMENTS): readonly SyncRelayShareRow[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SERVICE_HOST_MAX_DOCUMENTS) throw new Error("Invalid service host discovery limit.");
  return storage.readTx(() => {
    const values = storage.db.prepare(`SELECT s.* FROM sync_relay_shares s JOIN sync_relay_workspaces w USING(workspace_id)
      WHERE s.granter_user_id=w.owner_user_id AND w.replication_epoch IS NOT NULL AND w.stream_identity IS NOT NULL
        AND EXISTS(SELECT 1 FROM sync_relay_share_grants g WHERE g.share_id=s.share_id AND g.status='active' AND g.access='edit')
      ORDER BY s.workspace_id,s.share_id LIMIT ?`).all(limit + 1);
    if (values.length > limit) throw new Error("Service host share discovery capacity is full.");
    return values.flatMap(value => {
      const share: SyncRelayShareRow = {shareId: String(value.share_id), workspaceId: String(value.workspace_id), granterUserId: String(value.granter_user_id),
        selectorJson: String(value.selector_json), createdAtMs: Number(value.created_at_ms)};
      const parsed = parseStoredAnyShareSelectorJson(share.selectorJson), selector = parsed && effectiveShareSelector(parsed, "edit");
      return selector && isLiveEditShareSelector(selector) && canonicalLiveSelector(share, selector) ? [share] : [];
    });
  });
}
