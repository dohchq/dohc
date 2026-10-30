import { visibleSharePath } from "@dohc/security-contract/share-selector";
import type {StorageContext} from "./context";
import type {SqliteDb, SyncRelayShareRow} from "./types";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import {validateUserWritePath} from "@dohc/workspace-core";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson} from "../shareFilter";
import {parseWorkspaceId} from "../requestInputs";
import {canonicalLiveSelector, currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";
import {assertWorkspaceQuota} from "./workspaces";
import {forgetServiceHostUploads} from "./serviceHostUploads";
import {listServiceActivationRetirements, OPEN_RETIREMENT, openServiceActivationRetirement, serviceActivationRetirementOpen,
  type RetirableServiceActivation} from "./serviceActivationRetirement";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {badRequest, notFound, relayError} from "../errors";

export const SERVICE_HOST_ENROLLMENTS = "sync_relay_service_host_enrollments";
export const SERVICE_HOST_MAX_DOCUMENTS = 64;
export const SERVICE_HOST_MAX_WORKSPACES = 16;
const MIGRATION = "service-host-enrollments-v2";
const DRAIN_MIGRATION = "service-host-enrollments-v3";
// `owner_stop` is the owner's Pause or Stop. Stop applies at once. Pause cuts
// the service host's reads at once and applies in full once the host no
// longer holds the document; until then the enrollment stays enabled, so the
// document keeps its binding and its writes while unsettled work settles.
const SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  owner_stop TEXT CHECK (owner_stop IN ('pause','retire')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  host_drained_at_ms INTEGER CHECK (host_drained_at_ms IS NULL OR host_drained_at_ms >= 0),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
// The v2 layout before host drain tracking.
const V2_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  owner_stop TEXT CHECK (owner_stop IN ('pause','retire')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
// The layout before `owner_stop`. Its per-enrollment nonce only derived the old credential.
const V1_MIGRATION = "service-host-enrollments-v1";
const V1_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  credential_nonce TEXT NOT NULL CHECK (length(credential_nonce)=64 AND credential_nonce NOT GLOB '*[^0-9a-f]*'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
const ACTIVE_INDEX = "idx_sync_relay_service_host_enrollments_active";
const ACTIVE_INDEX_SQL = `CREATE INDEX ${ACTIVE_INDEX} ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=0`;
const RETIRED_INDEX = "idx_sync_relay_service_host_enrollments_retired";
const RETIRED_INDEX_SQL = `CREATE INDEX ${RETIRED_INDEX} ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=1`;
const CANDIDATE_INDEX = "idx_sync_relay_shares_service_candidates";
const CANDIDATE_INDEX_SQL = `CREATE INDEX ${CANDIDATE_INDEX} ON sync_relay_shares(workspace_id,share_id)`;

export interface ServiceHostEnrollment {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly path: string;
  readonly ownerUserId: string;
  readonly shareId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  /** The owner's Pause or Stop. Null for a document retired because no Edit grant covers it. */
  readonly ownerStop: "pause" | "retire" | null;
  readonly enabled: boolean;
  readonly retired: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly hostDrainedAtMs: number | null;
  readonly acceptedCursor?: number;
}
export interface EnrollServiceHostDocumentInput {
  workspaceId: string; path: string; shareId: string; ownerUserId: string; nowMs: number; guard(): void;
  /** The host's snapshot of a document it holds for an unadmitted live edit. Its Resume retires that activation. */
  held?: ServiceHostHeldActivation;
}
export interface ServiceHostHeldActivation {
  readonly activationId: string; readonly replicationEpoch: string; readonly streamIdentity: string;
  /** Throws unless the host still holds the document for an unadmitted live edit. Runs inside the enrollment transaction. */
  assertHeld(): void;
}
/** The activation whose new local edits the service host's engine blocked for Stop. */
export interface ServiceHostRetirementPreparation extends RetirableServiceActivation {
  /** Throws unless the host connection that prepared it still stands. Runs inside the enrollment transaction. */
  assertCurrent(): void;
}
export interface SetServiceHostEnrollmentEnabledInput {
  workspaceId: string; path: string; objectId?: string; ownerUserId: string; enabled: boolean; retire?: boolean; restoreFenceGeneration?: number;
  /** Stop of a prepared activation retires only the activation the host prepared. */
  prepared?: ServiceHostRetirementPreparation; nowMs: number; guard(): void;
}
export interface ServiceHostCandidateCursor {workspaceId: string; shareId: string}
export interface ServiceHostCandidatePage {shares: readonly SyncRelayShareRow[]; nextCursor: ServiceHostCandidateCursor | null}
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
  const createdAtMs = timestamp(value.created_at_ms), updatedAtMs = timestamp(value.updated_at_ms),
    hostDrainedAtMs = value.host_drained_at_ms === null ? null : timestamp(value.host_drained_at_ms), ownerStop = value.owner_stop;
  if (updatedAtMs < createdAtMs || (value.enabled !== 0 && value.enabled !== 1) || (value.retired !== 0 && value.retired !== 1) ||
    (value.retired === 1 && value.enabled !== 0) ||
    (ownerStop !== null && ownerStop !== "pause" && ownerStop !== "retire")) throw new Error("Service host enrollment is damaged.");
  return Object.freeze({workspaceId: parseWorkspaceId(value.workspace_id), objectId: text("object_id"), path: canonicalPath(String(value.path)),
    ownerUserId: text("owner_user_id"), shareId: text("share_id"), replicationEpoch: text("replication_epoch"),
    streamIdentity: text("stream_identity"), ownerStop, enabled: value.enabled === 1, retired: value.retired === 1, createdAtMs, updatedAtMs, hostDrainedAtMs});
}
export function initializeServiceHostEnrollmentSchema(db: SqliteDb): void {
  const isMarked = (migration: string) => db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration) !== undefined;
  const marked = isMarked(MIGRATION), drainMarked = isMarked(DRAIN_MIGRATION);
  const existing = () => db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_HOST_ENROLLMENTS);
  const exact = (sql: string) => {
    const value = existing();
    return !!value && value.type === "table" && typeof value.sql === "string" &&
      value.sql.replace(/\s+/g, " ").trim() === sql.replace(/\s+/g, " ").trim();
  };
  if (drainMarked) {
    if (!exact(SQL)) throw new Error("Service host enrollment storage is damaged.");
  } else if (marked) {
    if (exact(V2_SQL)) {
      assertServiceHostEnrollmentConstraints(db);
      db.exec(`ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO ${SERVICE_HOST_ENROLLMENTS}_v2;
        ${SQL};
        INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes)
          SELECT workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,CASE WHEN enabled=0 THEN updated_at_ms END,accounted_bytes
          FROM ${SERVICE_HOST_ENROLLMENTS}_v2;
        DROP TABLE ${SERVICE_HOST_ENROLLMENTS}_v2;
        ${ACTIVE_INDEX_SQL};
        ${RETIRED_INDEX_SQL};`);
    } else if (!exact(SQL)) {
      throw new Error("Service host enrollment storage is damaged.");
    }
  } else if (isMarked(V1_MIGRATION)) {
    if (!exact(V1_SQL)) throw new Error("Service host enrollment storage is damaged.");
    assertServiceHostEnrollmentConstraints(db);
    // A v1 retired row could come from Stop or from revocation; both stay retired until Resume, as before.
    db.exec(`ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO ${SERVICE_HOST_ENROLLMENTS}_v1;
      ${SQL};
      INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes)
        SELECT workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,
          CASE WHEN retired=1 THEN 'retire' WHEN enabled=0 THEN 'pause' END,enabled,retired,created_at_ms,updated_at_ms,
          CASE WHEN enabled=0 THEN updated_at_ms END,accounted_bytes
        FROM ${SERVICE_HOST_ENROLLMENTS}_v1;
      DROP TABLE ${SERVICE_HOST_ENROLLMENTS}_v1;
      ${ACTIVE_INDEX_SQL};
      ${RETIRED_INDEX_SQL};`);
  } else {
    if (existing()) throw new Error("Unmarked service host enrollment storage exists.");
    db.exec(SQL);
    db.exec(ACTIVE_INDEX_SQL);
    db.exec(RETIRED_INDEX_SQL);
    db.exec(CANDIDATE_INDEX_SQL);
  }
  assertServiceHostEnrollmentConstraints(db);
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)").run(MIGRATION, Date.now());
  if (!drainMarked) db.prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)").run(DRAIN_MIGRATION, Date.now());
}
/** All enrollment layouts share these indexes, so one check covers them. */
function assertServiceHostEnrollmentConstraints(db: SqliteDb): void {
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_HOST_ENROLLMENTS})`).all();
  const activeIndex = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(ACTIVE_INDEX);
  const retiredIndex = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(RETIRED_INDEX);
  const candidateIndex = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(CANDIDATE_INDEX);
  if (indexes.length !== 4 || indexes.some(index => index.name === ACTIVE_INDEX || index.name === RETIRED_INDEX
    ? index.unique !== 0 || index.partial !== 1 || index.origin !== "c"
    : index.unique !== 1 || index.partial !== 0 || (index.origin !== "pk" && index.origin !== "u")) ||
    typeof activeIndex?.sql !== "string" || activeIndex.sql.replace(/\s+/g, " ").trim() !== ACTIVE_INDEX_SQL.replace(/\s+/g, " ").trim() ||
    typeof retiredIndex?.sql !== "string" || retiredIndex.sql.replace(/\s+/g, " ").trim() !== RETIRED_INDEX_SQL.replace(/\s+/g, " ").trim() ||
    typeof candidateIndex?.sql !== "string" || candidateIndex.sql.replace(/\s+/g, " ").trim() !== CANDIDATE_INDEX_SQL.replace(/\s+/g, " ").trim() ||
    db.prepare(`PRAGMA foreign_key_check(${SERVICE_HOST_ENROLLMENTS})`).all().length ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_HOST_ENROLLMENTS)) throw new Error("Service host enrollment constraints are damaged.");
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
export function readServiceHostEnrollment(storage: StorageContext, workspaceId: string, path: string): ServiceHostEnrollment | null {
  storage.captureStanding();
  return read(storage, parseWorkspaceId(workspaceId), canonicalPath(path));
}
/** A document retired because no Edit grant covered it is hosted again by the next Edit share that covers it. */
const reclaimable = (enrollment: ServiceHostEnrollment) => enrollment.retired && enrollment.ownerStop === null;
/** Whether a new Edit share leaves the path's enrollment as it is: it is active, or its owner paused or stopped it. */
export function hasKeptServiceHostEnrollment(storage: StorageContext, workspaceId: string, path: string): boolean {
  storage.captureStanding();
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND path=? AND (retired=0 OR owner_stop IS NOT NULL)`)
    .get(parseWorkspaceId(workspaceId), canonicalPath(path)) !== undefined;
}
function assertCapacity(storage: StorageContext, workspaceId: string): void {
  const all = storage.db.prepare(`SELECT workspace_id FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS + 1);
  if (all.length >= SERVICE_HOST_MAX_DOCUMENTS || (!all.some(row => row.workspace_id === workspaceId) && new Set(all.map(row => row.workspace_id)).size >= SERVICE_HOST_MAX_WORKSPACES)) {
    throw relayError("quota_exceeded", "Service host enrollment capacity is full.");
  }
}

/** Checks automatic enrollment without changing retained documents or consuming capacity. */
export function checkServiceHostDocuments(storage: StorageContext, input: {workspaceId: string; ownerUserId: string; shareId: string; paths: readonly string[]}): void {
  storage.readTx(() => {
    const identity = ownedIdentity(storage, input.workspaceId, input.ownerUserId);
    let added = 0, bytes = 0;
    const objects = new Set<string>();
    for (const path of input.paths) {
      const current = read(storage, input.workspaceId, path);
      if (current && !reclaimable(current)) continue;
      const objectId = assertOwnedEditableDocument(storage, {...input, path});
      if (current) {
        assertCurrent(storage, current, input.ownerUserId);
        if (current.objectId !== objectId) throw relayError("conflict", "Service host enrollment path belongs to another document.");
        added++; continue;
      }
      if (objects.has(objectId) || storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(input.workspaceId, objectId)) {
        throw relayError("conflict", "Service host enrollment document moved from its retained path.");
      }
      objects.add(objectId); added++;
      bytes += Buffer.byteLength(JSON.stringify([input.workspaceId, objectId, path, input.ownerUserId, input.shareId,
        identity.replicationEpoch, identity.streamIdentity])) + 64;
    }
    if (!added) return;
    const all = storage.db.prepare(`SELECT workspace_id FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS + 1);
    if (all.length + added > SERVICE_HOST_MAX_DOCUMENTS || (!all.some(row => row.workspace_id === input.workspaceId) &&
      new Set(all.map(row => row.workspace_id)).size >= SERVICE_HOST_MAX_WORKSPACES)) {
      throw relayError("quota_exceeded", "The server has no room for more live documents. Stop live editing for unused documents, then try again.");
    }
    assertWorkspaceQuota(storage, input.workspaceId, bytes);
  });
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
      if (current.retired) assertCapacity(storage, workspaceId);
      if (input.held) retireHeldActivation(storage, current, identity, input.held, nowMs);
      storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop=NULL,enabled=1,retired=0,host_drained_at_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
        .run(Math.max(nowMs, current.updatedAtMs), workspaceId, objectId);
      return read(storage, workspaceId, path)!;
    }
    if (input.held) throw relayError("conflict", HELD_CHANGED);
    if (storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId)) throw relayError("conflict", "Service host enrollment document moved from its retained path.");
    assertCapacity(storage, workspaceId);
    const charge = Buffer.byteLength(JSON.stringify([workspaceId, objectId, path, ownerUserId, shareId, identity.replicationEpoch, identity.streamIdentity])) + 64;
    assertWorkspaceQuota(storage, workspaceId, charge);
    storage.db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,created_at_ms,updated_at_ms,accounted_bytes) VALUES (?,?,?,?,?,?,?,1,?,?,?)`)
      .run(workspaceId, objectId, path, ownerUserId, shareId, identity.replicationEpoch, identity.streamIdentity, nowMs, nowMs, charge);
    storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, workspaceId);
    return read(storage, workspaceId, path)!;
}
export const HELD_CHANGED = "This document changed while live editing was resuming. Try again.";
export const restoreInProgress = (storage: StorageContext, workspaceId: string, objectId: string) =>
  storage.db.prepare(`SELECT 1 FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND phase<>'resumed'`)
    .get(workspaceId, objectId) !== undefined;
/**
 * A Resume of a document the host holds for an unadmitted live edit retires
 * the held activation before enabling it, as Stop does: its live session
 * cannot continue, so a successor must replace it.
 */
function retireHeldActivation(storage: StorageContext, enrollment: ServiceHostEnrollment,
  identity: {replicationEpoch: string; streamIdentity: string}, held: ServiceHostHeldActivation, nowMs: number): void {
  held.assertHeld();
  // Any prepared activation: a held successor that never completed still retires.
  const activation = storage.db.prepare(`SELECT a.activation_id,json_extract(a.binding_json,'$.currentPath') AS path
    FROM ${SERVICE_ACTIVATIONS} a JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
    WHERE a.workspace_id=? AND a.main_version_id='main' AND a.object_id=? AND a.retired_at_ms IS NULL AND d.lineage_state='current'`)
    .get(enrollment.workspaceId, enrollment.objectId);
  if (identity.replicationEpoch !== held.replicationEpoch || identity.streamIdentity !== held.streamIdentity ||
    activation?.activation_id !== held.activationId || activation.path !== enrollment.path) {
    throw relayError("conflict", HELD_CHANGED);
  }
  if (restoreInProgress(storage, enrollment.workspaceId, enrollment.objectId)) throw relayError("restore-in-progress", "This document is being restored. Resume live editing once it finishes.");
  openServiceActivationRetirement(storage, enrollment, nowMs);
}
export function listServiceHostEnrollments(storage: StorageContext, workspaceId?: string): readonly ServiceHostEnrollment[] {
  return storage.readLiveAuthority(() => {
    const values = workspaceId === undefined
      ? storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 ORDER BY workspace_id,path LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS + 1)
      : storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND retired=0 ORDER BY path LIMIT ?`).all(parseWorkspaceId(workspaceId), SERVICE_HOST_MAX_DOCUMENTS + 1);
    if (values.length > SERVICE_HOST_MAX_DOCUMENTS || new Set(values.map(value => value.workspace_id)).size > SERVICE_HOST_MAX_WORKSPACES) throw new Error("Service host enrollment capacity is damaged.");
    return values.map(row);
  });
}
export interface ServiceHostEnrollmentCursor {readonly workspaceId: string; readonly path: string}
/**
 * The enrollments the service host has not drained: its documents, and the
 * ones it must still remove from its replicas before their release. Every
 * active row comes first, then a page of the retired rows after `after`,
 * which Stop leaves here.
 */
export function listUndrainedServiceHostEnrollments(storage: StorageContext, after?: ServiceHostEnrollmentCursor): {
  documents: readonly ServiceHostEnrollment[]; nextCursor: ServiceHostEnrollmentCursor | null;
} {
  const workspaceId = after === undefined ? "" : parseWorkspaceId(after.workspaceId), path = after === undefined ? "" : canonicalPath(after.path);
  return storage.readLiveAuthority(() => {
    // Capacity bounds the active rows.
    const active = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE host_drained_at_ms IS NULL AND retired=0
      ORDER BY workspace_id,path LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS).map(row);
    const retired = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE host_drained_at_ms IS NULL AND retired=1
      AND (workspace_id,path)>(?,?) ORDER BY workspace_id,path LIMIT ?`).all(workspaceId, path, SERVICE_HOST_MAX_DOCUMENTS + 1);
    // The host opens an engine handle for each workspace named. The page names
    // no more workspaces than capacity allows active ones, so together they
    // stay within the engine's 64 handles. Rows come by workspace, so the page is a prefix.
    const named = new Set([...new Set(retired.map(value => value.workspace_id))].slice(0, SERVICE_HOST_MAX_WORKSPACES));
    const page = retired.slice(0, SERVICE_HOST_MAX_DOCUMENTS).filter(value => named.has(value.workspace_id)).map(row), last = page.at(-1);
    return {documents: [...active, ...page], nextCursor: retired.length > page.length && last ? {workspaceId: last.workspaceId, path: last.path} : null};
  });
}
export function listRetiredServiceHostEnrollments(storage: StorageContext, workspaceId: string, after?: string): {
  documents: readonly ServiceHostEnrollment[]; nextCursor: string | null;
} {
  const workspace = parseWorkspaceId(workspaceId), cursor = after === undefined ? "" : canonicalPath(after);
  storage.captureStanding();
  const values = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} INDEXED BY ${RETIRED_INDEX}
    WHERE workspace_id=? AND retired=1 AND path>? ORDER BY path LIMIT ?`).all(workspace, cursor, SERVICE_HOST_MAX_DOCUMENTS + 1);
  const documents = values.slice(0, SERVICE_HOST_MAX_DOCUMENTS).map(row);
  return {documents, nextCursor: values.length > SERVICE_HOST_MAX_DOCUMENTS ? documents.at(-1)!.path : null};
}
export interface ServiceHostWorkspace {
  readonly workspaceId: string; readonly ownerUserId: string; readonly replicationEpoch: string; readonly streamIdentity: string;
}
// Enabled enrollments that match the workspace's current owner and identity.
const CURRENT = `FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
  WHERE e.workspace_id=? AND e.enabled=1 AND e.retired=0 AND e.owner_user_id=w.owner_user_id
    AND e.replication_epoch=w.replication_epoch AND e.stream_identity=w.stream_identity`;
// Current enrollments the host has not drained, or whose document's activation is still retiring.
const CURRENT_UNDRAINED = `FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
  WHERE e.workspace_id=? AND (e.host_drained_at_ms IS NULL OR EXISTS(SELECT 1 FROM ${SERVICE_ACTIVATIONS}
      WHERE ${SERVICE_ACTIVATIONS}.workspace_id=e.workspace_id AND ${SERVICE_ACTIVATIONS}.main_version_id='main'
        AND ${SERVICE_ACTIVATIONS}.object_id=e.object_id AND ${OPEN_RETIREMENT}))
    AND e.owner_user_id=w.owner_user_id AND e.replication_epoch=w.replication_epoch AND e.stream_identity=w.stream_identity`;
/**
 * The workspace identity while at least one enrollment is eligible for the
 * requested credential. Ordinary callers require enabled and current rows;
 * hosted callers may include any undrained current row, and a drained one
 * until its document's activation retires. One SQL snapshot is safe both on
 * the request path and inside a write guard.
 */
export function currentServiceHostWorkspace(storage: StorageContext, workspaceId: string, includeUndrained = false): ServiceHostWorkspace | null {
  storage.captureStanding();
  const value = storage.db.prepare(`SELECT e.workspace_id,e.owner_user_id,e.replication_epoch,e.stream_identity ${includeUndrained ? CURRENT_UNDRAINED : CURRENT} LIMIT 1`)
    .get(parseWorkspaceId(workspaceId));
  return value ? hostWorkspace(value) : null;
}
function hostWorkspace(value: Record<string, unknown>): ServiceHostWorkspace {
  return Object.freeze({workspaceId: parseWorkspaceId(value.workspace_id), ownerUserId: parseLiveUpdateIdentifier(value.owner_user_id, "owner_user_id"),
    replicationEpoch: parseLiveUpdateIdentifier(value.replication_epoch, "replication_epoch"),
    streamIdentity: parseLiveUpdateIdentifier(value.stream_identity, "stream_identity")});
}
/** The current identity's enabled enrollments, in one SQL snapshot. */
export function currentServiceHostEnrollments(storage: StorageContext, workspaceId: string): readonly ServiceHostEnrollment[] {
  storage.captureStanding();
  const values = storage.db.prepare(`SELECT e.* ${CURRENT} ORDER BY e.path LIMIT ?`).all(parseWorkspaceId(workspaceId), SERVICE_HOST_MAX_DOCUMENTS + 1);
  if (values.length > SERVICE_HOST_MAX_DOCUMENTS) throw new Error("Service host enrollment capacity is damaged.");
  return values.map(row);
}
export class ServiceHostRetirementConflict extends Error {
  constructor(readonly restoreFenceGeneration: number) {super("The document's restore generation changed.");}
}

export function setServiceHostEnrollmentEnabled(storage: StorageContext, input: SetServiceHostEnrollmentEnabledInput): ServiceHostEnrollment | null {
  const workspaceId = parseWorkspaceId(input.workspaceId), path = canonicalPath(input.path), nowMs = timestamp(input.nowMs);
  if (typeof input.enabled !== "boolean" || (input.retire !== undefined && typeof input.retire !== "boolean") || (input.retire && input.enabled)) {
    throw badRequest("Invalid service host enrollment state.");
  }
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing(); input.guard();
    const value = input.objectId === undefined ? undefined : storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(workspaceId,parseLiveUpdateIdentifier(input.objectId,"object ID"));
    const current = input.objectId === undefined ? read(storage, workspaceId, path) : value ? row(value) : null;
    if (!current || current.ownerUserId !== input.ownerUserId || !storage.workspaceIsOwnedBy(workspaceId, input.ownerUserId)) return null;
    let acceptedCursor: number | undefined;
    if (input.retire) {
      if (restoreInProgress(storage, workspaceId, current.objectId)) throw relayError("restore-in-progress", "Stop live editing is waiting. You can keep editing.");
      if (input.restoreFenceGeneration !== undefined && (!Number.isSafeInteger(input.restoreFenceGeneration) || input.restoreFenceGeneration < 0)) throw badRequest("Invalid restore generation.");
      const document=storage.db.prepare("SELECT restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND object_id=? AND main_version_id='main' AND lineage_state='current'").get(workspaceId,current.objectId);
      const generation=document?.restore_fence_generation ?? 0;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation)) throw new Error("Invalid document restore generation.");
      if (input.restoreFenceGeneration !== undefined && generation !== input.restoreFenceGeneration) throw new ServiceHostRetirementConflict(generation);
      // The prepared activation's obligation keeps the fence of the first Stop.
      // A new one needs the host to have delivered its edits and blocked new ones.
      const retirement = openServiceActivationRetirement(storage, {workspaceId, objectId: current.objectId}, nowMs, activation => {
        const prepared = input.prepared;
        if (!prepared) throw relayError("host-offline");
        if (prepared.activationId !== activation.activationId || prepared.lineageClaimId !== activation.lineageClaimId) throw relayError("conflict");
        if (prepared.restoreFenceGeneration !== activation.restoreFenceGeneration) throw new ServiceHostRetirementConflict(activation.restoreFenceGeneration);
        prepared.assertCurrent();
      });
      const high = retirement ? {cursor: retirement.acceptedThrough} : storage.db.prepare("SELECT MAX(journal_cursor) AS cursor FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=(SELECT lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current')")
        .get(workspaceId,current.objectId,workspaceId,current.objectId);
      acceptedCursor = timestamp(high?.cursor ?? 0);
    }
    if (input.enabled) {
      assertCurrent(storage, current, input.ownerUserId);
      if (assertOwnedEditableDocument(storage, current) !== current.objectId) throw new Error("Service host enrollment path belongs to another document.");
      if (current.retired) assertCapacity(storage, workspaceId);
    }
    const ownerStop = input.enabled ? null : input.retire === true || current.ownerStop === "retire" ? "retire" : "pause";
    // Pause leaves the host's reads now and keeps the binding until host unload. Stop fences new acceptance in this transaction.
    const enabled = input.retire ? false : input.enabled || current.enabled;
    const retired = !enabled && (current.retired || ownerStop === "retire");
    storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop=?,enabled=?,retired=?,host_drained_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
      .run(ownerStop, Number(enabled), Number(retired), input.enabled ? null : current.hostDrainedAtMs, Math.max(nowMs, current.updatedAtMs), workspaceId, current.objectId);
    // Stop retires at once, so the release that clears upload proof never sees this row. The retirement it opened keeps that proof until it completes.
    forgetIdleServiceHostUploads(storage, workspaceId);
    return {...read(storage, workspaceId, current.path)!, ...(acceptedCursor === undefined ? {} : {acceptedCursor})};
  });
}

const EDIT_SHARE_COLUMNS = `s.share_id,s.workspace_id,s.granter_user_id,s.selector_json,s.created_at_ms`;
const ACTIVE_EDIT_GRANT = `EXISTS(SELECT 1 FROM sync_relay_share_grants g WHERE g.share_id=s.share_id AND g.status='active' AND g.access='edit')`;
function coversEnrolledPath(value: Record<string, unknown>, path: string): boolean {
  const share: SyncRelayShareRow = {shareId: String(value.share_id), workspaceId: String(value.workspace_id), granterUserId: String(value.granter_user_id),
    selectorJson: String(value.selector_json), createdAtMs: Number(value.created_at_ms)};
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson), selector = parsed && effectiveShareSelector(parsed, "edit");
  return !!selector && isLiveEditShareSelector(selector) && canonicalLiveSelector(share, selector) && visibleSharePath(selector, path) === path;
}
function coveredByEditGrant(storage: StorageContext, enrollment: Pick<ServiceHostEnrollment, "workspaceId" | "ownerUserId" | "path"> & {shareId?: string}): boolean {
  // Admission runs this on every update. The share that enrolled the document almost always still covers it, so it is
  // checked first by key; the rest are read only when it doesn't, and the scan stops at the first that does.
  if (enrollment.shareId !== undefined) {
    const own = storage.db.prepare(`SELECT ${EDIT_SHARE_COLUMNS} FROM sync_relay_shares s
      WHERE s.share_id=? AND s.workspace_id=? AND s.granter_user_id=? AND ${ACTIVE_EDIT_GRANT}`)
      .get(enrollment.shareId, enrollment.workspaceId, enrollment.ownerUserId);
    if (own && coversEnrolledPath(own, enrollment.path)) return true;
  }
  const shares = storage.db.prepare(`SELECT ${EDIT_SHARE_COLUMNS} FROM sync_relay_shares s INDEXED BY ${CANDIDATE_INDEX}
    WHERE s.workspace_id=? AND s.granter_user_id=? AND ${ACTIVE_EDIT_GRANT}`)
    .iterate(enrollment.workspaceId, enrollment.ownerUserId);
  for (const value of shares) if (value.share_id !== enrollment.shareId && coversEnrolledPath(value, enrollment.path)) return true;
  return false;
}
/** Whether an active Edit grant on any of the owner's shares still covers the enrolled document. */
export function serviceHostEnrollmentHasEditGrant(storage: StorageContext, enrollment: Pick<ServiceHostEnrollment, "workspaceId" | "ownerUserId" | "path">): boolean {
  storage.captureStanding();
  return coveredByEditGrant(storage, enrollment);
}
/**
 * Called once the service host no longer holds the document. Applies the
 * owner's pending Pause, and retires an enrollment no active Edit
 * grant covers. Returns null when neither applies.
 */
export function releaseServiceHostEnrollment(storage: StorageContext, input: {workspaceId: string; objectId: string; nowMs: number}): ServiceHostEnrollment | null {
  const nowMs = timestamp(input.nowMs), standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    const value = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(parseWorkspaceId(input.workspaceId), input.objectId);
    const current = value ? row(value) : null;
    if (!current) return null;
    const uncovered = !coveredByEditGrant(storage, current);
    if (current.retired && current.hostDrainedAtMs !== null) return null;
    if (!current.retired && !uncovered && !(current.enabled && current.ownerStop)) return null;
    storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=?,host_drained_at_ms=COALESCE(host_drained_at_ms,?),updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
      .run(Number(current.retired || uncovered || current.ownerStop === "retire"), nowMs, Math.max(nowMs, current.updatedAtMs), current.workspaceId, current.objectId);
    forgetIdleServiceHostUploads(storage, current.workspaceId);
    return read(storage, current.workspaceId, current.path);
  });
}

/**
 * Ends the host's upload proof once the workspace has no enabled enrollment
 * and no document still settling, whose verified output may name those bytes.
 */
export function forgetIdleServiceHostUploads(storage: StorageContext, workspaceId: string): void {
  if (!currentServiceHostWorkspace(storage, workspaceId) && !listServiceActivationRetirements(storage, workspaceId).length) {
    forgetServiceHostUploads(storage, workspaceId);
  }
}

/**
 * Absence preserves explicitly configured hosts. A retained enrollment fences
 * its document once its owner stops it, its workspace changes, or no Edit
 * grant of its owner covers its enrolled path. An open retirement fences it
 * until its activation retires, whatever its enrollment.
 */
export function serviceHostDocumentEnabled(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  if (serviceActivationRetirementOpen(storage, document)) return false;
  const value = storage.db.prepare(`SELECT e.enabled,e.retired,e.owner_user_id,e.path,e.share_id,e.replication_epoch,e.stream_identity,
    w.owner_user_id AS current_owner,w.replication_epoch AS current_epoch,w.stream_identity AS current_stream
    FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
    WHERE e.workspace_id=? AND e.object_id=?`).get(document.workspaceId, document.objectId);
  return !value || (value.enabled === 1 && value.retired === 0 && value.owner_user_id === value.current_owner &&
    value.replication_epoch === value.current_epoch && value.stream_identity === value.current_stream &&
    coveredByEditGrant(storage, {workspaceId: document.workspaceId, ownerUserId: String(value.owner_user_id), path: String(value.path), shareId: String(value.share_id)}));
}

export function scanServiceHostCandidateShares(storage: StorageContext, after?: ServiceHostCandidateCursor, onlyWorkspaceId?: string): ServiceHostCandidatePage {
  const workspaceId = after === undefined ? "" : parseWorkspaceId(after.workspaceId), shareId = after === undefined ? "" : parseLiveUpdateIdentifier(after.shareId, "share ID");
  const workspace = onlyWorkspaceId === undefined ? undefined : parseWorkspaceId(onlyWorkspaceId);
  return storage.readTx(() => {
    const values = storage.db.prepare(`SELECT s.* FROM sync_relay_shares s INDEXED BY ${CANDIDATE_INDEX} JOIN sync_relay_workspaces w USING(workspace_id)
      WHERE ${workspace === undefined ? "(s.workspace_id,s.share_id)>(?,?)" : "s.workspace_id=? AND s.share_id>?"} AND s.granter_user_id=w.owner_user_id AND w.replication_epoch IS NOT NULL AND w.stream_identity IS NOT NULL
        AND EXISTS(SELECT 1 FROM sync_relay_share_grants g WHERE g.share_id=s.share_id AND g.status='active' AND g.access='edit')
      ORDER BY s.workspace_id,s.share_id LIMIT ?`).all(workspace ?? workspaceId, shareId, SERVICE_HOST_MAX_DOCUMENTS + 1);
    const page = values.slice(0, SERVICE_HOST_MAX_DOCUMENTS), last = page.at(-1);
    const shares = page.flatMap(value => {
      const share: SyncRelayShareRow = {shareId: String(value.share_id), workspaceId: String(value.workspace_id), granterUserId: String(value.granter_user_id),
        selectorJson: String(value.selector_json), createdAtMs: Number(value.created_at_ms)};
      const parsed = parseStoredAnyShareSelectorJson(share.selectorJson), selector = parsed && effectiveShareSelector(parsed, "edit");
      return selector && isLiveEditShareSelector(selector) && canonicalLiveSelector(share, selector) ? [share] : [];
    });
    return {shares, nextCursor: values.length > SERVICE_HOST_MAX_DOCUMENTS && last ? {workspaceId: String(last.workspace_id), shareId: String(last.share_id)} : null};
  });
}
