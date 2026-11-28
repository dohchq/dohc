import { visibleSharePath } from "@dohc/security-contract/share-selector";
import type { StorageContext } from "./context";
import type { SqliteDb, SyncRelayShareRow } from "./types";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { asRecord, validateUserWritePath } from "@dohc/workspace-core";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import * as Y from "yjs";
import { LIVE_AUTHOR_CLIENTS } from "./liveAuthorshipSchema";
import { documentParams, liveJournalSeedClientIds } from "./liveUpdateJournal";
import {
  effectiveShareSelector,
  isLiveEditShareSelector,
  isWorkspaceSelector,
  parseStoredAnyShareSelectorJson,
  pathLevel,
  type AnyShareSelector,
} from "../shareFilter";
import { authorizeShareGrantAction } from "../shareAuthorization";
import { workspaceFileReach } from "../workspaceReach";
import { readCurrentShareGrant } from "./currentShareGrant";
import { getWorkspaceMembership, workspaceMemberGrantId } from "./workspaceMembers";
import { parseWorkspaceId } from "../requestInputs";
import { SERVICE_HOST_ORIGIN_PREFIX, isOwnerLogOrigin } from "../relayLogInputs";
import { canonicalLiveSelector, currentLiveDocumentMoment } from "./liveDocumentAuthority";
import { assertWorkspaceQuota } from "./workspaces";
import { SyncRelayQuotaExceededError } from "./errors";
import { forgetServiceHostUploads } from "./serviceHostUploads";
import { hasServiceHostConflictEffect } from "./serviceHostFeed";
import { ORDINARY_ACTIVATION_BASES } from "./ordinaryActivationBasis";
import { LIVE_ROOM_EDITS } from "./liveRoomEdits";
import { LIVE_ROOM_PAUSES } from "./liveRoomPauses";
import { SERVICE_KEPT_EDITS } from "./serviceKeptEdits";
import {
  listServiceActivationRetirements,
  OPEN_RETIREMENT,
  currentIdentity,
  openServiceActivationRetirement,
  retirableServiceActivation,
  serviceActivationRetirementOpen,
  type RetirableServiceActivation,
} from "./serviceActivationRetirement";
import { SERVICE_ACTIVATIONS } from "./serviceActivationSchema";
import { LIVE_JOURNAL_TABLE } from "./schema";
import { badRequest, notFound, relayError } from "../errors";
import { liveEditors } from "../liveEditors";
import {
  AGENT_ONLY_MAX_DOCUMENTS,
  AGENT_ONLY_MAX_WORKSPACES,
  LIVE_NOTE_START_MAX_MS,
  RECLAIM_MAX_DEPARTING,
  RECLAIM_MIN_HOLD_MS,
  RECLAIM_RETENTION_MS,
  MEMBER_OPEN_DEMAND_MS,
  MEMBER_OPEN_MAX_DOCUMENTS,
  SERVICE_HOST_MAX_DOCUMENTS,
  SERVICE_HOST_MAX_WORKSPACES,
} from "../liveHostingLimits";
import type { PersonalCredential } from "./personalAgentChat";
import { ownedPersonalReachIn, readPersonalAuthority } from "./personalAgents";

export { SERVICE_HOST_MAX_DOCUMENTS, SERVICE_HOST_MAX_WORKSPACES };
export const SERVICE_HOST_ENROLLMENTS = "sync_relay_service_host_enrollments";
const MIGRATION = "service-host-enrollments-v2";
const DRAIN_MIGRATION = "service-host-enrollments-v3";
const DEMAND_MIGRATION = "service-host-enrollments-v4";
const RECORD_MIGRATION = "service-host-enrollments-v5";
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
  generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('off','starting','live','stopping')),
  reason TEXT CHECK (reason IN ('never','stopped','paused','access-ended','start-failed')),
  cause TEXT CHECK (cause IN ('refused','no-lineage','failing')),
  since_ms INTEGER NOT NULL CHECK (since_ms >= 0),
  changed_by TEXT NOT NULL CHECK (changed_by='server' OR changed_by GLOB 'person:?*' OR changed_by GLOB 'agent:?*'),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  CHECK ((state='off') = (enabled=0 OR owner_stop IS NOT NULL)),
  CHECK ((state='off') = (reason IS NOT NULL)),
  CHECK ((reason IS 'start-failed') = (cause IS NOT NULL)),
  CHECK (CASE owner_stop WHEN 'pause' THEN reason IS 'paused' WHEN 'retire' THEN reason IS 'stopped' ELSE reason IS NULL OR reason NOT IN ('paused','stopped') END),
  CHECK ((reason IS 'never') = (generation=0)),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
const V4_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
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
const V4_COLUMNS =
  "workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,owner_demand,demand_at_ms,accounted_bytes";
const ACTIVATED = `EXISTS(SELECT 1 FROM ${SERVICE_ACTIVATIONS} a JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
  WHERE a.workspace_id=e.workspace_id AND a.main_version_id='main' AND a.object_id=e.object_id AND d.lineage_state='current'
    AND a.completion_json IS NOT NULL AND a.retire_requested_at_ms IS NULL AND a.retired_at_ms IS NULL AND ${currentIdentity("a")})`;
const V4_OFF = "e.enabled=0 OR e.owner_stop IS NOT NULL";
/** The record a write that ends the note's access sets, with one `?` for the time. A note already off keeps its record. */
export const ACCESS_ENDED = `state='off',reason=COALESCE(reason,'access-ended'),since_ms=CASE WHEN state='off' THEN since_ms ELSE max(since_ms,?) END,changed_by=CASE WHEN state='off' THEN changed_by ELSE 'server' END`;
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
  /** The note's live record. It never disagrees with `enabled`, `retired` and `ownerStop`. */
  readonly note: LiveNoteRecord;
  readonly acceptedCursor?: number;
  /** On the row a Stop returns: whether this Stop retired it, as its transaction found the row. A retired row stays unchanged. */
  readonly changed?: boolean;
}
export type LiveNoteState = "off" | "starting" | "live" | "stopping";
export type LiveNoteOffReason = "never" | "stopped" | "paused" | "access-ended" | "start-failed";
export type LiveNoteStartFailure = "refused" | "no-lineage" | "failing";
/** Who made the record's last move: a person, an agent's connection, or the relay itself. */
export type LiveNoteActor = `person:${string}` | `agent:${string}` | "server";
/** Where a note is in going live, as the relay records it. Each start begins a new generation. */
export interface LiveNoteRecord {
  readonly generation: number;
  readonly state: LiveNoteState;
  /** Why the note is off, and null while it is not. */
  readonly reason: LiveNoteOffReason | null;
  /** Why its last start failed, on an off note whose reason is `start-failed`. */
  readonly cause: LiveNoteStartFailure | null;
  readonly sinceMs: number;
  readonly changedBy: LiveNoteActor;
}
/** One move of a note's record. Each leaves one state: start leaves off, and started and start failed leave starting. */
export type LiveNoteMove =
  | { move: "start"; by: LiveNoteActor }
  | { move: "started" }
  | { move: "start-failed"; cause: LiveNoteStartFailure };
export type MoveLiveNoteInput = LiveNoteMove & {
  workspaceId: string;
  objectId: string;
  /** The generation the caller read. A move refuses a record that has moved past it. */
  generation: number;
  nowMs: number;
};
/** A refused move answers with the record as the move found it, or null when the note has no record. */
export type MoveLiveNoteResult =
  | { moved: true; record: LiveNoteRecord }
  | { moved: false; record: LiveNoteRecord | null };
/**
 * Why hosting is asked for. `personal-open` is an agent's open of a document,
 * `owner-open` the owner's open from a desktop or phone, which may enroll a
 * document for the first time, `owner-resume` the owner's Resume, and `share`
 * an owner Edit share that covers the path, and `member-open` a workspace member's
 * open at Edit. Only Resume clears the owner's
 * Pause or Stop.
 */
export type LiveHostingIntent =
  | "personal-open"
  | "member-open"
  | "owner-open"
  | "owner-resume"
  | "share";
interface EnsureOwnedLiveDocumentCommon {
  workspaceId: string;
  path: string;
  nowMs: number;
  guard(): void;
  /** Hears, inside the transaction, whether this call enabled the document. One already hosted is unchanged. */
  changed?(changed: boolean): void;
}
export type EnsureOwnedLiveDocumentInput = EnsureOwnedLiveDocumentCommon &
  (
    | { intent: "share"; ownerUserId: string; shareId: string }
    | { intent: "owner-open"; ownerUserId: string }
    /** `held` is the host's snapshot of a document it holds for an unadmitted live edit. Its Resume retires that activation. */
    | { intent: "owner-resume"; ownerUserId: string; held?: ServiceHostHeldActivation }
    /** The agent's credential at the fence its request read. The transaction reads its authority and reach again. */
    | { intent: "personal-open"; personal: PersonalCredential }
    /** The signed-in account. The transaction reads its membership, grant and level. */
    | { intent: "member-open"; userId: string }
  );
/** A hosting answer that is the caller's to act on, not an error in the request. */
export type LiveHostingRefusalReason =
  | "paused"
  | "live_paused_by_owner"
  | "live_host_full"
  | "document-unavailable";
export class LiveHostingRefusal extends Error {
  constructor(readonly reason: LiveHostingRefusalReason) {
    super(
      reason === "live_host_full"
        ? "The server has no room for more live documents."
        : reason === "paused"
          ? "Live editing is stopped for this document. Resume it to continue."
          : reason === "document-unavailable"
            ? "The document is no longer at this path."
            : "The owner stopped live editing for this document.",
    );
  }
}
export interface ServiceHostHeldActivation {
  readonly activationId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
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
  workspaceId: string;
  path: string;
  objectId?: string;
  ownerUserId: string;
  enabled: false;
  retire?: boolean;
  restoreFenceGeneration?: number;
  /** Stop of a prepared activation retires only the activation the host prepared. */
  prepared?: ServiceHostRetirementPreparation;
  nowMs: number;
  guard(): void;
}
export interface ServiceHostCandidateCursor {
  workspaceId: string;
  shareId: string;
}
export interface ServiceHostCandidatePage {
  shares: readonly SyncRelayShareRow[];
  nextCursor: ServiceHostCandidateCursor | null;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid service host enrollment timestamp.");
  return value;
}
function canonicalPath(value: string): string {
  const checked = validateUserWritePath(value);
  if (!checked.ok || checked.normalized !== value || liveDocumentKindForPath(value) !== "richdoc")
    throw badRequest("Service host enrollment requires a rich document path.");
  return value;
}
function row(value: Record<string, unknown>): ServiceHostEnrollment {
  const text = (key: string) => parseLiveUpdateIdentifier(value[key], key);
  const runToken = timestamp(value.created_at_ms),
    updatedAtMs = timestamp(value.updated_at_ms),
    hostDrainedAtMs =
      value.host_drained_at_ms === null ? null : timestamp(value.host_drained_at_ms),
    ownerStop = value.owner_stop,
    demandAtMs = value.demand_at_ms === null ? null : timestamp(value.demand_at_ms);
  if (
    updatedAtMs < runToken ||
    (value.enabled !== 0 && value.enabled !== 1) ||
    (value.retired !== 0 && value.retired !== 1) ||
    (value.retired === 1 && value.enabled !== 0) ||
    (value.owner_demand !== 0 && value.owner_demand !== 1) ||
    (ownerStop !== null && ownerStop !== "pause" && ownerStop !== "retire")
  )
    throw new Error("Service host enrollment is damaged.");
  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspace_id),
    objectId: text("object_id"),
    path: canonicalPath(String(value.path)),
    ownerUserId: text("owner_user_id"),
    shareId: value.share_id === null ? null : text("share_id"),
    replicationEpoch: text("replication_epoch"),
    streamIdentity: text("stream_identity"),
    ownerStop,
    enabled: value.enabled === 1,
    retired: value.retired === 1,
    runToken,
    updatedAtMs,
    hostDrainedAtMs,
    ownerDemand: value.owner_demand === 1,
    demandAtMs,
    note: record(value),
  });
}
const STATES: readonly LiveNoteState[] = ["off", "starting", "live", "stopping"];
const REASONS: readonly LiveNoteOffReason[] = [
  "never",
  "stopped",
  "paused",
  "access-ended",
  "start-failed",
];
const CAUSES: readonly LiveNoteStartFailure[] = ["refused", "no-lineage", "failing"];
function record(value: Record<string, unknown>): LiveNoteRecord {
  const { generation, state, reason, cause, changed_by: changedBy } = value;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !STATES.includes(state as LiveNoteState) ||
    (reason !== null && !REASONS.includes(reason as LiveNoteOffReason)) ||
    (state === "off") !== (reason !== null) ||
    (cause !== null && !CAUSES.includes(cause as LiveNoteStartFailure)) ||
    (reason === "start-failed") !== (cause !== null) ||
    typeof changedBy !== "string" ||
    !/^(server|person:.+|agent:.+)$/s.test(changedBy)
  )
    throw new Error("Service host enrollment is damaged.");
  return Object.freeze({
    generation,
    state: state as LiveNoteState,
    reason: reason as LiveNoteOffReason | null,
    cause: cause as LiveNoteStartFailure | null,
    sinceMs: timestamp(value.since_ms),
    changedBy: changedBy as LiveNoteActor,
  });
}
export function initializeServiceHostEnrollmentSchema(db: SqliteDb): void {
  const isMarked = (migration: string) =>
    db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration) !==
    undefined;
  const marked = isMarked(MIGRATION),
    drainMarked = isMarked(DRAIN_MIGRATION),
    demandMarked = isMarked(DEMAND_MIGRATION),
    recordMarked = isMarked(RECORD_MIGRATION);
  const existing = () =>
    db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_HOST_ENROLLMENTS);
  const exact = (sql: string) => {
    const value = existing();
    return (
      !!value &&
      value.type === "table" &&
      typeof value.sql === "string" &&
      value.sql.replace(/\s+/g, " ").trim() === sql.replace(/\s+/g, " ").trim()
    );
  };
  if (recordMarked) {
    if (!exact(SQL)) throw new Error("Service host enrollment storage is damaged.");
  } else if (demandMarked) {
    if (!exact(V4_SQL)) throw new Error("Service host enrollment storage is damaged.");
    assertServiceHostEnrollmentConstraints(db);
  } else if (marked && !drainMarked && exact(V2_SQL)) {
    assertServiceHostEnrollmentConstraints(db);
    db.exec(`ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO ${SERVICE_HOST_ENROLLMENTS}_v2;
      ${V4_SQL};
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
      ${V4_SQL};
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
      ${V4_SQL};
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
  if (!recordMarked && exact(V4_SQL)) {
    db.exec(`ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO ${SERVICE_HOST_ENROLLMENTS}_v4;
      ${SQL};`);
    db.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(${V4_COLUMNS},generation,state,reason,cause,since_ms,changed_by)
      SELECT ${V4_COLUMNS.split(",")
        .map((column) => `e.${column}`)
        .join(",")},1,
        CASE WHEN ${V4_OFF} THEN 'off' WHEN ${ACTIVATED} THEN 'live' ELSE 'starting' END,
        CASE e.owner_stop WHEN 'retire' THEN 'stopped' WHEN 'pause' THEN 'paused' ELSE CASE WHEN e.enabled=0 THEN 'access-ended' END END,
        NULL,
        CASE WHEN ${V4_OFF} OR ${ACTIVATED} THEN e.updated_at_ms ELSE ? END,
        CASE WHEN e.owner_stop IS NULL OR e.owner_user_id='' THEN 'server' ELSE 'person:'||e.owner_user_id END
      FROM ${SERVICE_HOST_ENROLLMENTS}_v4 e`).run(Date.now());
    db.exec(`DROP TABLE ${SERVICE_HOST_ENROLLMENTS}_v4;
      ${ACTIVE_INDEX_SQL};
      ${RETIRED_INDEX_SQL};`);
  }
  if (!exact(SQL)) throw new Error("Service host enrollment storage is damaged.");
  assertServiceHostEnrollmentConstraints(db);
  for (const [migration, done] of [
    [MIGRATION, marked],
    [DRAIN_MIGRATION, drainMarked],
    [DEMAND_MIGRATION, demandMarked],
    [RECORD_MIGRATION, recordMarked],
  ] as const) {
    if (!done)
      db.prepare(
        "INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)",
      ).run(migration, Date.now());
  }
}
/** All enrollment layouts share these indexes, so one check covers them. */
function assertServiceHostEnrollmentConstraints(db: SqliteDb): void {
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_HOST_ENROLLMENTS})`).all();
  const activeIndex = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
    .get(ACTIVE_INDEX);
  const retiredIndex = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
    .get(RETIRED_INDEX);
  const candidateIndex = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
    .get(CANDIDATE_INDEX);
  if (
    indexes.length !== 4 ||
    indexes.some((index) =>
      index.name === ACTIVE_INDEX || index.name === RETIRED_INDEX
        ? index.unique !== 0 || index.partial !== 1 || index.origin !== "c"
        : index.unique !== 1 ||
          index.partial !== 0 ||
          (index.origin !== "pk" && index.origin !== "u"),
    ) ||
    typeof activeIndex?.sql !== "string" ||
    activeIndex.sql.replace(/\s+/g, " ").trim() !== ACTIVE_INDEX_SQL.replace(/\s+/g, " ").trim() ||
    typeof retiredIndex?.sql !== "string" ||
    retiredIndex.sql.replace(/\s+/g, " ").trim() !==
      RETIRED_INDEX_SQL.replace(/\s+/g, " ").trim() ||
    typeof candidateIndex?.sql !== "string" ||
    candidateIndex.sql.replace(/\s+/g, " ").trim() !==
      CANDIDATE_INDEX_SQL.replace(/\s+/g, " ").trim() ||
    db.prepare(`PRAGMA foreign_key_check(${SERVICE_HOST_ENROLLMENTS})`).all().length ||
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
      .get(SERVICE_HOST_ENROLLMENTS)
  )
    throw new Error("Service host enrollment constraints are damaged.");
}
function ownedIdentity(storage: StorageContext, workspaceId: string, ownerUserId: string) {
  if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
  const identity = storage.getWorkspaceIdentity(workspaceId);
  if (!identity) throw relayError("conflict", "Sync this workspace before enabling live editing.");
  return identity;
}
function assertCurrent(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  ownerUserId: string,
) {
  const identity = ownedIdentity(storage, enrollment.workspaceId, ownerUserId);
  if (
    enrollment.ownerUserId !== ownerUserId ||
    enrollment.replicationEpoch !== identity.replicationEpoch ||
    enrollment.streamIdentity !== identity.streamIdentity
  ) {
    throw relayError(
      "conflict",
      "Service host enrollment belongs to an obsolete workspace identity.",
    );
  }
}
/** A share intent needs the owner's share to cover the path and hold an active Edit grant. */
function assertShareCovers(
  storage: StorageContext,
  input: { workspaceId: string; path: string; shareId: string; ownerUserId: string },
): void {
  const share = storage.getShare(input.shareId);
  if (
    !share ||
    share.workspaceId !== input.workspaceId ||
    share.granterUserId !== input.ownerUserId
  )
    throw notFound();
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
  const effective = parsed && effectiveShareSelector(parsed, "edit");
  const granted =
    storage.db
      .prepare(`SELECT 1 FROM sync_relay_shares s WHERE s.share_id=? AND ${ACTIVE_EDIT_GRANT}`)
      .get(input.shareId) !== undefined;
  if (
    !granted ||
    !effective ||
    !isLiveEditShareSelector(effective) ||
    !canonicalLiveSelector(share, effective) ||
    visibleSharePath(effective, input.path) !== input.path
  ) {
    throw badRequest("Service host enrollment requires an owner edit share covering this path.");
  }
}
/** The current rich document at the path on main. An agent's open hears its absence as an answer. */
function currentMainDocument(
  storage: StorageContext,
  input: { workspaceId: string; path: string },
  answered = false,
): string {
  const objectId = storage.objectIdAtPathInVersion({
    workspaceId: input.workspaceId,
    versionId: "main",
    path: input.path,
  });
  if (
    !objectId ||
    !currentLiveDocumentMoment(
      storage,
      {
        workspaceId: input.workspaceId,
        mainVersionId: "main",
        objectId,
        lineageClaimId: "0".repeat(64),
      },
      input.path,
    )
  ) {
    throw answered
      ? new LiveHostingRefusal("document-unavailable")
      : relayError("conflict", "Service host enrollment requires a current main document.");
  }
  return objectId;
}
function read(storage: StorageContext, workspaceId: string, path: string) {
  const value = storage.db
    .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND path=?`)
    .get(workspaceId, path);
  return value ? row(value) : null;
}
export function readServiceHostEnrollment(
  storage: StorageContext,
  workspaceId: string,
  path: string,
): ServiceHostEnrollment | null {
  storage.captureStanding();
  return read(storage, parseWorkspaceId(workspaceId), canonicalPath(path));
}
/** Includes drained and retired enrollments, whose stores can still hold edits. */
export function readServiceHostEnrollmentByObjectId(
  storage: StorageContext,
  workspaceId: string,
  objectId: string,
): ServiceHostEnrollment | null {
  storage.captureStanding();
  return readByObject(
    storage,
    parseWorkspaceId(workspaceId),
    parseLiveUpdateIdentifier(objectId, "object ID"),
  );
}
function readByObject(storage: StorageContext, workspaceId: string, objectId: string) {
  const value = storage.db
    .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
    .get(workspaceId, objectId);
  return value ? row(value) : null;
}
const LEAVES: Readonly<Record<LiveNoteMove["move"], LiveNoteState>> = {
  start: "off",
  started: "starting",
  "start-failed": "starting",
};
/**
 * Moves the note's record in one transaction. A start begins the next
 * generation and enables the note, which clears the owner's Pause or Stop. A
 * start failed ends the run, opens its activation's retirement and retires
 * the note, so only a new start brings it back. A move that does not leave
 * the state and generation it names changes nothing.
 */
export function moveLiveNote(
  storage: StorageContext,
  input: MoveLiveNoteInput,
): MoveLiveNoteResult {
  const workspaceId = parseWorkspaceId(input.workspaceId),
    objectId = parseLiveUpdateIdentifier(input.objectId, "object ID"),
    standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return moveLiveNoteInTransaction(storage, { ...input, workspaceId, objectId });
  });
}
/** `moveLiveNote` inside the caller's transaction. */
export function moveLiveNoteInTransaction(
  storage: StorageContext,
  input: MoveLiveNoteInput,
): MoveLiveNoteResult {
  const nowMs = timestamp(input.nowMs),
    current = readByObject(storage, input.workspaceId, input.objectId);
  if (
    !current ||
    current.note.state !== LEAVES[input.move] ||
    current.note.generation !== input.generation
  )
    return { moved: false, record: current?.note ?? null };
  const at = [current.workspaceId, current.objectId] as const;
  if (input.move === "start")
    storage.db
      .prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop=NULL,enabled=1,retired=0,host_drained_at_ms=NULL,updated_at_ms=max(updated_at_ms,?),
        generation=generation+1,state='starting',reason=NULL,cause=NULL,since_ms=max(since_ms,?),changed_by=? WHERE workspace_id=? AND object_id=?`)
      .run(nowMs, nowMs, input.by, ...at);
  else if (input.move === "started")
    storage.db
      .prepare(
        `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET state='live',since_ms=max(since_ms,?),changed_by='server' WHERE workspace_id=? AND object_id=?`,
      )
      .run(nowMs, ...at);
  else {
    endServiceHostRun(storage, current, nowMs);
    openServiceActivationRetirement(storage, current, nowMs);
    storage.db
      .prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=1,updated_at_ms=max(updated_at_ms,?),
        state='off',reason='start-failed',cause=?,since_ms=max(since_ms,?),changed_by='server' WHERE workspace_id=? AND object_id=?`)
      .run(nowMs, input.cause, nowMs, ...at);
    forgetIdleServiceHostUploads(storage, current.workspaceId);
  }
  return { moved: true, record: readByObject(storage, ...at)!.note };
}
/** Inside the caller's transaction, moves a starting note to live once its activation completed. */
export function liveNoteStarted(
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
  nowMs: number,
): void {
  const current = readByObject(storage, document.workspaceId, document.objectId);
  if (current?.note.state === "starting")
    moveLiveNoteInTransaction(storage, {
      ...document,
      generation: current.note.generation,
      nowMs,
      move: "started",
    });
}
/**
 * Moves each note still starting `LIVE_NOTE_START_MAX_MS` after its start to
 * off (start-failed), with the cause `cause` gives it. The time is the
 * record's own, so a restart of the relay keeps it. Returns the notes it moved.
 */
export function failLapsedLiveNoteStarts(
  storage: StorageContext,
  nowMs: number,
  cause: (enrollment: ServiceHostEnrollment) => LiveNoteStartFailure,
): readonly ServiceHostEnrollment[] {
  const now = timestamp(nowMs);
  storage.captureStanding();
  const lapsed = storage.db
    .prepare(
      `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 AND state='starting' AND since_ms<=? LIMIT ?`,
    )
    .all(now - LIVE_NOTE_START_MAX_MS, SERVICE_HOST_MAX_DOCUMENTS)
    .map(row)
    .filter((enrollment) => covered(storage, enrollment, now));
  return lapsed.flatMap((enrollment) => {
    const { workspaceId, objectId } = enrollment;
    return storage.moveLiveNote({
      workspaceId,
      objectId,
      generation: enrollment.note.generation,
      nowMs: now,
      move: "start-failed",
      cause: cause(enrollment),
    }).moved
      ? [readByObject(storage, workspaceId, objectId)!]
      : [];
  });
}
function savedFile(payloadJson: string) {
  let save: Record<string, unknown> | null;
  try {
    save = asRecord(JSON.parse(payloadJson));
  } catch {
    return null;
  }
  const objectId = save?.objectId,
    path = save?.path,
    before = save?.payloadBeforeBlobSha256;
  return typeof objectId === "string" && typeof path === "string" && typeof before === "string"
    ? { objectId, path, before }
    : null;
}
function stoppedBy(
  storage: StorageContext,
  input: { workspaceId: string; userId: string; objectId: string; path: string },
): boolean {
  const { workspaceId, userId, objectId, path } = input;
  const enrollment = storage.db
    .prepare(
      `SELECT path FROM ${SERVICE_HOST_ENROLLMENTS}
        WHERE workspace_id=? AND object_id=? AND owner_user_id=? AND owner_stop='retire'`,
    )
    .get(workspaceId, objectId, userId);
  return (
    enrollment?.path === path &&
    storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path }) === objectId
  );
}
export function isOwnerSaveOfStoppedNote(
  storage: StorageContext,
  input: { workspaceId: string; userId: string; payloadJson: string },
): boolean {
  const { workspaceId, userId } = input;
  const save = savedFile(input.payloadJson);
  return (
    save !== null &&
    stoppedBy(storage, { workspaceId, userId, objectId: save.objectId, path: save.path })
  );
}
export function isResumedHostSave(
  storage: StorageContext,
  input: { workspaceId: string; originId: string; payloadJson: string },
): boolean {
  const { workspaceId } = input;
  const save = input.originId.startsWith(SERVICE_HOST_ORIGIN_PREFIX)
    ? savedFile(input.payloadJson)
    : null;
  if (
    !save ||
    storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path: save.path }) !==
      save.objectId
  )
    return false;
  const stored = storage.currentFileBlobSha256({ workspaceId, versionId: "main", path: save.path });
  const source = storage.db
    .prepare(
      `SELECT json_extract(source_json,'$.currentPath') AS path,json_extract(source_json,'$.sourceDigest') AS digest
        FROM ${SERVICE_ACTIVATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=?
        AND retire_requested_at_ms IS NULL AND retired_at_ms IS NULL`,
    )
    .get(workspaceId, save.objectId);
  return stored !== undefined && source?.path === save.path && source.digest === stored;
}
/** Whether the server hosts the document for live editing, or is still letting go of it after a Stop. */
export function isHostedForLiveEditing(
  storage: StorageContext,
  workspaceId: string,
  objectId: string,
): boolean {
  return (
    storage.db
      .prepare(
        `SELECT 1 FROM ${SERVICE_ACTIVATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND retired_at_ms IS NULL
          AND ${currentIdentity(SERVICE_ACTIVATIONS)}`,
      )
      .get(workspaceId, objectId) !== undefined
  );
}
export function bindStoppedNoteClient(
  storage: StorageContext,
  input: { workspaceId: string; userId: string; payloadJson: string; authors: LiveAuthorSnapshot },
): void {
  const { workspaceId, userId } = input;
  let row: Record<string, unknown> | null;
  try {
    row = asRecord(JSON.parse(input.payloadJson));
  } catch {
    return;
  }
  const objectId = row?.objectId,
    path = row?.path,
    lineageClaimId = row?.lineageClaimId,
    update = row?.updateBlobSha256;
  const [author, ...others] = input.authors;
  if (
    row?.versionId !== "main" ||
    row.isBaseState !== false ||
    asRecord(row.attribution)?.actorKind !== "human" ||
    row.actorOriginId !== userId ||
    typeof objectId !== "string" ||
    typeof path !== "string" ||
    typeof lineageClaimId !== "string" ||
    typeof update !== "string" ||
    author?.kind !== "human" ||
    author.humanId !== userId ||
    others.length > 0 ||
    !stoppedBy(storage, { workspaceId, userId, objectId, path })
  )
    return;
  const document = { workspaceId, mainVersionId: "main" as const, objectId, lineageClaimId };
  if (
    !storage.db
      .prepare(
        "SELECT 1 FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=? AND lineage_state='current'",
      )
      .get(workspaceId, objectId, lineageClaimId)
  )
    return;
  const seeds = liveJournalSeedClientIds(storage, document);
  const blob = storage.db
    .prepare("SELECT content FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?")
    .get(workspaceId, update);
  if (!blob) return;
  let clients: number[];
  try {
    clients = [...Y.parseUpdateMeta(new Uint8Array(blob.content as Uint8Array)).from.keys()];
  } catch {
    return;
  }
  const params = documentParams(document);
  const unbound = clients.filter(
    (clientId) =>
      !seeds.includes(clientId) &&
      !storage.db
        .prepare(
          `SELECT 1 FROM ${LIVE_AUTHOR_CLIENTS} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND client_id=?`,
        )
        .get(...params, clientId),
  );
  if (unbound.length !== 1) return;
  const snapshot = JSON.stringify(input.authors);
  const storageBytes = Buffer.byteLength(JSON.stringify([...params, unbound[0], snapshot]));
  try {
    assertWorkspaceQuota(storage, workspaceId, storageBytes);
  } catch (error) {
    if (error instanceof SyncRelayQuotaExceededError) return;
    throw error;
  }
  storage.db
    .prepare(
      `INSERT INTO ${LIVE_AUTHOR_CLIENTS}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,author_snapshot_json,storage_bytes) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(...params, unbound[0]!, snapshot, storageBytes);
}
export function isOwnerSaveOfUnhostedNote(
  storage: StorageContext,
  input: { workspaceId: string; userId: string; payloadJson: string; recordedAtMs: number },
): boolean {
  const { workspaceId, userId, recordedAtMs } = input;
  let save: Record<string, unknown> | null;
  try {
    save = asRecord(JSON.parse(input.payloadJson));
  } catch {
    return false;
  }
  const objectId = save?.objectId,
    path = save?.path,
    before = save?.payloadBeforeBlobSha256;
  if (
    typeof objectId !== "string" ||
    typeof path !== "string" ||
    typeof before !== "string" ||
    liveDocumentKindForPath(path) !== "richdoc"
  )
    return false;
  const stored = storage.db
    .prepare(
      `SELECT f.blob_sha256,l.origin_id,l.recorded_at_ms,json_extract(l.payload_json,'$.objectId') AS object_id
        FROM sync_relay_current_files f JOIN sync_relay_log l ON l.relay_seq=f.state_relay_seq
        WHERE f.workspace_id=? AND f.version_id='main' AND f.path=?`,
    )
    .get(workspaceId, path);
  if (
    typeof stored?.recorded_at_ms !== "number" ||
    stored.object_id !== objectId ||
    typeof stored.origin_id !== "string" ||
    !isOwnerLogOrigin(stored.origin_id) ||
    stored.blob_sha256 === before ||
    recordedAtMs <= stored.recorded_at_ms
  )
    return false;
  return (
    storage.workspaceIsOwnedBy(workspaceId, userId) &&
    storage.db
      .prepare(
        `SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS}
          WHERE workspace_id=? AND object_id=? AND (retired=0 OR owner_stop IS NOT NULL)`,
      )
      .get(workspaceId, objectId) === undefined
  );
}
/** A document retired because no Edit grant covered it is hosted again by the next Edit share that covers it. */
const reclaimable = (enrollment: ServiceHostEnrollment) =>
  enrollment.retired && enrollment.ownerStop === null && enrollment.note.reason !== "start-failed";
/** Whether a new Edit share leaves the path's enrollment as it is: it is active, its owner paused or stopped it, or its start failed. */
export function hasKeptServiceHostEnrollment(
  storage: StorageContext,
  workspaceId: string,
  path: string,
): boolean {
  storage.captureStanding();
  return (
    storage.db
      .prepare(
        `SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND path=? AND (retired=0 OR owner_stop IS NOT NULL OR reason='start-failed')`,
      )
      .get(parseWorkspaceId(workspaceId), canonicalPath(path)) !== undefined
  );
}
const CAPACITY_FULL = "Service host enrollment capacity is full.";
const MOVED = "Service host enrollment document moved from its retained path.";
const RETRY_MOVED =
  "Live editing is still finishing Stop for this document. Wait a moment, then try again.";

function canRebindPreMutation(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  targetPath: string,
): boolean {
  if (
    hasServiceHostConflictEffect(storage, enrollment) ||
    hasServiceHostConflictEffect(storage, { ...enrollment, path: targetPath })
  )
    return false;
  const currentLineage = storage.db
    .prepare(
      "SELECT lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current'",
    )
    .get(enrollment.workspaceId, enrollment.objectId);
  return !(
    currentLineage &&
    !storage.db
      .prepare(
        `SELECT 1 FROM ${ORDINARY_ACTIVATION_BASES} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`,
      )
      .get(enrollment.workspaceId, enrollment.objectId, currentLineage.lineage_claim_id)
  );
}

function movedEnrollmentRebindState(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  targetPath: string,
): "ok" | "retryable" | "refused" {
  if (
    targetPath === enrollment.path ||
    liveDocumentKindForPath(targetPath) !== "richdoc" ||
    enrollment.note.state !== "off"
  )
    return "refused";
  if (
    storage.objectIdAtPathInVersion({
      workspaceId: enrollment.workspaceId,
      versionId: "main",
      path: targetPath,
    }) !== enrollment.objectId
  )
    return "refused";
  if (read(storage, enrollment.workspaceId, targetPath) !== null) return "refused";
  if (!canRebindPreMutation(storage, enrollment, targetPath)) return "refused";
  if (
    enrollment.hostDrainedAtMs === null ||
    storage.db
      .prepare(
        `SELECT 1 FROM ${SERVICE_ACTIVATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND retired_at_ms IS NULL
         UNION ALL SELECT 1 FROM ${LIVE_ROOM_EDITS} WHERE workspace_id=? AND main_version_id='main' AND object_id=?
         UNION ALL SELECT 1 FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND main_version_id='main' AND object_id=? LIMIT 1`,
      )
      .get(
        enrollment.workspaceId,
        enrollment.objectId,
        enrollment.workspaceId,
        enrollment.objectId,
        enrollment.workspaceId,
        enrollment.objectId,
      ) !== undefined
  )
    return "retryable";
  return "ok";
}

export function canResumeMovedServiceHostEnrollment(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  targetPath: string,
): boolean {
  storage.captureStanding();
  let normalized: string;
  try {
    normalized = canonicalPath(targetPath);
  } catch {
    return false;
  }
  return movedEnrollmentRebindState(storage, enrollment, normalized) === "ok";
}

function rebindMovedEnrollmentInTransaction(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  targetPath: string,
): ServiceHostEnrollment {
  const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value));
  const targetBytes = jsonBytes(targetPath);
  const enrollmentDelta = targetBytes - jsonBytes(enrollment.path);
  const liveDoc = storage.db
    .prepare(
      "SELECT lineage_claim_id,current_path FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current'",
    )
    .get(enrollment.workspaceId, enrollment.objectId);
  const docDelta = liveDoc ? targetBytes - jsonBytes(String(liveDoc.current_path)) : 0;
  const basis = liveDoc
    ? storage.db
        .prepare(
          `SELECT current_path FROM ${ORDINARY_ACTIVATION_BASES} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`,
        )
        .get(enrollment.workspaceId, enrollment.objectId, liveDoc.lineage_claim_id)
    : undefined;
  const basisDelta = basis ? targetBytes - jsonBytes(String(basis.current_path)) : 0;
  const delta = enrollmentDelta + docDelta + basisDelta;
  if (delta > 0) assertWorkspaceQuota(storage, enrollment.workspaceId, delta);
  storage.db
    .prepare(
      `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET path=?,accounted_bytes=accounted_bytes+? WHERE workspace_id=? AND object_id=?`,
    )
    .run(targetPath, enrollmentDelta, enrollment.workspaceId, enrollment.objectId);
  if (liveDoc) {
    storage.db
      .prepare(
        "UPDATE sync_relay_live_documents SET current_path=? WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?",
      )
      .run(targetPath, enrollment.workspaceId, enrollment.objectId, liveDoc.lineage_claim_id);
  }
  if (liveDoc && basis) {
    storage.db
      .prepare(
        `UPDATE ${ORDINARY_ACTIVATION_BASES} SET current_path=?,accounted_bytes=accounted_bytes+? WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=?`,
      )
      .run(
        targetPath,
        basisDelta,
        enrollment.workspaceId,
        enrollment.objectId,
        liveDoc.lineage_claim_id,
      );
  }
  if (delta !== 0) {
    storage.db
      .prepare(
        "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?",
      )
      .run(delta, enrollment.workspaceId);
  }
  return readByObject(storage, enrollment.workspaceId, enrollment.objectId)!;
}
/** Whether a share covers the enrollment or its owner asked for it. Neither counts against the agent-only caps. */
function agentOnly(
  storage: StorageContext,
  enrollment: Pick<
    ServiceHostEnrollment,
    "workspaceId" | "ownerUserId" | "path" | "shareId" | "ownerDemand"
  >,
): boolean {
  return !enrollment.ownerDemand && !coveredByEditGrant(storage, enrollment);
}
/**
 * Room for one more unretired enrollment in the workspace. Every intent fits
 * within the host's 64 documents in 16 workspaces. A document that would be
 * agent-only, as a personal open leaves one, must also fit within the
 * agent-only caps. Without room, the open reclaims, in its own transaction,
 * the least recently used document idle past the minimum hold that makes
 * room: a personal open only an agent-only one, any other intent an
 * agent-only one first. It reclaims none while the host is still letting go
 * of `RECLAIM_MAX_DEPARTING` retired documents. `full` is the intent's
 * answer when none does.
 * Member opens also fit their workspace cap for MEMBER_OPEN_DEMAND_MS.
 * A member-held open needs only the member cap: its enrollment already occupies room.
 */
function assertCapacity(
  storage: StorageContext,
  workspaceId: string,
  full: () => Error,
  nowMs: number,
  enrolling?: Parameters<typeof agentOnly>[1] | "member" | "member-held",
): void {
  const all = storage.db
    .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 LIMIT ?`)
    .all(SERVICE_HOST_MAX_DOCUMENTS + 1);
  const personal = typeof enrolling === "object" ? enrolling : undefined;
  if (enrolling === "member" || enrolling === "member-held") {
    const opened = all
      .map(row)
      .filter(
        (enrollment) =>
          enrollment.workspaceId === workspaceId &&
          memberOpened(storage, enrollment) &&
          recentMemberDemand(enrollment.demandAtMs, nowMs),
      ).length;
    if (opened >= MEMBER_OPEN_MAX_DOCUMENTS) throw full();
    if (enrolling === "member-held") return;
  }
  const capped = personal !== undefined && agentOnly(storage, personal);
  if (
    !capped &&
    all.length < SERVICE_HOST_MAX_DOCUMENTS &&
    (all.some((row) => row.workspace_id === workspaceId) ||
      new Set(all.map((row) => row.workspace_id)).size < SERVICE_HOST_MAX_WORKSPACES)
  )
    return;
  const rows = all.map(row),
    known = new Map<ServiceHostEnrollment, boolean>();
  // Coverage is read once for each row.
  const only = (enrollment: ServiceHostEnrollment) => {
    let value = known.get(enrollment);
    if (value === undefined) known.set(enrollment, (value = agentOnly(storage, enrollment)));
    return value;
  };
  const fits = (kept: readonly ServiceHostEnrollment[]) => {
    const workspaces = new Set(kept.map((enrollment) => enrollment.workspaceId));
    if (
      kept.length >= SERVICE_HOST_MAX_DOCUMENTS ||
      (!workspaces.has(workspaceId) && workspaces.size >= SERVICE_HOST_MAX_WORKSPACES)
    )
      return false;
    if (!capped) return true;
    const byWorkspace = new Map<string, boolean>();
    let documents = 0;
    for (const enrollment of kept) {
      if (only(enrollment)) documents++;
      byWorkspace.set(
        enrollment.workspaceId,
        (byWorkspace.get(enrollment.workspaceId) ?? true) && only(enrollment),
      );
    }
    // A workspace with other kinds of rows stays mixed; an empty one becomes agent-only.
    return (
      documents < AGENT_ONLY_MAX_DOCUMENTS &&
      (byWorkspace.has(workspaceId) ||
        [...byWorkspace.values()].filter(Boolean).length < AGENT_ONLY_MAX_WORKSPACES)
    );
  };
  if (fits(rows)) return;
  if (departingAtLimit(storage)) throw full();
  const idleBefore = nowMs - RECLAIM_MIN_HOLD_MS;
  const candidates = rows
    .flatMap((enrollment) => {
      if (personal !== undefined && !only(enrollment)) return [];
      const since = idleSince(storage, enrollment, idleBefore);
      return since === null ? [] : [{ enrollment, since, agentOnly: only(enrollment) }];
    })
    .sort((a, b) => Number(b.agentOnly) - Number(a.agentOnly) || a.since - b.since);
  const freeing = candidates.find((candidate) =>
    fits(rows.filter((enrollment) => enrollment !== candidate.enrollment)),
  );
  if (!freeing) throw full();
  reclaim(storage, freeing.enrollment, nowMs);
}
/** Whether the host is still letting go of as many retired documents as reclaim may add to. */
const departingAtLimit = (storage: StorageContext) =>
  Number(
    storage.db
      .prepare(
        `SELECT count(*) AS count FROM (SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=1 AND host_drained_at_ms IS NULL LIMIT ?)`,
      )
      .get(RECLAIM_MAX_DEPARTING)!.count,
  ) >= RECLAIM_MAX_DEPARTING;
/** When the document's last admitted update in its current lineage arrived, read through the document index, or 0 with none. */
function lastAdmittedAtMs(
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
): number {
  const value = storage.db
    .prepare(`SELECT received_at_ms FROM ${LIVE_JOURNAL_TABLE} WHERE workspace_id=? AND main_version_id='main' AND object_id=?
    AND lineage_claim_id=(SELECT lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current')
    ORDER BY journal_cursor DESC LIMIT 1`)
    .get(document.workspaceId, document.objectId, document.workspaceId, document.objectId);
  return value ? timestamp(value.received_at_ms) : 0;
}
/**
 * Whether the host is still activating the document's current lineage: its
 * activation has not completed, and no retirement began. A refused note has
 * no activation, so this never keeps one.
 */
const activationPending = (
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
) =>
  storage.db
    .prepare(`SELECT 1 FROM ${SERVICE_ACTIVATIONS} a JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
    WHERE a.workspace_id=? AND a.main_version_id='main' AND a.object_id=? AND d.lineage_state='current'
      AND a.completion_json IS NULL AND a.retire_requested_at_ms IS NULL AND a.retired_at_ms IS NULL`)
    .get(document.workspaceId, document.objectId) !== undefined;
/**
 * When the document was last used, if only its recorded demand keeps it and
 * that use is before `idleBefore`: the later of its demand and its last
 * admitted update. Null while anything else keeps it: an Edit grant, a Pause
 * or Stop, a live connection open in this relay process, or an activation or
 * retirement that is still open.
 */
function idleSince(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  idleBefore: number,
): number | null {
  const { demandAtMs } = enrollment;
  if (
    enrollment.retired ||
    enrollment.ownerStop !== null ||
    enrollment.note.state === "starting" ||
    demandAtMs === null ||
    demandAtMs >= idleBefore ||
    liveEditors(storage).connected(enrollment)
  )
    return null;
  const since = Math.max(demandAtMs, lastAdmittedAtMs(storage, enrollment));
  return since < idleBefore &&
    !coveredByEditGrant(storage, enrollment) &&
    !serviceActivationRetirementOpen(storage, enrollment) &&
    !activationPending(storage, enrollment)
    ? since
    : null;
}
/**
 * Inside the caller's transaction, ends an idle document's run, opens its
 * activation's retirement, retires it at once without a Stop and clears its
 * demand. Its slot is free at commit. The host drains it, and the next open
 * of any intent enrolls it again.
 */
function reclaim(storage: StorageContext, enrollment: ServiceHostEnrollment, nowMs: number): void {
  endServiceHostRun(storage, enrollment, nowMs);
  openServiceActivationRetirement(storage, enrollment, nowMs);
  storage.db
    .prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=1,owner_demand=0,demand_at_ms=NULL,updated_at_ms=max(updated_at_ms,?),${ACCESS_ENDED}
    WHERE workspace_id=? AND object_id=?`)
    .run(nowMs, nowMs, enrollment.workspaceId, enrollment.objectId);
  // As after Stop, the retirement it opened keeps the host's upload proof until it completes.
  forgetIdleServiceHostUploads(storage, enrollment.workspaceId);
}
/**
 * Reclaims every document that only recorded demand keeps and that went
 * unused for the retention period. Reads at most the host's capacity of
 * rows, and writes nothing when none is idle. Each reclaim reads its row
 * again in its own transaction, so an open that commits first keeps it, and
 * stops once the host is letting go of `RECLAIM_MAX_DEPARTING` retired
 * documents. Returns the documents it reclaimed.
 */
export function reclaimIdleLiveDocuments(
  storage: StorageContext,
  nowMs: number,
): readonly ServiceHostEnrollment[] {
  const now = timestamp(nowMs),
    idleBefore = now - RECLAIM_RETENTION_MS,
    standing = storage.captureStanding();
  const idle = storage.db
    .prepare(
      `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 AND owner_stop IS NULL AND demand_at_ms<? LIMIT ?`,
    )
    .all(idleBefore, SERVICE_HOST_MAX_DOCUMENTS)
    .map(row)
    .filter((enrollment) => idleSince(storage, enrollment, idleBefore) !== null);
  return idle.flatMap((enrollment) =>
    storage.tx(() => {
      standing();
      const value = storage.db
        .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
        .get(enrollment.workspaceId, enrollment.objectId);
      const current = value ? row(value) : null;
      if (!current || idleSince(storage, current, idleBefore) === null || departingAtLimit(storage))
        return [];
      reclaim(storage, current, now);
      return [read(storage, current.workspaceId, current.path)!];
    }),
  );
}

/** Checks automatic enrollment without changing retained documents or consuming capacity. */
export function checkServiceHostDocuments(
  storage: StorageContext,
  input: { workspaceId: string; ownerUserId: string; shareId: string; paths: readonly string[] },
): void {
  storage.readTx(() => {
    const identity = ownedIdentity(storage, input.workspaceId, input.ownerUserId);
    let added = 0,
      bytes = 0;
    const objects = new Set<string>();
    for (const path of input.paths) {
      const current = read(storage, input.workspaceId, path);
      if (current && !reclaimable(current)) continue;
      assertShareCovers(storage, { ...input, path });
      const objectId = currentMainDocument(storage, { workspaceId: input.workspaceId, path });
      if (current) {
        assertCurrent(storage, current, input.ownerUserId);
        if (current.objectId !== objectId)
          throw relayError("conflict", "Service host enrollment path belongs to another document.");
        added++;
        continue;
      }
      if (
        objects.has(objectId) ||
        storage.db
          .prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
          .get(input.workspaceId, objectId)
      ) {
        throw relayError(
          "conflict",
          "Service host enrollment document moved from its retained path.",
        );
      }
      objects.add(objectId);
      added++;
      bytes +=
        Buffer.byteLength(
          JSON.stringify([
            input.workspaceId,
            objectId,
            path,
            input.ownerUserId,
            input.shareId,
            identity.replicationEpoch,
            identity.streamIdentity,
          ]),
        ) + 64;
    }
    if (!added) return;
    const all = storage.db
      .prepare(`SELECT workspace_id FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 LIMIT ?`)
      .all(SERVICE_HOST_MAX_DOCUMENTS + 1);
    if (
      all.length + added > SERVICE_HOST_MAX_DOCUMENTS ||
      (!all.some((row) => row.workspace_id === input.workspaceId) &&
        new Set(all.map((row) => row.workspace_id)).size >= SERVICE_HOST_MAX_WORKSPACES)
    ) {
      throw relayError(
        "quota_exceeded",
        "The server has no room for more live documents. Stop live editing for unused documents, then try again.",
      );
    }
    assertWorkspaceQuota(storage, input.workspaceId, bytes);
  });
}
/** The only way into hosting. See `ensureOwnedLiveDocuments`. */
export function ensureOwnedLiveDocument(
  storage: StorageContext,
  input: EnsureOwnedLiveDocumentInput,
): ServiceHostEnrollment {
  return ensureOwnedLiveDocuments(storage, [input])[0]!;
}
/**
 * Asks for hosting of each document, in one transaction: a folder selection
 * either enrolls completely or leaves every prior row unchanged. Each input
 * resolves its document, authorizes its intent, acts on its row as the
 * intent's column of the row-state table says, records demand, then applies
 * capacity and quota on insert and re-enroll.
 */
export function ensureOwnedLiveDocuments(
  storage: StorageContext,
  inputs: readonly EnsureOwnedLiveDocumentInput[],
): readonly ServiceHostEnrollment[] {
  if (inputs.length > SERVICE_HOST_MAX_DOCUMENTS)
    throw badRequest("This server supports up to 64 live documents.");
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return inputs.map((input) => ensureInsideTransaction(storage, input));
  });
}
/** The owner the intent acts for, once its caller may ask for hosting in the workspace. */
function authorizeIntent(
  storage: StorageContext,
  input: EnsureOwnedLiveDocumentInput,
  workspaceId: string,
  path: string,
  nowMs: number,
): string {
  if (input.intent === "member-open")
    return authorizeMemberOpen(storage, input.userId, workspaceId, path);
  if (input.intent !== "personal-open")
    return parseLiveUpdateIdentifier(input.ownerUserId, "owner ID");
  // The agent's token, connection, epoch and fence as this transaction finds them, then its reach at Edit.
  const connection = readPersonalAuthority(
    storage,
    input.personal.check,
    input.personal.fenceEpoch,
    nowMs,
  );
  if (!connection || connection.connectionId !== input.personal.connectionId) throw notFound();
  const reach = ownedPersonalReachIn(storage, connection, workspaceId);
  if (!reach) throw relayError("personal_agent_out_of_reach");
  if (reach.level !== "edit") throw relayError("personal_agent_edit_needed");
  return connection.ownerUserId;
}
/** The member's current grant on the workspace share, at Edit, reaching the path. Any other answer reveals nothing. */
function authorizeMemberOpen(
  storage: StorageContext,
  userId: string,
  workspaceId: string,
  path: string,
): string {
  const grantId = workspaceMemberGrantId(storage, workspaceId, userId);
  const current =
    grantId === null
      ? null
      : authorizeShareGrantAction({
          storage,
          grantId,
          principal: { kind: "user", userId },
          action: "live-edit",
        });
  if (
    !current?.ok ||
    current.share.workspaceId !== workspaceId ||
    !memberEditsPath(current.effectiveSelector, path)
  )
    throw notFound();
  return current.share.granterUserId;
}
/** Whether a member's workspace reach edits the path. */
function memberEditsPath(selector: AnyShareSelector, path: string): boolean {
  return isWorkspaceSelector(selector) && pathLevel(workspaceFileReach(selector), path) === "edit";
}
function ensureInsideTransaction(
  storage: StorageContext,
  input: EnsureOwnedLiveDocumentInput,
): ServiceHostEnrollment {
  const workspaceId = parseWorkspaceId(input.workspaceId),
    path = canonicalPath(input.path),
    nowMs = timestamp(input.nowMs);
  input.guard();
  // Resolve and authorize: the caller's owner owns the workspace at its current identity, and the path holds a current rich document.
  const ownerUserId = authorizeIntent(storage, input, workspaceId, path, nowMs);
  const identity = ownedIdentity(storage, workspaceId, ownerUserId);
  const membersShareId = getWorkspaceMembership(storage, workspaceId)?.shareId ?? null;
  const shareId =
    input.intent === "share"
      ? parseLiveUpdateIdentifier(input.shareId, "share ID")
      : input.intent === "member-open"
        ? membersShareId
        : null;
  if (input.intent === "share")
    assertShareCovers(storage, { workspaceId, path, shareId: shareId!, ownerUserId });
  const owner = input.intent === "owner-open" || input.intent === "owner-resume";
  // An open hears its answers. A share or Resume is an owner's request that failed.
  const opening =
    input.intent === "personal-open" ||
    input.intent === "member-open" ||
    input.intent === "owner-open";
  const full = () =>
    opening
      ? new LiveHostingRefusal("live_host_full")
      : relayError("quota_exceeded", CAPACITY_FULL);
  const held = input.intent === "owner-resume" ? input.held : undefined;
  let effectivePath = path;
  let current = read(storage, workspaceId, path);
  const moved = (objectId: string | undefined) =>
    objectId !== undefined &&
    storage.db
      .prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
      .get(workspaceId, objectId) !== undefined;
  if (input.intent === "owner-resume") {
    let rebindCandidate: { enrollment: ServiceHostEnrollment; targetPath: string } | null = null;
    if (current) {
      const objectAtPath = storage.objectIdAtPathInVersion({
        workspaceId,
        versionId: "main",
        path,
      });
      if (objectAtPath !== current.objectId) {
        if (objectAtPath)
          throw relayError("conflict", "Service host enrollment path belongs to another document.");
        const at = storage.objectMoment({
          workspaceId,
          objectId: current.objectId,
          versionId: "main",
        })?.path;
        if (at && at !== current.path) {
          rebindCandidate = { enrollment: current, targetPath: at };
        }
      }
    } else {
      const objectAtPath = storage.objectIdAtPathInVersion({
        workspaceId,
        versionId: "main",
        path,
      });
      const existing = objectAtPath ? readByObject(storage, workspaceId, objectAtPath) : null;
      if (!existing) throw notFound();
      rebindCandidate = { enrollment: existing, targetPath: path };
    }
    if (rebindCandidate) {
      if (isMutationFenced(storage, workspaceId, rebindCandidate.enrollment.objectId))
        throw relayError("conflict", "This document is being changed. Try again.");
      assertCurrent(storage, rebindCandidate.enrollment, ownerUserId);
      const rebind = movedEnrollmentRebindState(
        storage,
        rebindCandidate.enrollment,
        rebindCandidate.targetPath,
      );
      if (rebind === "retryable") throw relayError("conflict", RETRY_MOVED);
      if (rebind !== "ok") throw relayError("conflict", MOVED);
      if (
        currentMainDocument(storage, { workspaceId, path: rebindCandidate.targetPath }) !==
        rebindCandidate.enrollment.objectId
      )
        throw relayError("conflict", MOVED);
      current = rebindMovedEnrollmentInTransaction(
        storage,
        rebindCandidate.enrollment,
        rebindCandidate.targetPath,
      );
      effectivePath = rebindCandidate.targetPath;
    }
  }
  const objectId = currentMainDocument(storage, { workspaceId, path: effectivePath }, opening);
  if (isMutationFenced(storage, workspaceId, objectId))
    throw opening
      ? new LiveHostingRefusal("document-unavailable")
      : relayError("conflict", "This document is being changed. Try again.");
  if (current) {
    assertCurrent(storage, current, ownerUserId);
    if (current.objectId !== objectId)
      throw relayError("conflict", "Service host enrollment path belongs to another document.");
    // Only Resume clears the owner's Pause or Stop. A share leaves it, and an open hears it.
    if (current.ownerStop !== null && input.intent !== "owner-resume") {
      if (input.intent === "share") {
        input.changed?.(false);
        return current;
      }
      throw new LiveHostingRefusal(
        input.intent === "owner-open" ? "paused" : "live_paused_by_owner",
      );
    }
    if (
      current.note.reason === "start-failed" &&
      input.intent !== "owner-resume" &&
      !(input.intent === "owner-open" && current.note.cause === "no-lineage")
    ) {
      input.changed?.(false);
      return current;
    }
    const enabling = current.note.state === "off";
    // A member's open takes the document as a new one does, unless another open's demand or a path share keeps it.
    // Then it leaves the row as it is.
    const memberTakes =
      input.intent === "member-open" &&
      (current.retired ||
        memberOpened(storage, current) ||
        (current.demandAtMs === null && !coveredByEditGrant(storage, current, false)));
    if (current.retired)
      assertCapacity(
        storage,
        workspaceId,
        full,
        nowMs,
        input.intent === "personal-open" ? current : memberTakes ? "member" : undefined,
      );
    else if (
      memberTakes &&
      !(memberOpened(storage, current) && recentMemberDemand(current.demandAtMs, nowMs))
    ) {
      assertCapacity(storage, workspaceId, full, nowMs, "member-held");
    }
    if (held) retireHeldActivation(storage, current, identity, held, nowMs);
    if (enabling) start(storage, current, nowMs, input);
    if (memberTakes) {
      storage.db
        .prepare(
          `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET share_id=?,owner_demand=0 WHERE workspace_id=? AND object_id=?`,
        )
        .run(membersShareId, workspaceId, objectId);
    }
    if (input.intent === "member-open" ? memberTakes : input.intent !== "share")
      recordDemand(
        storage,
        { workspaceId, objectId },
        nowMs,
        owner,
        !memberTakes && memberOpened(storage, current),
      );
    input.changed?.(enabling);
    return read(storage, workspaceId, effectivePath)!;
  }
  // A document retained at its old path is never rebound here. An owner's open hears that as an answer.
  if (moved(objectId))
    throw input.intent === "owner-open"
      ? new LiveHostingRefusal("document-unavailable")
      : relayError("conflict", MOVED);
  assertCapacity(
    storage,
    workspaceId,
    full,
    nowMs,
    input.intent === "personal-open"
      ? { workspaceId, ownerUserId, path, shareId, ownerDemand: false }
      : input.intent === "member-open"
        ? "member"
        : undefined,
  );
  const charge =
    Buffer.byteLength(
      JSON.stringify([
        workspaceId,
        objectId,
        path,
        ownerUserId,
        shareId,
        identity.replicationEpoch,
        identity.streamIdentity,
      ]),
    ) + 64;
  assertWorkspaceQuota(storage, workspaceId, charge);
  storage.db
    .prepare(
      `INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,retired,created_at_ms,updated_at_ms,owner_demand,demand_at_ms,accounted_bytes,
        generation,state,reason,since_ms,changed_by) VALUES (?,?,?,?,?,?,?,0,1,?,?,?,?,?,0,'off','never',?,'server')`,
    )
    .run(
      workspaceId,
      objectId,
      path,
      ownerUserId,
      shareId,
      identity.replicationEpoch,
      identity.streamIdentity,
      nowMs,
      nowMs,
      // The owner's demand keeps the document out of the agent-only caps, as it does for a retained row.
      Number(owner),
      input.intent === "share" ? null : nowMs,
      charge,
      nowMs,
    );
  storage.db
    .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?")
    .run(charge, workspaceId);
  start(storage, read(storage, workspaceId, path)!, nowMs, input);
  input.changed?.(true);
  return read(storage, workspaceId, path)!;
}
/** Starts the off note for the intent's caller: an agent's open names its connection, a member's open the member, every other intent the owner. */
function start(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  nowMs: number,
  input: EnsureOwnedLiveDocumentInput,
): void {
  const by: LiveNoteActor =
    input.intent === "personal-open"
      ? `agent:${input.personal.connectionId}`
      : input.intent === "member-open"
        ? `person:${input.userId}`
        : `person:${enrollment.ownerUserId}`;
  const { workspaceId, objectId } = enrollment;
  const started = moveLiveNoteInTransaction(storage, {
    workspaceId,
    objectId,
    generation: enrollment.note.generation,
    nowMs,
    move: "start",
    by,
  });
  if (!started.moved) throw new Error("Service host enrollment is damaged.");
  if (
    storage.db
      .prepare(
        `SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} e WHERE e.workspace_id=? AND e.object_id=? AND ${ACTIVATED}`,
      )
      .get(workspaceId, objectId)
  )
    moveLiveNoteInTransaction(storage, {
      workspaceId,
      objectId,
      generation: started.record.generation,
      nowMs,
      move: "started",
    });
}
/**
 * Records hosting demand. An owner's also takes the document out of the
 * agent-only caps. With `leavesMembers`, the demand takes a member-opened
 * document out of the member rules: it no longer names a members share,
 * the current membership's or an ended one's.
 */
function recordDemand(
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
  nowMs: number,
  owner: boolean,
  leavesMembers: boolean,
): void {
  storage.db
    .prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET demand_at_ms=max(COALESCE(demand_at_ms,0),?),owner_demand=max(owner_demand,?),
    share_id=CASE WHEN ? THEN NULL ELSE share_id END WHERE workspace_id=? AND object_id=?`)
    .run(nowMs, Number(owner), Number(leavesMembers), document.workspaceId, document.objectId);
}
/**
 * Renews the demand of a document a personal session kept open, when that
 * session closes. A document its owner paused, stopped or that retired keeps
 * its state. Returns whether it renewed.
 */
export function renewPersonalSessionDemand(
  storage: StorageContext,
  input: { workspaceId: string; objectId: string; nowMs: number },
): boolean {
  const workspaceId = parseWorkspaceId(input.workspaceId),
    objectId = parseLiveUpdateIdentifier(input.objectId, "object ID"),
    nowMs = timestamp(input.nowMs);
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return (
      storage.db
        .prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET demand_at_ms=max(COALESCE(demand_at_ms,0),?)
      WHERE workspace_id=? AND object_id=? AND retired=0 AND owner_stop IS NULL`)
        .run(nowMs, workspaceId, objectId).changes === 1
    );
  });
}
export const HELD_CHANGED = "This document changed while live editing was resuming. Try again.";
/**
 * A Resume of a document the host holds for an unadmitted live edit retires
 * the held activation before enabling it, as Stop does: its live session
 * cannot continue, so a successor must replace it.
 */
function retireHeldActivation(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  identity: { replicationEpoch: string; streamIdentity: string },
  held: ServiceHostHeldActivation,
  nowMs: number,
): void {
  held.assertHeld();
  // Any prepared activation: a held successor that never completed still retires.
  const activation = storage.db
    .prepare(`SELECT a.activation_id,json_extract(a.binding_json,'$.currentPath') AS path
    FROM ${SERVICE_ACTIVATIONS} a JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
    WHERE a.workspace_id=? AND a.main_version_id='main' AND a.object_id=? AND a.retired_at_ms IS NULL AND d.lineage_state='current'`)
    .get(enrollment.workspaceId, enrollment.objectId);
  if (
    identity.replicationEpoch !== held.replicationEpoch ||
    identity.streamIdentity !== held.streamIdentity ||
    activation?.activation_id !== held.activationId ||
    activation.path !== enrollment.path
  ) {
    throw relayError("conflict", HELD_CHANGED);
  }
  openServiceActivationRetirement(storage, enrollment, nowMs);
}
export function listServiceHostEnrollments(
  storage: StorageContext,
  workspaceId?: string,
): readonly ServiceHostEnrollment[] {
  return storage.readLiveAuthority(() => {
    const values =
      workspaceId === undefined
        ? storage.db
            .prepare(
              `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE retired=0 ORDER BY workspace_id,path LIMIT ?`,
            )
            .all(SERVICE_HOST_MAX_DOCUMENTS + 1)
        : storage.db
            .prepare(
              `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND retired=0 ORDER BY path LIMIT ?`,
            )
            .all(parseWorkspaceId(workspaceId), SERVICE_HOST_MAX_DOCUMENTS + 1);
    if (
      values.length > SERVICE_HOST_MAX_DOCUMENTS ||
      new Set(values.map((value) => value.workspace_id)).size > SERVICE_HOST_MAX_WORKSPACES
    )
      throw new Error("Service host enrollment capacity is damaged.");
    return values.map(row);
  });
}
export interface ServiceHostEnrollmentCursor {
  readonly workspaceId: string;
  readonly path: string;
}
/**
 * The enrollments the service host has not drained: its documents, and the
 * ones it must still remove from its replicas before their release. Every
 * active row comes first, then a page of the retired rows after `after`,
 * which Stop leaves here.
 */
export function listUndrainedServiceHostEnrollments(
  storage: StorageContext,
  after?: ServiceHostEnrollmentCursor,
): {
  documents: readonly ServiceHostEnrollment[];
  nextCursor: ServiceHostEnrollmentCursor | null;
} {
  const workspaceId = after === undefined ? "" : parseWorkspaceId(after.workspaceId),
    path = after === undefined ? "" : canonicalPath(after.path);
  return storage.readLiveAuthority(() => {
    // Capacity bounds the active rows.
    const active = storage.db
      .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE host_drained_at_ms IS NULL AND retired=0
      ORDER BY workspace_id,path LIMIT ?`)
      .all(SERVICE_HOST_MAX_DOCUMENTS)
      .map(row);
    const retired = storage.db
      .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE host_drained_at_ms IS NULL AND retired=1
      AND (workspace_id,path)>(?,?) ORDER BY workspace_id,path LIMIT ?`)
      .all(workspaceId, path, SERVICE_HOST_MAX_DOCUMENTS + 1);
    // The host opens an engine handle for each workspace named. The page names
    // no more workspaces than capacity allows active ones, so together they
    // stay within the engine's 64 handles. Rows come by workspace, so the page is a prefix.
    const named = new Set(
      [...new Set(retired.map((value) => value.workspace_id))].slice(
        0,
        SERVICE_HOST_MAX_WORKSPACES,
      ),
    );
    const page = retired
        .slice(0, SERVICE_HOST_MAX_DOCUMENTS)
        .filter((value) => named.has(value.workspace_id))
        .map(row),
      last = page.at(-1);
    return {
      documents: [...active, ...page],
      nextCursor:
        retired.length > page.length && last
          ? { workspaceId: last.workspaceId, path: last.path }
          : null,
    };
  });
}
export function listRetiredServiceHostEnrollments(
  storage: StorageContext,
  workspaceId: string,
  after?: string,
): {
  documents: readonly ServiceHostEnrollment[];
  nextCursor: string | null;
} {
  const workspace = parseWorkspaceId(workspaceId),
    cursor = after === undefined ? "" : canonicalPath(after);
  storage.captureStanding();
  // A document whose latest moment on main deleted it has nothing to resume. A move or a
  // restore records a later moment with a path, so its row stays or comes back.
  const values = storage.db
    .prepare(`SELECT e.* FROM ${SERVICE_HOST_ENROLLMENTS} e INDEXED BY ${RETIRED_INDEX}
    WHERE e.workspace_id=? AND e.retired=1 AND e.path>? AND NOT COALESCE((SELECT m.path IS NULL
      FROM sync_relay_object_moments m WHERE m.workspace_id=e.workspace_id AND m.version_id='main'
        AND m.object_id=e.object_id ORDER BY m.relay_seq DESC LIMIT 1),0)
    ORDER BY e.path LIMIT ?`)
    .all(workspace, cursor, SERVICE_HOST_MAX_DOCUMENTS + 1);
  const documents = values.slice(0, SERVICE_HOST_MAX_DOCUMENTS).map(row);
  return {
    documents,
    nextCursor: values.length > SERVICE_HOST_MAX_DOCUMENTS ? documents.at(-1)!.path : null,
  };
}
export interface ServiceHostWorkspace {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
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
export function currentServiceHostWorkspace(
  storage: StorageContext,
  workspaceId: string,
  includeUndrained = false,
): ServiceHostWorkspace | null {
  storage.captureStanding();
  const value = storage.db
    .prepare(
      `SELECT e.workspace_id,e.owner_user_id,e.replication_epoch,e.stream_identity ${includeUndrained ? CURRENT_UNDRAINED : CURRENT} LIMIT 1`,
    )
    .get(parseWorkspaceId(workspaceId));
  return value ? hostWorkspace(value) : null;
}
function hostWorkspace(value: Record<string, unknown>): ServiceHostWorkspace {
  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspace_id),
    ownerUserId: parseLiveUpdateIdentifier(value.owner_user_id, "owner_user_id"),
    replicationEpoch: parseLiveUpdateIdentifier(value.replication_epoch, "replication_epoch"),
    streamIdentity: parseLiveUpdateIdentifier(value.stream_identity, "stream_identity"),
  });
}
/** The current identity's enabled enrollments, in one SQL snapshot. */
export function currentServiceHostEnrollments(
  storage: StorageContext,
  workspaceId: string,
): readonly ServiceHostEnrollment[] {
  storage.captureStanding();
  const values = storage.db
    .prepare(`SELECT e.* ${CURRENT} ORDER BY e.path LIMIT ?`)
    .all(parseWorkspaceId(workspaceId), SERVICE_HOST_MAX_DOCUMENTS + 1);
  if (values.length > SERVICE_HOST_MAX_DOCUMENTS)
    throw new Error("Service host enrollment capacity is damaged.");
  return values.map(row);
}
export class ServiceHostRetirementConflict extends Error {
  constructor(readonly restoreFenceGeneration: number) {
    super("The document's restore generation changed.");
  }
}

const verifyPreparedRetirement =
  (prepared: ServiceHostRetirementPreparation | undefined) =>
  (activation: RetirableServiceActivation) => {
    if (!prepared) throw relayError("host-not-loaded");
    if (
      prepared.activationId !== activation.activationId ||
      prepared.lineageClaimId !== activation.lineageClaimId
    )
      throw relayError("conflict");
    if (prepared.restoreFenceGeneration !== activation.restoreFenceGeneration)
      throw new ServiceHostRetirementConflict(activation.restoreFenceGeneration);
    prepared.assertCurrent();
  };

export function setServiceHostEnrollmentEnabled(
  storage: StorageContext,
  input: SetServiceHostEnrollmentEnabledInput,
): ServiceHostEnrollment | null {
  const workspaceId = parseWorkspaceId(input.workspaceId),
    path = canonicalPath(input.path),
    nowMs = timestamp(input.nowMs);
  if (
    input.enabled !== false ||
    (input.retire !== undefined && typeof input.retire !== "boolean")
  ) {
    throw badRequest("Invalid service host enrollment state.");
  }
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    input.guard();
    const value =
      input.objectId === undefined
        ? undefined
        : storage.db
            .prepare(
              `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`,
            )
            .get(workspaceId, parseLiveUpdateIdentifier(input.objectId, "object ID"));
    const current =
      input.objectId === undefined ? read(storage, workspaceId, path) : value ? row(value) : null;
    if (
      !current ||
      current.ownerUserId !== input.ownerUserId ||
      !storage.workspaceIsOwnedBy(workspaceId, input.ownerUserId)
    )
      return null;
    let acceptedCursor: number | undefined;
    if (input.retire) {
      if (
        input.restoreFenceGeneration !== undefined &&
        (!Number.isSafeInteger(input.restoreFenceGeneration) || input.restoreFenceGeneration < 0)
      )
        throw badRequest("Invalid restore generation.");
      const document = storage.db
        .prepare(
          "SELECT restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND object_id=? AND main_version_id='main' AND lineage_state='current'",
        )
        .get(workspaceId, current.objectId);
      const generation = document?.restore_fence_generation ?? 0;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation))
        throw new Error("Invalid document restore generation.");
      if (input.restoreFenceGeneration !== undefined && generation !== input.restoreFenceGeneration)
        throw new ServiceHostRetirementConflict(generation);
      // The prepared activation's obligation keeps the fence of the first Stop.
      // A new one needs the host to have delivered its edits and blocked new ones.
      const retirement = openServiceActivationRetirement(
        storage,
        { workspaceId, objectId: current.objectId },
        nowMs,
        verifyPreparedRetirement(input.prepared),
      );
      const high = retirement
        ? { cursor: retirement.acceptedThrough }
        : storage.db
            .prepare(
              "SELECT MAX(journal_cursor) AS cursor FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_claim_id=(SELECT lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current')",
            )
            .get(workspaceId, current.objectId, workspaceId, current.objectId);
      acceptedCursor = timestamp(high?.cursor ?? 0);
    }
    const ownerStop = input.retire === true || current.ownerStop === "retire" ? "retire" : "pause";
    // Pause fences admission and retires the activation in this transaction, and keeps the enrollment until host unload.
    // Stop fences new acceptance here too. Resume leaves an unfinished retirement in place.
    if (ownerStop === "pause") openServiceActivationRetirement(storage, current, nowMs);
    const enabled = input.retire ? false : current.enabled;
    const retired = !enabled && (current.retired || ownerStop === "retire");
    const reason: LiveNoteOffReason = ownerStop === "retire" ? "stopped" : "paused";
    storage.db
      .prepare(
        `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop=?,enabled=?,retired=?,host_drained_at_ms=?,updated_at_ms=?,
          state='off',reason=?,cause=NULL,since_ms=CASE WHEN reason IS ? THEN since_ms ELSE max(since_ms,?) END,
          changed_by=CASE WHEN reason IS ? THEN changed_by ELSE ? END WHERE workspace_id=? AND object_id=?`,
      )
      .run(
        ownerStop,
        Number(enabled),
        Number(retired),
        current.hostDrainedAtMs,
        Math.max(nowMs, current.updatedAtMs),
        reason,
        reason,
        nowMs,
        reason,
        `person:${input.ownerUserId}`,
        workspaceId,
        current.objectId,
      );
    if (input.retire) endServiceHostRun(storage, current, nowMs);
    // Stop retires at once, so the release that clears upload proof never sees this row. The retirement it opened keeps that proof until it completes.
    forgetIdleServiceHostUploads(storage, workspaceId);
    return {
      ...read(storage, workspaceId, current.path)!,
      ...(acceptedCursor === undefined ? {} : { acceptedCursor }),
      ...(input.retire ? { changed: !current.retired } : {}),
    };
  });
}

export type RetireIdleServiceHostEnrollmentResult =
  | { readonly status: "active" }
  | { readonly status: "unsettled" }
  | { readonly status: "none"; readonly release: () => void }
  | {
      readonly status: "retired";
      readonly enrollment: ServiceHostEnrollment;
      readonly release: () => void;
    };

export type RebindRetiredServiceHostEnrollmentResult =
  | { readonly status: "none" | "blocked" }
  | { readonly status: "rebound"; readonly enrollment: ServiceHostEnrollment };

const mutationFences = new WeakMap<object, Map<string, number>>();
const mutationFenceKey = (workspaceId: string, objectId: string) => `${workspaceId}\0${objectId}`;

function acquireMutationFence(storage: object, workspaceId: string, objectId: string): () => void {
  let map = mutationFences.get(storage);
  if (!map) {
    map = new Map();
    mutationFences.set(storage, map);
  }
  const key = mutationFenceKey(workspaceId, objectId);
  map.set(key, (map.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = map.get(key) ?? 0;
    if (count <= 1) map.delete(key);
    else map.set(key, count - 1);
    if (map.size === 0) mutationFences.delete(storage);
  };
}

function isMutationFenced(storage: object, workspaceId: string, objectId: string): boolean {
  return (mutationFences.get(storage)?.get(mutationFenceKey(workspaceId, objectId)) ?? 0) > 0;
}

function ownedObjectTx<T>(
  storage: StorageContext,
  input: { workspaceId: string; objectId: string; ownerUserId: string; guard(): void },
  work: (workspaceId: string, objectId: string) => T,
): T {
  const workspaceId = parseWorkspaceId(input.workspaceId),
    objectId = parseLiveUpdateIdentifier(input.objectId, "object ID"),
    standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    input.guard();
    if (!storage.workspaceIsOwnedBy(workspaceId, input.ownerUserId)) throw notFound();
    return work(workspaceId, objectId);
  });
}

function hasPendingLiveState(db: SqliteDb, workspaceId: string, objectId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM ${LIVE_ROOM_EDITS} WHERE workspace_id=? AND main_version_id='main' AND object_id=?
         UNION ALL SELECT 1 FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND object_id=?
         UNION ALL SELECT 1 FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND object_id=? LIMIT 1`,
      )
      .get(workspaceId, objectId, workspaceId, objectId, workspaceId, objectId) !== undefined
  );
}

function clearDrainedDeletedInTx(
  storage: StorageContext,
  workspaceId: string,
  objectId: string,
): boolean {
  const value = storage.db
    .prepare(
      `SELECT accounted_bytes,retired,host_drained_at_ms FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`,
    )
    .get(workspaceId, objectId);
  if (
    !value ||
    value.retired !== 1 ||
    value.host_drained_at_ms === null ||
    isHostedForLiveEditing(storage, workspaceId, objectId) ||
    storage.objectMoment({ workspaceId, objectId, versionId: "main" })?.path != null ||
    hasPendingLiveState(storage.db, workspaceId, objectId)
  )
    return false;
  storage.db
    .prepare(`DELETE FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
    .run(workspaceId, objectId);
  storage.db
    .prepare(
      "UPDATE sync_relay_workspace_usage SET usage_bytes=max(0,usage_bytes-?) WHERE workspace_id=?",
    )
    .run(Number(value.accounted_bytes), workspaceId);
  return true;
}

export function retireIdleServiceHostEnrollment(
  storage: StorageContext,
  input: {
    workspaceId: string;
    objectId: string;
    toPath?: string;
    ownerUserId: string;
    prepared?: ServiceHostRetirementPreparation;
    drainNow?: boolean;
    nowMs: number;
    guard(): void;
  },
): RetireIdleServiceHostEnrollmentResult {
  const nowMs = timestamp(input.nowMs);
  const target = input.toPath === undefined ? null : canonicalPath(input.toPath);
  let release: (() => void) | undefined;
  try {
    return ownedObjectTx(storage, input, (workspaceId, objectId) => {
      if (liveEditors(storage).connected({ workspaceId, objectId })) return { status: "active" };
      if (hasPendingLiveState(storage.db, workspaceId, objectId)) return { status: "unsettled" };
      const current = readByObject(storage, workspaceId, objectId);
      if (current && hasServiceHostConflictEffect(storage, current)) return { status: "unsettled" };
      if (target !== null) {
        const occupant = read(storage, workspaceId, target);
        if (
          occupant &&
          occupant.objectId !== objectId &&
          !clearDrainedDeletedInTx(storage, workspaceId, occupant.objectId)
        )
          return { status: "unsettled" };
        if (current && current.path !== target && !canRebindPreMutation(storage, current, target))
          return { status: "unsettled" };
      }
      if (!current) {
        release = acquireMutationFence(storage, workspaceId, objectId);
        return { status: "none", release };
      }
      const hosted = isHostedForLiveEditing(storage, workspaceId, objectId);
      if (!current.retired) {
        openServiceActivationRetirement(
          storage,
          { workspaceId, objectId },
          nowMs,
          verifyPreparedRetirement(input.prepared),
        );
        endServiceHostRun(storage, current, nowMs);
        const drainedAt =
          input.drainNow && !hosted ? (current.hostDrainedAtMs ?? nowMs) : current.hostDrainedAtMs;
        storage.db
          .prepare(
            `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=1,owner_demand=0,demand_at_ms=NULL,host_drained_at_ms=?,updated_at_ms=max(updated_at_ms,?),${ACCESS_ENDED} WHERE workspace_id=? AND object_id=?`,
          )
          .run(drainedAt, nowMs, nowMs, workspaceId, objectId);
        forgetIdleServiceHostUploads(storage, workspaceId);
      } else if (input.drainNow && current.hostDrainedAtMs === null && !hosted) {
        storage.db
          .prepare(
            `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET host_drained_at_ms=?,updated_at_ms=max(updated_at_ms,?) WHERE workspace_id=? AND object_id=?`,
          )
          .run(nowMs, nowMs, workspaceId, objectId);
      }
      release = acquireMutationFence(storage, workspaceId, objectId);
      return {
        status: "retired",
        enrollment: readByObject(storage, workspaceId, objectId)!,
        release,
      };
    });
  } catch (error) {
    release?.();
    throw error;
  }
}

export function rebindRetiredServiceHostEnrollment(
  storage: StorageContext,
  input: {
    workspaceId: string;
    objectId: string;
    toPath: string;
    ownerUserId: string;
    guard(): void;
  },
): RebindRetiredServiceHostEnrollmentResult {
  const target = canonicalPath(input.toPath);
  return ownedObjectTx(storage, input, (workspaceId, objectId) => {
    const current = readByObject(storage, workspaceId, objectId);
    if (!current) return { status: "none" };
    if (current.path === target) return { status: "rebound", enrollment: current };
    const occupant = read(storage, workspaceId, target);
    if (
      occupant &&
      occupant.objectId !== objectId &&
      !clearDrainedDeletedInTx(storage, workspaceId, occupant.objectId)
    )
      return { status: "blocked" };
    if (movedEnrollmentRebindState(storage, current, target) !== "ok") return { status: "blocked" };
    return {
      status: "rebound",
      enrollment: rebindMovedEnrollmentInTransaction(storage, current, target),
    };
  });
}

export function clearDrainedDeletedServiceHostEnrollment(
  storage: StorageContext,
  input: { workspaceId: string; objectId: string; ownerUserId: string; guard(): void },
): boolean {
  return ownedObjectTx(storage, input, (workspaceId, objectId) =>
    clearDrainedDeletedInTx(storage, workspaceId, objectId),
  );
}

const EDIT_SHARE_COLUMNS = `s.share_id,s.workspace_id,s.granter_user_id,s.selector_json,s.created_at_ms`;
const ACTIVE_EDIT_GRANT = `EXISTS(SELECT 1 FROM sync_relay_share_grants g WHERE g.share_id=s.share_id AND g.status='active' AND (g.access='edit' OR json_extract(s.selector_json,'$.kind')='workspace'))`;
/**
 * Which paths an active Edit grant on the share covers. On a workspace share
 * that grant must be a current member's, at Edit on the path. Without
 * `members`, a workspace share covers nothing. Each grant is read at most
 * once, so many paths share one answer.
 */
export function enrolledPathCoverage(
  storage: StorageContext,
  value: Record<string, unknown>,
  members = true,
): (path: string) => boolean {
  const share: SyncRelayShareRow = {
    shareId: String(value.share_id),
    workspaceId: String(value.workspace_id),
    granterUserId: String(value.granter_user_id),
    selectorJson: String(value.selector_json),
    createdAtMs: Number(value.created_at_ms),
  };
  const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
  if (parsed && "kind" in parsed && parsed.kind === "workspace") {
    if (!members) return () => false;
    const grants = storage.db
      .prepare(`SELECT grant_id,principal_user_id FROM sync_relay_share_grants
      WHERE share_id=? AND status='active'`)
      .all(share.shareId)
      .map((grant) => {
        let selector: AnyShareSelector | null | undefined;
        return () => {
          if (selector !== undefined) return selector;
          if (typeof grant.principal_user_id !== "string") return (selector = null);
          const result = authorizeShareGrantAction({
            storage,
            grantId: String(grant.grant_id),
            principal: { kind: "user", userId: grant.principal_user_id },
            action: "live-edit",
          });
          return (selector = result.ok ? result.effectiveSelector : null);
        };
      });
    return (path) =>
      grants.some((grant) => {
        const selector = grant();
        return selector !== null && memberEditsPath(selector, path);
      });
  }
  const selector = parsed && effectiveShareSelector(parsed, "edit");
  if (!selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector))
    return () => false;
  let granted: boolean | undefined;
  return (path) =>
    visibleSharePath(selector, path) === path &&
    (granted ??= storage.db
      .prepare(
        `SELECT grant_id FROM sync_relay_share_grants WHERE share_id=? AND status='active' AND access='edit'`,
      )
      .all(share.shareId)
      .some(
        (grant) => readCurrentShareGrant(storage, { grantId: String(grant.grant_id) }) !== null,
      ));
}
function coveredByEditGrant(
  storage: StorageContext,
  enrollment: Pick<ServiceHostEnrollment, "workspaceId" | "ownerUserId" | "path"> & {
    shareId?: string | null;
  },
  members = true,
): boolean {
  // Admission runs this on every update. The share that enrolled the document almost always still covers it, so it is
  // checked first by key; the rest are read only when it doesn't, and the scan stops at the first that does.
  if (enrollment.shareId != null) {
    const own = storage.db
      .prepare(`SELECT ${EDIT_SHARE_COLUMNS} FROM sync_relay_shares s
      WHERE s.share_id=? AND s.workspace_id=? AND s.granter_user_id=? AND ${ACTIVE_EDIT_GRANT}`)
      .get(enrollment.shareId, enrollment.workspaceId, enrollment.ownerUserId);
    if (own && enrolledPathCoverage(storage, own, members)(enrollment.path)) return true;
  }
  const shares = storage.db
    .prepare(`SELECT ${EDIT_SHARE_COLUMNS} FROM sync_relay_shares s INDEXED BY ${CANDIDATE_INDEX}
    WHERE s.workspace_id=? AND s.granter_user_id=? AND ${ACTIVE_EDIT_GRANT}`)
    .iterate(enrollment.workspaceId, enrollment.ownerUserId);
  for (const value of shares)
    if (
      value.share_id !== enrollment.shareId &&
      enrolledPathCoverage(storage, value, members)(enrollment.path)
    )
      return true;
  return false;
}
/**
 * The enrolled documents an active Edit grant on the share covers. A change
 * that may end Edit grants reads them first, inside its transaction.
 */
export function serviceHostEnrollmentsCoveredByShare(
  storage: StorageContext,
  shareId: string,
): readonly ServiceHostEnrollment[] {
  const share = storage.db
    .prepare(
      `SELECT ${EDIT_SHARE_COLUMNS} FROM sync_relay_shares s WHERE s.share_id=? AND ${ACTIVE_EDIT_GRANT}`,
    )
    .get(shareId);
  if (!share) return [];
  const covers = enrolledPathCoverage(storage, share);
  // Capacity bounds the active rows.
  return storage.db
    .prepare(
      `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND owner_user_id=? AND retired=0`,
    )
    .all(String(share.workspace_id), String(share.granter_user_id))
    .map(row)
    .filter((enrollment) => covers(enrollment.path));
}
/**
 * Records, inside the change's transaction, the end of the run and the
 * retirement of each document's activation that no Edit grant on any of its
 * owner's shares covers now.
 */
export function retireUncoveredServiceActivations(
  storage: StorageContext,
  enrollments: readonly ServiceHostEnrollment[],
  nowMs: number,
): void {
  for (const enrollment of enrollments) {
    if (grantedOrDemanded(storage, enrollment, nowMs)) continue;
    endServiceHostRun(storage, enrollment, nowMs);
    openServiceActivationRetirement(storage, enrollment, nowMs);
  }
}
/** Ends the enrollment's run: its run token moves past every earlier one. */
export function endServiceHostRun(
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
  nowMs: number,
): void {
  storage.db
    .prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET created_at_ms=max(?,created_at_ms+1),updated_at_ms=max(updated_at_ms,?,created_at_ms+1)
    WHERE workspace_id=? AND object_id=?`)
    .run(timestamp(nowMs), timestamp(nowMs), document.workspaceId, document.objectId);
}
type CoveredEnrollment = Pick<
  ServiceHostEnrollment,
  "workspaceId" | "objectId" | "ownerUserId" | "shareId" | "path"
>;
/**
 * Whether a member's open brought the document in and its owner never asked
 * for it. It reads the share row, which outlives the membership row, so a
 * page stays member-opened after the membership ends.
 */
function memberOpened(
  storage: StorageContext,
  enrollment: Pick<ServiceHostEnrollment, "workspaceId" | "shareId" | "ownerDemand">,
): boolean {
  if (enrollment.ownerDemand || enrollment.shareId === null) return false;
  const share = storage.db
    .prepare(`SELECT selector_json FROM sync_relay_shares WHERE share_id=? AND workspace_id=?`)
    .get(enrollment.shareId, enrollment.workspaceId);
  const stored = share && parseStoredAnyShareSelectorJson(String(share.selector_json));
  return !!stored && "kind" in stored && stored.kind === "workspace";
}
const recentMemberDemand = (demandAtMs: number | null, nowMs: number) =>
  demandAtMs !== null && nowMs - demandAtMs < MEMBER_OPEN_DEMAND_MS;
/**
 * Whether an active Edit grant covers the enrollment as the caller knows it,
 * or an open or Resume asked for it. A member's open asks only for
 * MEMBER_OPEN_DEMAND_MS, and only while a current member's Edit grant
 * reaches the document; after that a workspace share covers it no longer.
 */
function grantedOrDemanded(
  storage: StorageContext,
  enrollment: CoveredEnrollment,
  nowMs: number,
): boolean {
  const value = storage.db
    .prepare(
      `SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=? AND owner_user_id=? AND path=?`,
    )
    .get(enrollment.workspaceId, enrollment.objectId, enrollment.ownerUserId, enrollment.path);
  return value
    ? heldFor(storage, enrollment, row(value), nowMs)
    : coveredByEditGrant(storage, enrollment);
}
/** `grantedOrDemanded` for the enrollment's stored row. */
function heldFor(
  storage: StorageContext,
  enrollment: CoveredEnrollment,
  stored: Pick<ServiceHostEnrollment, "workspaceId" | "shareId" | "ownerDemand" | "demandAtMs">,
  nowMs: number,
): boolean {
  if (!memberOpened(storage, stored))
    return stored.demandAtMs !== null || coveredByEditGrant(storage, enrollment);
  return coveredByEditGrant(storage, enrollment, recentMemberDemand(stored.demandAtMs, nowMs));
}
const covered = (storage: StorageContext, enrollment: CoveredEnrollment, nowMs: number) =>
  grantedOrDemanded(storage, enrollment, nowMs);
/**
 * Whether the host keeps the enrolled document: an active Edit grant on any
 * of the owner's shares still covers it, or an open or Resume asked for it.
 */
export function serviceHostEnrollmentCovered(
  storage: StorageContext,
  enrollment: CoveredEnrollment,
  nowMs = Date.now(),
): boolean {
  storage.captureStanding();
  return covered(storage, enrollment, nowMs);
}
/**
 * Ends the run of a live session once nothing covers the enrolled document,
 * and opens its activation's retirement. The host then retires the
 * activation before it lets the document go. Every other end of Edit access
 * opened a retirement already, and that one stands.
 * Returns whether it opened one.
 */
export function endLapsedServiceHostRun(
  storage: StorageContext,
  enrollment: ServiceHostEnrollment,
  nowMs: number,
): boolean {
  if (!retirableServiceActivation(storage, enrollment)) return false;
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    const value = storage.db
      .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
      .get(enrollment.workspaceId, enrollment.objectId);
    const current = value ? row(value) : null;
    if (
      !current ||
      covered(storage, current, nowMs) ||
      !retirableServiceActivation(storage, current)
    )
      return false;
    endServiceHostRun(storage, current, nowMs);
    return openServiceActivationRetirement(storage, current, nowMs) !== null;
  });
}
/**
 * Called once the service host no longer holds the document. Applies the
 * owner's pending Pause, and retires an enrollment that no active Edit
 * grant covers. Returns null when neither applies.
 */
export function releaseServiceHostEnrollment(
  storage: StorageContext,
  input: { workspaceId: string; objectId: string; nowMs: number },
): ServiceHostEnrollment | null {
  const nowMs = timestamp(input.nowMs),
    standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    const value = storage.db
      .prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
      .get(parseWorkspaceId(input.workspaceId), input.objectId);
    const current = value ? row(value) : null;
    if (!current) return null;
    const uncovered = !covered(storage, current, nowMs);
    if (current.retired && current.hostDrainedAtMs !== null) return null;
    if (!current.retired && !uncovered && !(current.enabled && current.ownerStop)) return null;
    storage.db
      .prepare(
        `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=?,host_drained_at_ms=COALESCE(host_drained_at_ms,?),updated_at_ms=?,${ACCESS_ENDED}
          WHERE workspace_id=? AND object_id=?`,
      )
      .run(
        Number(current.retired || uncovered || current.ownerStop === "retire"),
        nowMs,
        Math.max(nowMs, current.updatedAtMs),
        nowMs,
        current.workspaceId,
        current.objectId,
      );
    forgetIdleServiceHostUploads(storage, current.workspaceId);
    return read(storage, current.workspaceId, current.path);
  });
}

/**
 * Ends the host's upload proof once the workspace has no enabled enrollment
 * and no document still settling, whose verified output may name those bytes.
 */
export function forgetIdleServiceHostUploads(storage: StorageContext, workspaceId: string): void {
  if (
    !currentServiceHostWorkspace(storage, workspaceId) &&
    !listServiceActivationRetirements(storage, workspaceId).length
  ) {
    forgetServiceHostUploads(storage, workspaceId);
  }
}

/**
 * Whether the document has an enrollment. A personal agent's session needs
 * one, as its open leaves, since absence enables a document only for hosts
 * configured without enrollments.
 */
export function serviceHostDocumentEnrolled(
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
): boolean {
  return (
    storage.db
      .prepare(`SELECT 1 FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
      .get(document.workspaceId, document.objectId) !== undefined
  );
}

/**
 * Absence preserves explicitly configured hosts. A retained enrollment fences
 * its document once its owner pauses or stops it, its workspace changes, or no
 * Edit grant of its owner covers its enrolled path. An open retirement fences
 * it until its activation retires, whatever its enrollment.
 */
export function serviceHostDocumentEnabled(
  storage: StorageContext,
  document: { workspaceId: string; objectId: string },
  nowMs = Date.now(),
): boolean {
  if (serviceActivationRetirementOpen(storage, document)) return false;
  const value = storage.db
    .prepare(`SELECT e.enabled,e.retired,e.owner_stop,e.owner_user_id,e.path,e.share_id,e.replication_epoch,e.stream_identity,e.demand_at_ms,e.owner_demand,
    w.owner_user_id AS current_owner,w.replication_epoch AS current_epoch,w.stream_identity AS current_stream
    FROM ${SERVICE_HOST_ENROLLMENTS} e JOIN sync_relay_workspaces w USING(workspace_id)
    WHERE e.workspace_id=? AND e.object_id=?`)
    .get(document.workspaceId, document.objectId);
  if (!value) return true;
  const enrollment = {
    workspaceId: document.workspaceId,
    objectId: document.objectId,
    ownerUserId: String(value.owner_user_id),
    path: String(value.path),
    shareId: value.share_id === null ? null : String(value.share_id),
  };
  return (
    value.enabled === 1 &&
    value.retired === 0 &&
    value.owner_stop === null &&
    value.owner_user_id === value.current_owner &&
    value.replication_epoch === value.current_epoch &&
    value.stream_identity === value.current_stream &&
    heldFor(
      storage,
      enrollment,
      {
        ...enrollment,
        ownerDemand: value.owner_demand === 1,
        demandAtMs: value.demand_at_ms === null ? null : Number(value.demand_at_ms),
      },
      nowMs,
    )
  );
}

export function scanServiceHostCandidateShares(
  storage: StorageContext,
  after?: ServiceHostCandidateCursor,
  onlyWorkspaceId?: string,
): ServiceHostCandidatePage {
  const workspaceId = after === undefined ? "" : parseWorkspaceId(after.workspaceId),
    shareId = after === undefined ? "" : parseLiveUpdateIdentifier(after.shareId, "share ID");
  const workspace = onlyWorkspaceId === undefined ? undefined : parseWorkspaceId(onlyWorkspaceId);
  return storage.readTx(() => {
    const values = storage.db
      .prepare(`SELECT s.* FROM sync_relay_shares s INDEXED BY ${CANDIDATE_INDEX} JOIN sync_relay_workspaces w USING(workspace_id)
      WHERE ${workspace === undefined ? "(s.workspace_id,s.share_id)>(?,?)" : "s.workspace_id=? AND s.share_id>?"} AND s.granter_user_id=w.owner_user_id AND w.replication_epoch IS NOT NULL AND w.stream_identity IS NOT NULL
        AND EXISTS(SELECT 1 FROM sync_relay_share_grants g WHERE g.share_id=s.share_id AND g.status='active' AND (g.access='edit' OR json_extract(s.selector_json,'$.kind')='workspace'))
      ORDER BY s.workspace_id,s.share_id LIMIT ?`)
      .all(workspace ?? workspaceId, shareId, SERVICE_HOST_MAX_DOCUMENTS + 1);
    const page = values.slice(0, SERVICE_HOST_MAX_DOCUMENTS),
      last = page.at(-1);
    const shares = page.flatMap((value) => {
      const share: SyncRelayShareRow = {
        shareId: String(value.share_id),
        workspaceId: String(value.workspace_id),
        granterUserId: String(value.granter_user_id),
        selectorJson: String(value.selector_json),
        createdAtMs: Number(value.created_at_ms),
      };
      const parsed = parseStoredAnyShareSelectorJson(share.selectorJson),
        selector = parsed && effectiveShareSelector(parsed, "edit");
      return selector && isLiveEditShareSelector(selector) && canonicalLiveSelector(share, selector)
        ? [share]
        : [];
    });
    return {
      shares,
      nextCursor:
        values.length > SERVICE_HOST_MAX_DOCUMENTS && last
          ? { workspaceId: String(last.workspace_id), shareId: String(last.share_id) }
          : null,
    };
  });
}
