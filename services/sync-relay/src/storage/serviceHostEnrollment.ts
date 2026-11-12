import { visibleSharePath } from "@dohc/security-contract/share-selector";
import type {StorageContext} from "./context";
import type {SqliteDb, SyncRelayShareRow} from "./types";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import {validateUserWritePath} from "@dohc/workspace-core";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson} from "../shareFilter";
import {parseWorkspaceId} from "../requestInputs";
import {canonicalLiveSelector, currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {LIVE_RESTORE_OPERATIONS, UNFINISHED_RESTORE} from "./liveRestoreOperationSchema";
import {attachedLiveJournalHistoryNamespace} from "./liveJournalHistory";
import {assertWorkspaceQuota} from "./workspaces";
import {forgetServiceHostUploads} from "./serviceHostUploads";
import {listServiceActivationRetirements, OPEN_RETIREMENT, openServiceActivationRetirement, retirableServiceActivation, serviceActivationRetirementOpen,
  type RetirableServiceActivation} from "./serviceActivationRetirement";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {badRequest, notFound, relayError} from "../errors";
import {AGENT_ONLY_MAX_DOCUMENTS, AGENT_ONLY_MAX_WORKSPACES, SERVICE_HOST_MAX_DOCUMENTS, SERVICE_HOST_MAX_WORKSPACES} from "../liveHostingLimits";
import type {PersonalCredential} from "./personalAgentChat";
import {personalReachIn, readPersonalAuthority} from "./personalAgents";

export {SERVICE_HOST_MAX_DOCUMENTS, SERVICE_HOST_MAX_WORKSPACES};
export const SERVICE_HOST_ENROLLMENTS = "sync_relay_service_host_enrollments";
const MIGRATION = "service-host-enrollments-v2";
const DRAIN_MIGRATION = "service-host-enrollments-v3";
const DEMAND_MIGRATION = "service-host-enrollments-v4";
// `owner_stop` is the owner's Pause or Stop. Stop applies at once. Pause cuts
// the service host's reads and live admission at once and applies in full once
// the host no longer holds the document; until then the enrollment stays
// enabled, so the host keeps its credential while applied work settles.
// `created_at_ms` holds the enrollment's run token (`runToken`).
// `share_id` names a share whose Edit grant covered the document, a hint for
// the coverage check. `demand_at_ms` records hosting demand that no share
// creates: the last personal open, owner open or Resume. `owner_demand` is 1
// once the owner opened or resumed the document, which takes it out of the
// agent-only caps.
const SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  owner_stop TEXT CHECK (owner_stop IN ('pause','retire')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  host_drained_at_ms INTEGER CHECK (host_drained_at_ms IS NULL OR host_drained_at_ms >= 0),
  owner_demand INTEGER NOT NULL DEFAULT 0 CHECK (owner_demand IN (0,1)),
  demand_at_ms INTEGER CHECK (demand_at_ms IS NULL OR demand_at_ms >= 0),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
// The v3 layout, which required the share whose Edit grant enrolled the document.
const V3_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
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
  /** A share whose Edit grant covered the document, or null. Coverage reads it only as a hint. */
  readonly shareId: string | null;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  /** The owner's Pause or Stop. Null for a document retired because no Edit grant covers it. */
  readonly ownerStop: "pause" | "retire" | null;
  readonly enabled: boolean;
  readonly retired: boolean;
  /** Names the enrollment's current run. Each end of the run moves it past every earlier value, so compare it only for equality. */
  readonly runToken: number;
  readonly updatedAtMs: number;
  readonly hostDrainedAtMs: number | null;
  /** Whether the owner opened or resumed the document. */
  readonly ownerDemand: boolean;
  /** The last open or Resume that asked for hosting, or null when only a share keeps the document. */
  readonly demandAtMs: number | null;
  readonly acceptedCursor?: number;
  /** On the row a Stop returns: whether this Stop retired it, as its transaction found the row. A retired row stays unchanged. */
  readonly changed?: boolean;
}
/**
 * Why hosting is asked for. `personal-open` is an agent's open of a document,
 * `owner-open` the owner's desktop asking for a document it holds owner edits
 * for, `owner-resume` the owner's Resume, and `share` an owner Edit share that
 * covers the path. Only Resume clears the owner's Pause or Stop.
 */
export type LiveHostingIntent = "personal-open" | "owner-open" | "owner-resume" | "share";
interface EnsureOwnedLiveDocumentCommon {
  workspaceId: string; path: string; nowMs: number; guard(): void;
  /** Hears, inside the transaction, whether this call enabled the document. One already hosted is unchanged. */
  changed?(changed: boolean): void;
}
export type EnsureOwnedLiveDocumentInput = EnsureOwnedLiveDocumentCommon & (
  | {intent: "share"; ownerUserId: string; shareId: string}
  | {intent: "owner-open"; ownerUserId: string}
  /** `held` is the host's snapshot of a document it holds for an unadmitted live edit. Its Resume retires that activation. */
  | {intent: "owner-resume"; ownerUserId: string; held?: ServiceHostHeldActivation}
  /** The agent's credential at the fence its request read. The transaction reads its authority and reach again. */
  | {intent: "personal-open"; personal: PersonalCredential});
/** A hosting answer that is the caller's to act on, not an error in the request. */
export type LiveHostingRefusalReason = "paused" | "live_paused_by_owner" | "live_host_full" | "document-unavailable";
export class LiveHostingRefusal extends Error {
  constructor(readonly reason: LiveHostingRefusalReason) {
    super(reason === "live_host_full" ? "The server has no room for more live documents."
      : reason === "paused" ? "Live editing is stopped for this document. Resume it to continue."
      : reason === "document-unavailable" ? "The document is no longer at this path." : "The owner stopped live editing for this document.");
  }
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
/** The owner's Pause, or with `retire` their Stop. Only `ensureOwnedLiveDocument` enables a document. */
export interface SetServiceHostEnrollmentEnabledInput {
  workspaceId: string; path: string; objectId?: string; ownerUserId: string; enabled: false; retire?: boolean; restoreFenceGeneration?: number;
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
  const runToken = timestamp(value.created_at_ms), updatedAtMs = timestamp(value.updated_at_ms),
    hostDrainedAtMs = value.host_drained_at_ms === null ? null : timestamp(value.host_drained_at_ms), ownerStop = value.owner_stop,
    demandAtMs = value.demand_at_ms === null ? null : timestamp(value.demand_at_ms);
  if (updatedAtMs < runToken || (value.enabled !== 0 && value.enabled !== 1) || (value.retired !== 0 && value.retired !== 1) ||
    (value.retired === 1 && value.enabled !== 0) || (value.owner_demand !== 0 && value.owner_demand !== 1) ||
    (ownerStop !== null && ownerStop !== "pause" && ownerStop !== "retire")) throw new Error("Service host enrollment is damaged.");
  return Object.freeze({workspaceId: parseWorkspaceId(value.workspace_id), objectId: text("object_id"), path: canonicalPath(String(value.path)),
    ownerUserId: text("owner_user_id"), shareId: value.share_id === null ? null : text("share_id"), replicationEpoch: text("replication_epoch"),
    streamIdentity: text("stream_identity"), ownerStop, enabled: value.enabled === 1, retired: value.retired === 1, runToken, updatedAtMs, hostDrainedAtMs,
    ownerDemand: value.owner_demand === 1, demandAtMs});
}
export function initializeServiceHostEnrollmentSchema(db: SqliteDb): void {
  const isMarked = (migration: string) => db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration) !== undefined;
  const marked = isMarked(MIGRATION), drainMarked = isMarked(DRAIN_MIGRATION), demandMarked = isMarked(DEMAND_MIGRATION);
  const existing = () => db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_HOST_ENROLLMENTS);
  const exact = (sql: string) => {
    const value = existing();
    return !!value && value.type === "table" && typeof value.sql === "string" &&
      value.sql.replace(/\s+/g, " ").trim() === sql.replace(/\s+/g, " ").trim();
  };
  if (demandMarked) {
    if (!exact(SQL)) throw new Error("Service host enrollment storage is damaged.");
  } else if (marked && !drainMarked && exact(V2_SQL)) {
    assertServiceHostEnrollmentConstraints(db);
    db.exec(`ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO ${SERVICE_HOST_ENROLLMENTS}_v2;
      ${SQL};
      INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes)
        SELECT workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,CASE WHEN enabled=0 THEN updated_at_ms END,accounted_bytes
        FROM ${SERVICE_HOST_ENROLLMENTS}_v2;
      DROP TABLE ${SERVICE_HOST_ENROLLMENTS}_v2;
      ${ACTIVE_INDEX_SQL};
      ${RETIRED_INDEX_SQL};`);
  } else if (marked || drainMarked) {
    // A v2 store can already hold the v3 layout.
    if (!exact(V3_SQL)) throw new Error("Service host enrollment storage is damaged.");
    assertServiceHostEnrollmentConstraints(db);
    // No table references enrollments, so the table moves alone.
    db.exec(`ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO ${SERVICE_HOST_ENROLLMENTS}_v3;
      ${SQL};
      INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes)
        SELECT workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes
        FROM ${SERVICE_HOST_ENROLLMENTS}_v3;
      DROP TABLE ${SERVICE_HOST_ENROLLMENTS}_v3;
      ${ACTIVE_INDEX_SQL};
      ${RETIRED_INDEX_SQL};`);
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
  if (!exact(SQL)) throw new Error("Service host enrollment storage is damaged.");
  assertServiceHostEnrollmentConstraints(db);
  for (const [migration, done] of [[MIGRATION, marked], [DRAIN_MIGRATION, drainMarked], [DEMAND_MIGRATION, demandMarked]] as const) {
    if (!done) db.prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)").run(migration, Date.now());
  }
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
/** A share intent needs the owner's share to cover the path and hold an active Edit grant. */
function assertShareCovers(storage: StorageContext, input: {workspaceId: string; path: string; shareId: string; ownerUserId: string}): void {
  const share = storage.getShare(input.shareId);
  if (!share || share.workspaceId !== input.workspaceId || share.granterUserId !== input.ownerUserId) throw notFound();
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
  const effective = parsed && effectiveShareSelector(parsed, "edit");
  const granted = storage.db.prepare(`SELECT 1 FROM sync_relay_shares s WHERE s.share_id=? AND ${ACTIVE_EDIT_GRANT}`).get(input.shareId) !== undefined;
  if (!granted || !effective || !isLiveEditShareSelector(effective) || !canonicalLiveSelector(share, effective) || visibleSharePath(effective, input.path) !== input.path) {
    throw badRequest("Service host enrollment requires an owner edit share covering this path.");
  }
}
/** The current rich document at the path on main. An agent's open hears its absence as an answer. */
function currentMainDocument(storage: StorageContext, input: {workspaceId: string; path: string}, answered = false): string {
  const objectId = storage.objectIdAtPathInVersion({workspaceId: input.workspaceId, versionId: "main", path: input.path});
  if (!objectId || !currentLiveDocumentMoment(storage, {workspaceId: input.workspaceId, mainVersionId: "main", objectId, lineageClaimId: "0".repeat(64)}, input.path)) {
    throw answered ? new LiveHostingRefusal("document-unavailable") : relayError("conflict", "Service host enrollment requires a current main document.");
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
/** Includes drained and retired enrollments, whose stores can still hold edits. */
export function readServiceHostEnrollmentByObjectId(storage: StorageContext, workspaceId: string, objectId: string): ServiceHostEnrollment | null {
  storage.captureStanding();
  const value = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
    .get(parseWorkspaceId(workspaceId), parseLiveUpdateIdentifier(objectId, "object ID"));
  return value ? row(value) : null;
}
/** A document retired because no Edit grant covered it is hosted again by the next Edit share that covers it. */
const reclaimable = (enrollment: ServiceHostEnrollment) => enrollment.retired && enrollment.ownerStop === null;
/** Whether a new Edit share leaves the path's enrollment as it is: it is active, or its owner paused or stopped it. */
export function hasKeptServiceHostEnrollment(storage: StorageContext, workspaceId: string, path: string): boolean {
  storage.captureStanding();
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND path=? AND (retired=0 OR owner_stop IS NOT NULL)`)
    .get(parseWorkspaceId(workspaceId), canonicalPath(path)) !== undefined;
}
const CAPACITY_FULL = "Service host enrollment capacity is full.";
const MOVED = "Service host enrollment document moved from its retained path.";
/** Whether a share covers the enrollment or its owner asked for it. Neither counts against the agent-only caps. */
function agentOnly(storage: StorageContext, enrollment: Pick<ServiceHostEnrollment, "workspaceId" | "ownerUserId" | "path" | "shareId" | "ownerDemand">): boolean {
  return !enrollment.ownerDemand && !coveredByEditGrant(storage, enrollment);
}
/**
 * Room for one more unretired enrollment in the workspace. Every intent fits
 * within the host's 64 documents in 16 workspaces. A document that would be
 * agent-only, as a personal open leaves one, must also fit within the
 * agent-only caps. `full` is the intent's answer when it doesn't.
 */
function assertCapacity(storage: StorageContext, workspaceId: string, full: () => Error, enrolling?: Parameters<typeof agentOnly>[1]): void {
  const all = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 LIMIT ?`).all(SERVICE_HOST_MAX_DOCUMENTS + 1);
  if (all.length >= SERVICE_HOST_MAX_DOCUMENTS || (!all.some(row => row.workspace_id === workspaceId) && new Set(all.map(row => row.workspace_id)).size >= SERVICE_HOST_MAX_WORKSPACES)) {
    throw full();
  }
  if (!enrolling || !agentOnly(storage, enrolling)) return;
  const rows = all.map(row), byWorkspace = new Map<string, boolean>();
  let documents = 0;
  for (const enrollment of rows) {
    const only = agentOnly(storage, enrollment);
    if (only) documents++;
    byWorkspace.set(enrollment.workspaceId, (byWorkspace.get(enrollment.workspaceId) ?? true) && only);
  }
  const workspaces = [...byWorkspace.values()].filter(Boolean).length;
  // A workspace with other kinds of rows stays mixed; an empty one becomes agent-only.
  if (documents >= AGENT_ONLY_MAX_DOCUMENTS || (!byWorkspace.has(workspaceId) && workspaces >= AGENT_ONLY_MAX_WORKSPACES)) throw full();
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
      assertShareCovers(storage, {...input, path});
      const objectId = currentMainDocument(storage, {workspaceId: input.workspaceId, path});
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
/** The only way into hosting. See `ensureOwnedLiveDocuments`. */
export function ensureOwnedLiveDocument(storage: StorageContext, input: EnsureOwnedLiveDocumentInput): ServiceHostEnrollment {
  return ensureOwnedLiveDocuments(storage, [input])[0]!;
}
/**
 * Asks for hosting of each document, in one transaction: a folder selection
 * either enrolls completely or leaves every prior row unchanged. Each input
 * resolves its document, authorizes its intent, acts on its row as the
 * intent's column of the row-state table says, records demand, then applies
 * capacity and quota on insert and re-enroll.
 */
export function ensureOwnedLiveDocuments(storage: StorageContext, inputs: readonly EnsureOwnedLiveDocumentInput[]): readonly ServiceHostEnrollment[] {
  if (inputs.length > SERVICE_HOST_MAX_DOCUMENTS) throw badRequest("This server supports up to 64 live documents.");
  const standing = storage.captureStanding();
  return storage.tx(() => {standing(); return inputs.map(input => ensureInsideTransaction(storage, input));});
}
/** The owner the intent acts for, once its caller may ask for hosting in the workspace. */
function authorizeIntent(storage: StorageContext, input: EnsureOwnedLiveDocumentInput, workspaceId: string, nowMs: number): string {
  if (input.intent !== "personal-open") return parseLiveUpdateIdentifier(input.ownerUserId, "owner ID");
  // The agent's token, connection, epoch and fence as this transaction finds them, then its reach at Edit.
  const connection = readPersonalAuthority(storage, input.personal.check, input.personal.fenceEpoch, nowMs);
  if (!connection || connection.connectionId !== input.personal.connectionId) throw notFound();
  const reach = personalReachIn(storage, connection, workspaceId);
  if (!reach) throw relayError("personal_agent_out_of_reach");
  if (reach.level !== "edit") throw relayError("personal_agent_edit_needed");
  return connection.ownerUserId;
}
function ensureInsideTransaction(storage: StorageContext, input: EnsureOwnedLiveDocumentInput): ServiceHostEnrollment {
  const workspaceId = parseWorkspaceId(input.workspaceId), path = canonicalPath(input.path), nowMs = timestamp(input.nowMs);
  input.guard();
  // Resolve and authorize: the caller's owner owns the workspace at its current identity, and the path holds a current rich document.
  const ownerUserId = authorizeIntent(storage, input, workspaceId, nowMs);
  const identity = ownedIdentity(storage, workspaceId, ownerUserId);
  const shareId = input.intent === "share" ? parseLiveUpdateIdentifier(input.shareId, "share ID") : null;
  if (input.intent === "share") assertShareCovers(storage, {workspaceId, path, shareId: shareId!, ownerUserId});
  const owner = input.intent === "owner-open" || input.intent === "owner-resume";
  const full = () => input.intent === "personal-open" || input.intent === "owner-open" ? new LiveHostingRefusal("live_host_full") : relayError("quota_exceeded", CAPACITY_FULL);
  const held = input.intent === "owner-resume" ? input.held : undefined;
  const current = read(storage, workspaceId, path);
  const moved = (objectId: string | undefined) => objectId !== undefined &&
    storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId) !== undefined;
  // Owner intents act only on a document hosted before, whose owner binding the desktop holds.
  if (!current && owner) {
    if (moved(storage.objectIdAtPathInVersion({workspaceId, versionId: "main", path}))) throw relayError("conflict", MOVED);
    throw notFound();
  }
  const objectId = currentMainDocument(storage, {workspaceId, path}, input.intent === "personal-open");
  if (current) {
    assertCurrent(storage, current, ownerUserId);
    if (current.objectId !== objectId) throw relayError("conflict", "Service host enrollment path belongs to another document.");
    // Only Resume clears the owner's Pause or Stop. A share leaves it, and an open hears it.
    if (current.ownerStop !== null && input.intent !== "owner-resume") {
      if (input.intent === "share") {input.changed?.(false); return current;}
      throw new LiveHostingRefusal(input.intent === "owner-open" ? "paused" : "live_paused_by_owner");
    }
    const enabling = current.retired || !current.enabled || current.ownerStop !== null;
    if (current.retired) assertCapacity(storage, workspaceId, full, input.intent === "personal-open" ? current : undefined);
    if (held) retireHeldActivation(storage, current, identity, held, nowMs);
    if (enabling) {
      storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop=NULL,enabled=1,retired=0,host_drained_at_ms=NULL,updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
        .run(Math.max(nowMs, current.updatedAtMs), workspaceId, objectId);
    }
    if (input.intent !== "share") recordDemand(storage, {workspaceId, objectId}, nowMs, owner);
    input.changed?.(enabling);
    return read(storage, workspaceId, path)!;
  }
  if (moved(objectId)) throw relayError("conflict", MOVED);
  assertCapacity(storage, workspaceId, full, input.intent === "personal-open" ? {workspaceId, ownerUserId, path, shareId, ownerDemand: false} : undefined);
  const charge = Buffer.byteLength(JSON.stringify([workspaceId, objectId, path, ownerUserId, shareId, identity.replicationEpoch, identity.streamIdentity])) + 64;
  assertWorkspaceQuota(storage, workspaceId, charge);
  storage.db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`)
    .run(workspaceId, objectId, path, ownerUserId, shareId, identity.replicationEpoch, identity.streamIdentity, nowMs, nowMs, input.intent === "share" ? null : nowMs, charge);
  storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, workspaceId);
  input.changed?.(true);
  return read(storage, workspaceId, path)!;
}
/** Records hosting demand. An owner's also takes the document out of the agent-only caps. */
function recordDemand(storage: StorageContext, document: {workspaceId: string; objectId: string}, nowMs: number, owner: boolean): void {
  storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET demand_at_ms=max(COALESCE(demand_at_ms,0),?),owner_demand=max(owner_demand,?)
    WHERE workspace_id=? AND object_id=?`).run(nowMs, Number(owner), document.workspaceId, document.objectId);
}
/**
 * Renews the demand of a document a personal session kept open, when that
 * session closes. A document its owner paused, stopped or that retired keeps
 * its state. Returns whether it renewed.
 */
export function renewPersonalSessionDemand(storage: StorageContext, input: {workspaceId: string; objectId: string; nowMs: number}): boolean {
  const workspaceId = parseWorkspaceId(input.workspaceId), objectId = parseLiveUpdateIdentifier(input.objectId, "object ID"), nowMs = timestamp(input.nowMs);
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET demand_at_ms=max(COALESCE(demand_at_ms,0),?)
      WHERE workspace_id=? AND object_id=? AND retired=0 AND owner_stop IS NULL`).run(nowMs, workspaceId, objectId).changes === 1;
  });
}
export const HELD_CHANGED = "This document changed while live editing was resuming. Try again.";
export const restoreInProgress = (storage: StorageContext, workspaceId: string, objectId: string) =>
  storage.db.prepare(`SELECT 1 FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND ${UNFINISHED_RESTORE}`)
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
  if (input.enabled !== false || (input.retire !== undefined && typeof input.retire !== "boolean")) {
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
        if (!prepared) throw relayError("host-not-loaded");
        if (prepared.activationId !== activation.activationId || prepared.lineageClaimId !== activation.lineageClaimId) throw relayError("conflict");
        if (prepared.restoreFenceGeneration !== activation.restoreFenceGeneration) throw new ServiceHostRetirementConflict(activation.restoreFenceGeneration);
        prepared.assertCurrent();
      });
      const high = retirement ? {cursor: retirement.acceptedThrough} : storage.db.prepare("SELECT MAX(journal_cursor) AS cursor FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=(SELECT lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current')")
        .get(workspaceId,current.objectId,workspaceId,current.objectId);
      acceptedCursor = timestamp(high?.cursor ?? 0);
    }
    const ownerStop = input.retire === true || current.ownerStop === "retire" ? "retire" : "pause";
    // Pause fences admission and retires the activation in this transaction, and keeps the enrollment until host unload.
    // Stop fences new acceptance here too. Resume leaves an unfinished retirement in place.
    if (ownerStop === "pause") openServiceActivationRetirement(storage, current, nowMs);
    const enabled = input.retire ? false : current.enabled;
    const retired = !enabled && (current.retired || ownerStop === "retire");
    storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop=?,enabled=?,retired=?,host_drained_at_ms=?,updated_at_ms=? WHERE workspace_id=? AND object_id=?`)
      .run(ownerStop, Number(enabled), Number(retired), current.hostDrainedAtMs, Math.max(nowMs, current.updatedAtMs), workspaceId, current.objectId);
    // Stop ends the run, so nothing the restore kept continues after it. Pause keeps the run.
    if (input.retire) endServiceHostRun(storage, current, nowMs);
    // Stop retires at once, so the release that clears upload proof never sees this row. The retirement it opened keeps that proof until it completes.
    forgetIdleServiceHostUploads(storage, workspaceId);
    return {...read(storage, workspaceId, current.path)!, ...(acceptedCursor === undefined ? {} : {acceptedCursor}),
      ...(input.retire ? {changed: !current.retired} : {})};
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
function coveredByEditGrant(storage: StorageContext, enrollment: Pick<ServiceHostEnrollment, "workspaceId" | "ownerUserId" | "path"> & {shareId?: string | null}): boolean {
  // Admission runs this on every update. The share that enrolled the document almost always still covers it, so it is
  // checked first by key; the rest are read only when it doesn't, and the scan stops at the first that does.
  if (enrollment.shareId != null) {
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
/**
 * The enrolled documents an active Edit grant on the share covers. A change
 * that may end Edit grants reads them first, inside its transaction.
 */
export function serviceHostEnrollmentsCoveredByShare(storage: StorageContext, shareId: string): readonly ServiceHostEnrollment[] {
  const share = storage.db.prepare(`SELECT ${EDIT_SHARE_COLUMNS} FROM sync_relay_shares s WHERE s.share_id=? AND ${ACTIVE_EDIT_GRANT}`).get(shareId);
  if (!share) return [];
  // Capacity bounds the active rows.
  return storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND owner_user_id=? AND retired=0`)
    .all(String(share.workspace_id), String(share.granter_user_id)).map(row).filter(enrollment => coversEnrolledPath(share, enrollment.path));
}
/**
 * The owner's restore that keeps the document's live session through its own
 * revocation: its exact document and activation. Every other document the
 * revocation leaves uncovered still retires.
 */
export interface KeptServiceActivation {
  readonly workspaceId: string; readonly objectId: string; readonly activationId: string;
  /** Runs inside the transaction once the revocation kept that activation. */
  kept(): void;
}
/**
 * Records, inside the change's transaction, the end of the run and the
 * retirement of each document's activation that no Edit grant on any of its
 * owner's shares covers now. `keep` leaves its own activation running
 * instead, but never one whose retirement is already open: that stands.
 */
export function retireUncoveredServiceActivations(storage: StorageContext, enrollments: readonly ServiceHostEnrollment[], nowMs: number,
  keep?: KeptServiceActivation): void {
  for (const enrollment of enrollments) {
    if (coveredByEditGrant(storage, enrollment) || demanded(storage, enrollment)) continue;
    // Null while a retirement is open.
    if (keep?.workspaceId === enrollment.workspaceId && keep.objectId === enrollment.objectId &&
      retirableServiceActivation(storage, enrollment)?.activationId === keep.activationId) {keep.kept(); continue;}
    endServiceHostRun(storage, enrollment, nowMs);
    openServiceActivationRetirement(storage, enrollment, nowMs);
  }
}
/** Ends the enrollment's run: its run token moves past every earlier one. */
export function endServiceHostRun(storage: StorageContext, document: {workspaceId: string; objectId: string}, nowMs: number): void {
  storage.db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET created_at_ms=max(?,created_at_ms+1),updated_at_ms=max(updated_at_ms,?,created_at_ms+1)
    WHERE workspace_id=? AND object_id=?`).run(timestamp(nowMs), timestamp(nowMs), document.workspaceId, document.objectId);
}
/** Where the owner's restore records, in its stored intent, the live session it kept. The request never carries it. */
export const KEPT_RUN = "keptRun";
/** The enrollment run and owner, and the activation the owner's restore kept through its own revocation. */
export interface KeptServiceRun {readonly runToken: number; readonly ownerUserId: string; readonly activationId: string}
type CoveredEnrollment = Pick<ServiceHostEnrollment, "workspaceId" | "objectId" | "ownerUserId" | "shareId" | "path">;
/**
 * Whether the owner's restore kept this enrolled document's live session
 * through its own revocation, and that still holds: the document's latest
 * restore names the enrollment's current run and owner, under the
 * workspace's current owner and identity, at the document's current lineage
 * and path. Any ordinary end of Edit access, and Stop, end the run; Pause
 * keeps it. With `resumed` the restore must have resumed at the document's
 * current fence; without it an unfinished restore also counts.
 */
function keptByRestore(storage: StorageContext, enrollment: CoveredEnrollment, resumed: boolean): boolean {
  const {workspaceId, objectId, path, ownerUserId} = enrollment;
  const run = storage.db.prepare(`SELECT e.created_at_ms FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
    WHERE e.workspace_id=? AND e.object_id=? AND e.path=? AND e.owner_user_id=? AND w.owner_user_id=e.owner_user_id
      AND w.replication_epoch=e.replication_epoch AND w.stream_identity=e.stream_identity`).get(workspaceId, objectId, path, ownerUserId);
  if (!run) return false;
  const restore = latestRestore(storage, workspaceId, objectId);
  if (!restore || typeof restore.kept !== "string" || restore.phase === "declined") return false;
  const document = storage.db.prepare(`SELECT restore_fence_generation AS fence FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main'
    AND object_id=? AND lineage_claim_id=? AND lineage_state='current' AND current_path=?`).get(workspaceId, objectId, restore.lineage_claim_id, path);
  if (!document || (restore.phase === "resumed" ? restore.new_fence !== document.fence : resumed) ||
    storage.objectIdAtPathInVersion({workspaceId, versionId: "main", path}) !== objectId) return false;
  const kept: Partial<KeptServiceRun> = JSON.parse(restore.kept);
  return kept.runToken === Number(run.created_at_ms) && kept.ownerUserId === ownerUserId;
}
const RESTORE_ROW = `SELECT phase,new_fence,lineage_claim_id,json_extract(intent_json,'$.${KEPT_RUN}') AS kept FROM ${LIVE_RESTORE_OPERATIONS}`;
/** The statements that find a document's latest restore, each along an index of the restore table. */
export const LATEST_RESTORE = {
  // A document has at most one unfinished restore, and no other can begin after it.
  unfinished: `${RESTORE_ROW} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND ${UNFINISHED_RESTORE}`,
  // Each fence is one past the one before, so the highest is the latest fenced restore. Every fence is at least 2.
  fenced: `${RESTORE_ROW} WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id='main' AND object_id=? AND new_fence>0
    ORDER BY new_fence DESC LIMIT 1`,
} as const;
/**
 * The document's unfinished restore, or else its latest fenced restore in the
 * attached history. A later restore that ended before its fence is not read:
 * its revocation ended the run, or kept it and ending the restore ended it,
 * or left the run as it found it.
 */
function latestRestore(storage: StorageContext, workspaceId: string, objectId: string) {
  const unfinished = storage.db.prepare(LATEST_RESTORE.unfinished).get(workspaceId, objectId);
  if (unfinished) return unfinished;
  const namespace = attachedLiveJournalHistoryNamespace(storage);
  return namespace === undefined ? undefined : storage.db.prepare(LATEST_RESTORE.fenced).get(namespace, workspaceId, objectId);
}
/** Whether the host keeps a document the owner's restore kept live, from its revocation on. It admits no edit before the restore resumed. */
export const serviceHostOwnerRetains = (storage: StorageContext, enrollment: CoveredEnrollment) => keptByRestore(storage, enrollment, false);
/** Whether an open or Resume recorded hosting demand on the enrollment as the caller knows it. */
function demanded(storage: StorageContext, enrollment: Pick<CoveredEnrollment, "workspaceId" | "objectId" | "ownerUserId" | "path">): boolean {
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=? AND owner_user_id=? AND path=? AND demand_at_ms IS NOT NULL`)
    .get(enrollment.workspaceId, enrollment.objectId, enrollment.ownerUserId, enrollment.path) !== undefined;
}
const covered = (storage: StorageContext, enrollment: CoveredEnrollment) =>
  coveredByEditGrant(storage, enrollment) || demanded(storage, enrollment) || serviceHostOwnerRetains(storage, enrollment);
/**
 * Whether the host keeps the enrolled document: an active Edit grant on any
 * of the owner's shares still covers it, an open or Resume asked for it, or
 * the owner's restore kept its live session.
 */
export function serviceHostEnrollmentCovered(storage: StorageContext, enrollment: CoveredEnrollment): boolean {
  storage.captureStanding();
  return covered(storage, enrollment);
}
/**
 * Ends the run of a live session the owner's restore kept, once nothing
 * covers the enrolled document, and opens its activation's retirement. The
 * host then retires the activation before it lets the document go. Every
 * other end of Edit access opened a retirement already, and that one stands.
 * Returns whether it opened one.
 */
export function endLapsedServiceHostRun(storage: StorageContext, enrollment: ServiceHostEnrollment, nowMs: number): boolean {
  if (!retirableServiceActivation(storage, enrollment)) return false;
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    const value = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(enrollment.workspaceId, enrollment.objectId);
    const current = value ? row(value) : null;
    if (!current || covered(storage, current) || !retirableServiceActivation(storage, current)) return false;
    endServiceHostRun(storage, current, nowMs);
    return openServiceActivationRetirement(storage, current, nowMs) !== null;
  });
}
/**
 * Called once the service host no longer holds the document. Applies the
 * owner's pending Pause, and retires an enrollment that no active Edit
 * grant covers and no owner's restore kept live. Returns null when neither applies.
 */
export function releaseServiceHostEnrollment(storage: StorageContext, input: {workspaceId: string; objectId: string; nowMs: number}): ServiceHostEnrollment | null {
  const nowMs = timestamp(input.nowMs), standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    const value = storage.db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`).get(parseWorkspaceId(input.workspaceId), input.objectId);
    const current = value ? row(value) : null;
    if (!current) return null;
    const uncovered = !covered(storage, current);
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
 * Whether the document has an enrollment. A personal agent's session needs
 * one, as its open leaves, since absence enables a document only for hosts
 * configured without enrollments.
 */
export function serviceHostDocumentEnrolled(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
    .get(document.workspaceId, document.objectId) !== undefined;
}

/**
 * Absence preserves explicitly configured hosts. A retained enrollment fences
 * its document once its owner pauses or stops it, its workspace changes, or no
 * Edit grant of its owner covers its enrolled path. Only `owner`, the
 * enrollment's own owner, continues where the owner's restore kept the live
 * session, once that restore resumed. With `restoring`, the host also keeps
 * it while that restore is unfinished; live admission never passes it. An
 * open retirement fences it until its activation retires, whatever its
 * enrollment.
 */
export function serviceHostDocumentEnabled(storage: StorageContext, document: {workspaceId: string; objectId: string},
  owner?: {userId: string}, restoring = false): boolean {
  if (serviceActivationRetirementOpen(storage, document)) return false;
  const value = storage.db.prepare(`SELECT e.enabled,e.retired,e.owner_stop,e.owner_user_id,e.path,e.share_id,e.replication_epoch,e.stream_identity,e.demand_at_ms,
    w.owner_user_id AS current_owner,w.replication_epoch AS current_epoch,w.stream_identity AS current_stream
    FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
    WHERE e.workspace_id=? AND e.object_id=?`).get(document.workspaceId, document.objectId);
  if (!value) return true;
  const enrollment = {workspaceId: document.workspaceId, objectId: document.objectId, ownerUserId: String(value.owner_user_id), path: String(value.path),
    shareId: value.share_id === null ? null : String(value.share_id)};
  return value.enabled === 1 && value.retired === 0 && value.owner_stop === null && value.owner_user_id === value.current_owner &&
    value.replication_epoch === value.current_epoch && value.stream_identity === value.current_stream && (value.demand_at_ms !== null ||
      coveredByEditGrant(storage, enrollment) || (owner?.userId === enrollment.ownerUserId && keptByRestore(storage, enrollment, !restoring)));
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
