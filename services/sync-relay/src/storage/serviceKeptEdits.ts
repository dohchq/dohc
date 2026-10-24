import type {StorageContext} from "./context";
import type {SqliteDb} from "./types";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {parseWorkspaceId} from "../requestInputs";

// Owner queues the service host keeps refused, one row per queue, so the owner
// can see and recover them after the host unloads, retires or restarts. The
// host's engine holds the bytes, in the store of the workspace identity the
// row names. That identity never changes and locates the store, so a row
// still reaches its bytes after the workspace moves to a later identity.
// An outbox ID names a queue only within one store: a store of a
// later identity can hold another queue with the same ID, so the identity is
// part of the key. Each refusal gets a new row whose `generation` the relay never
// hands out again, so a recovery copy, a Try again or a confirmation names
// exactly the refusal it saw. A refused queue only shrinks until it is
// refused again: only owner enrollment adds to a refused queue, and the
// service host's engine refuses that method. The generation counts across
// the relay, so the gap between two of an owner's rows tells them how many
// refusals other workspaces had meanwhile; that count is all it reveals.
// A copy names the accepted checkpoint it read. While the queue stays frozen
// at its owner's adoption seed, the host records the checkpoint a copy reads
// now, and a copy of an older one no longer counts.
export const SERVICE_KEPT_EDITS = "sync_relay_service_kept_edits";
const MIGRATION = "service-kept-edits-v1";
const SQL = `CREATE TABLE ${SERVICE_KEPT_EDITS} (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('provenance-refused','delivery-conflict','capacity-refused','invalid-update')),
  head_delivery_id TEXT NOT NULL,
  refusal_key TEXT NOT NULL,
  retrying INTEGER NOT NULL CHECK (retrying IN (0,1)),
  copied INTEGER NOT NULL CHECK (copied IN (0,1)),
  copied_checkpoint TEXT CHECK (copied_checkpoint IS NULL OR (copied=1 AND length(copied_checkpoint)=64)),
  frozen_checkpoint TEXT CHECK (frozen_checkpoint IS NULL OR length(frozen_checkpoint)=64),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  UNIQUE (workspace_id, replication_epoch, stream_identity, outbox_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`;
const OBJECT_INDEX = "idx_sync_relay_service_kept_edits_object";
const OBJECT_INDEX_SQL = `CREATE INDEX ${OBJECT_INDEX} ON ${SERVICE_KEPT_EDITS}(workspace_id,object_id)`;
/** Rows in one page of a workspace's list. */
export const SERVICE_KEPT_EDITS_PAGE = 256;
export type ServiceKeptEditsReason = "provenance-refused" | "delivery-conflict" | "capacity-refused" | "invalid-update";
export const SERVICE_KEPT_EDITS_REASONS: readonly string[] = ["provenance-refused", "delivery-conflict", "capacity-refused", "invalid-update"];

/** The workspace identity whose hosted store holds a queue. */
export interface ServiceKeptEditsIdentity {readonly replicationEpoch: string; readonly streamIdentity: string}
/** One queue, in the store of one workspace identity. */
export interface ServiceKeptEditsQueue {readonly workspaceId: string; readonly identity: ServiceKeptEditsIdentity; readonly outboxId: string}
export const sameKeptEditsIdentity = (a: ServiceKeptEditsIdentity, b: {replicationEpoch: string | null; streamIdentity: string | null} | null | undefined) =>
  !!b && a.replicationEpoch === b.replicationEpoch && a.streamIdentity === b.streamIdentity;

/**
 * Why the server could not prepare an earlier store for its owner's recovery
 * copy: it has no room for the copy, a newer build migrated the store, the
 * store is busy, or anything else, which the server's administrator must
 * check. The edits stay where they are.
 */
export type RecoveryCopyReason = "disk-space" | "newer-schema" | "busy" | "server";
export class RecoveryCopyRefusal extends Error {
  constructor(readonly reason: RecoveryCopyReason) {
    super("The server could not prepare a recovery copy of these edits.");
  }
}

/**
 * One refused service-held queue. `copied` is whether the owner confirmed a
 * recovery copy of this refusal that holds the checkpoint a copy reads now.
 */
export interface ServiceKeptEdits {
  readonly workspaceId: string;
  readonly identity: ServiceKeptEditsIdentity;
  readonly outboxId: string;
  readonly objectId: string;
  readonly binding: LiveObjectBinding;
  readonly reason: ServiceKeptEditsReason;
  readonly headDeliveryId: string;
  readonly generation: number;
  readonly retrying: boolean;
  readonly copied: boolean;
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
export function initializeServiceKeptEditsSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(MIGRATION);
  const existing = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_KEPT_EDITS);
  if (!marked) {
    if (existing) throw new Error("Unmarked service kept edits storage exists.");
    db.exec(SQL);
    db.exec(OBJECT_INDEX_SQL);
  } else if (!existing || existing.type !== "table" || typeof existing.sql !== "string" || !same(existing.sql, SQL)) {
    throw new Error("Service kept edits storage is damaged.");
  }
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_KEPT_EDITS})`).all();
  const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(OBJECT_INDEX);
  if (indexes.length !== 2 || typeof index?.sql !== "string" || !same(index.sql, OBJECT_INDEX_SQL) ||
    db.prepare(`PRAGMA foreign_key_check(${SERVICE_KEPT_EDITS})`).all().length ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_KEPT_EDITS)) throw new Error("Service kept edits constraints are damaged.");
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(MIGRATION, Date.now());
}

function row(value: Record<string, unknown>): ServiceKeptEdits {
  const generation = value.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !SERVICE_KEPT_EDITS_REASONS.includes(String(value.reason)) ||
    (value.retrying !== 0 && value.retrying !== 1) || (value.copied !== 0 && value.copied !== 1)) throw new Error("Service kept edits are damaged.");
  const binding = parseLiveObjectBinding(JSON.parse(String(value.binding_json)));
  const workspaceId = parseWorkspaceId(value.workspace_id), objectId = parseLiveUpdateIdentifier(value.object_id, "object ID");
  if (binding.workspaceId !== workspaceId || binding.objectId !== objectId) throw new Error("Service kept edits are damaged.");
  const identity = Object.freeze({replicationEpoch: parseLiveUpdateIdentifier(value.replication_epoch, "replication epoch"),
    streamIdentity: parseLiveUpdateIdentifier(value.stream_identity, "stream identity")});
  return Object.freeze({workspaceId, identity, outboxId: parseLiveUpdateIdentifier(value.outbox_id, "outbox ID"), objectId, binding,
    reason: value.reason as ServiceKeptEditsReason, headDeliveryId: parseLiveUpdateIdentifier(value.head_delivery_id, "delivery ID"),
    generation, retrying: value.retrying === 1, copied: value.copied === 1 && (value.frozen_checkpoint === null || value.copied_checkpoint === value.frozen_checkpoint)});
}
// The rows whose copy holds what a copy reads now.
const COPIED = "copied=1 AND (frozen_checkpoint IS NULL OR copied_checkpoint IS frozen_checkpoint)";
const isDigest = (value: string | null) => value === null || /^[0-9a-f]{64}$/.test(value);

const QUEUE = "workspace_id=? AND replication_epoch=? AND stream_identity=? AND outbox_id=?";
const queueKey = (queue: ServiceKeptEditsQueue) => [parseWorkspaceId(queue.workspaceId), parseLiveUpdateIdentifier(queue.identity.replicationEpoch, "replication epoch"),
  parseLiveUpdateIdentifier(queue.identity.streamIdentity, "stream identity"), parseLiveUpdateIdentifier(queue.outboxId, "outbox ID")] as const;

/**
 * Records a refusal of the queue's head, identified by its refusal key. The
 * same refusal recorded again changes nothing; any other is a new generation,
 * which no earlier copy, Try again or confirmation covers.
 */
export function recordServiceKeptEdits(storage: StorageContext, input: {identity: ServiceKeptEditsIdentity; outboxId: string; binding: LiveObjectBinding; reason: string;
  headDeliveryId: string; refusalKey: string; nowMs: number}): void {
  const binding = parseLiveObjectBinding(input.binding), outboxId = parseLiveUpdateIdentifier(input.outboxId, "outbox ID");
  if (!SERVICE_KEPT_EDITS_REASONS.includes(input.reason)) throw new Error("Invalid kept edits reason.");
  const refusalKey = parseLiveUpdateIdentifier(input.refusalKey, "refusal key");
  const queue = queueKey({workspaceId: binding.workspaceId, identity: input.identity, outboxId});
  const standing = storage.captureStanding();
  storage.tx(() => {
    standing();
    if (storage.db.prepare(`SELECT refusal_key FROM ${SERVICE_KEPT_EDITS} WHERE ${QUEUE}`).get(...queue)?.refusal_key === refusalKey) return;
    storage.db.prepare(`DELETE FROM ${SERVICE_KEPT_EDITS} WHERE ${QUEUE}`).run(...queue);
    storage.db.prepare(`INSERT INTO ${SERVICE_KEPT_EDITS}(workspace_id,replication_epoch,stream_identity,outbox_id,object_id,binding_json,reason,head_delivery_id,refusal_key,retrying,copied,recorded_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,0,0,?)`).run(...queue, binding.objectId, JSON.stringify(binding),
      input.reason, parseLiveUpdateIdentifier(input.headDeliveryId, "delivery ID"), refusalKey, input.nowMs);
  });
}

/** Forgets a queue its host delivers again or no longer holds. */
export function forgetServiceKeptEdits(storage: StorageContext, queue: ServiceKeptEditsQueue): void {
  const key = queueKey(queue), standing = storage.captureStanding();
  if (!storage.db.prepare(`SELECT 1 FROM ${SERVICE_KEPT_EDITS} WHERE ${QUEUE}`).get(...key)) return;
  storage.tx(() => {standing(); storage.db.prepare(`DELETE FROM ${SERVICE_KEPT_EDITS} WHERE ${QUEUE}`).run(...key);});
}

/** Forgets the document's rows once it left its host with a recovery copy of every refusal. */
export function releaseServiceKeptEdits(storage: StorageContext, document: {workspaceId: string; objectId: string}): void {
  const workspaceId = parseWorkspaceId(document.workspaceId), standing = storage.captureStanding();
  storage.tx(() => {
    standing();
    storage.db.prepare(`DELETE FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND object_id=? AND ${COPIED}`).run(workspaceId, document.objectId);
  });
}

/** One page of a workspace's rows, oldest refusal first. `nextCursor` continues it. */
export function listServiceKeptEdits(storage: StorageContext, workspaceId: string, after = 0): {keptEdits: readonly ServiceKeptEdits[]; nextCursor: number | null} {
  storage.captureStanding();
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid kept edits cursor.");
  const values = storage.db.prepare(`SELECT * FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND generation>? ORDER BY generation LIMIT ?`)
    .all(parseWorkspaceId(workspaceId), after, SERVICE_KEPT_EDITS_PAGE + 1);
  const keptEdits = values.slice(0, SERVICE_KEPT_EDITS_PAGE).map(row);
  return {keptEdits, nextCursor: values.length > SERVICE_KEPT_EDITS_PAGE ? keptEdits.at(-1)!.generation : null};
}

/** The row of one queue in one identity's store. */
export function readServiceKeptEdits(storage: StorageContext, queue: ServiceKeptEditsQueue): ServiceKeptEdits | null {
  storage.captureStanding();
  const value = storage.db.prepare(`SELECT * FROM ${SERVICE_KEPT_EDITS} WHERE ${QUEUE}`).get(...queueKey(queue));
  return value ? row(value) : null;
}

/** The row of one refusal, as its owner names it: the queue and the refusal's generation, whatever store holds it. */
export function readServiceKeptEditsRefusal(storage: StorageContext, input: {workspaceId: string; outboxId: string; generation: number}): ServiceKeptEdits | null {
  storage.captureStanding();
  const value = storage.db.prepare(`SELECT * FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND outbox_id=? AND generation=?`)
    .get(parseWorkspaceId(input.workspaceId), input.outboxId, input.generation);
  return value ? row(value) : null;
}

/** One page of the rows of one document's queues, oldest refusal first. `nextCursor` continues it. */
export function serviceKeptEditsOf(storage: StorageContext, document: {workspaceId: string; objectId: string}, after = 0): {keptEdits: readonly ServiceKeptEdits[]; nextCursor: number | null} {
  storage.captureStanding();
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid kept edits cursor.");
  const values = storage.db.prepare(`SELECT * FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND object_id=? AND generation>? ORDER BY generation LIMIT ?`)
    .all(parseWorkspaceId(document.workspaceId), document.objectId, after, SERVICE_KEPT_EDITS_PAGE + 1);
  const keptEdits = values.slice(0, SERVICE_KEPT_EDITS_PAGE).map(row);
  return {keptEdits, nextCursor: values.length > SERVICE_KEPT_EDITS_PAGE ? keptEdits.at(-1)!.generation : null};
}

/** Marks the owner's Try again of this refusal. Returns false once the queue changed or a Try again is already waiting. */
export function markServiceKeptEditsRetrying(storage: StorageContext, input: {workspaceId: string; outboxId: string; generation: number}): boolean {
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return storage.db.prepare(`UPDATE ${SERVICE_KEPT_EDITS} SET retrying=1 WHERE workspace_id=? AND outbox_id=? AND generation=? AND retrying=0`)
      .run(parseWorkspaceId(input.workspaceId), input.outboxId, input.generation).changes === 1;
  });
}

/** Records that the host ended the owner's Try again of this queue without an attempt. */
export function endServiceKeptEditsRetry(storage: StorageContext, queue: ServiceKeptEditsQueue): void {
  const key = queueKey(queue), standing = storage.captureStanding();
  storage.tx(() => {
    standing();
    storage.db.prepare(`UPDATE ${SERVICE_KEPT_EDITS} SET retrying=0 WHERE ${QUEUE}`).run(...key);
  });
}

/**
 * Records the owner's durable recovery copy of this refusal, with the
 * checkpoint it read. Returns false once the queue changed.
 */
export function confirmServiceKeptEditsCopy(storage: StorageContext, input: {workspaceId: string; outboxId: string; generation: number; checkpointDigest: string | null}): boolean {
  if (!isDigest(input.checkpointDigest)) throw new Error("Invalid kept edits checkpoint.");
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return storage.db.prepare(`UPDATE ${SERVICE_KEPT_EDITS} SET copied=1,copied_checkpoint=? WHERE workspace_id=? AND outbox_id=? AND generation=?`)
      .run(input.checkpointDigest, parseWorkspaceId(input.workspaceId), input.outboxId, input.generation).changes === 1;
  });
}

/**
 * Records the checkpoint a recovery copy of this queue reads now while it
 * stays frozen at its owner's adoption seed, or null once it does not.
 */
export function observeServiceKeptEditsCheckpoint(storage: StorageContext, queue: ServiceKeptEditsQueue, frozenCheckpoint: string | null): void {
  if (!isDigest(frozenCheckpoint)) throw new Error("Invalid kept edits checkpoint.");
  const key = queueKey(queue), standing = storage.captureStanding();
  storage.tx(() => {
    standing();
    storage.db.prepare(`UPDATE ${SERVICE_KEPT_EDITS} SET frozen_checkpoint=? WHERE ${QUEUE}`).run(frozenCheckpoint, ...key);
  });
}

/**
 * Whether the host must keep the document: one of its refused queues in the
 * store of `identity` has no recovery copy of its latest refusal. A row of
 * another identity's store never holds it, since no attachment reaches it.
 */
export function serviceKeptEditsHeld(storage: StorageContext, document: {workspaceId: string; objectId: string}, identity: ServiceKeptEditsIdentity): boolean {
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND object_id=? AND replication_epoch=? AND stream_identity=? AND NOT (${COPIED})`)
    .get(document.workspaceId, document.objectId, identity.replicationEpoch, identity.streamIdentity) !== undefined;
}

/** Whether any refusal kept in the store of `identity` has no recovery copy, whatever its document. */
export function serviceKeptEditsStoreHeld(storage: StorageContext, workspaceId: string, identity: ServiceKeptEditsIdentity): boolean {
  storage.captureStanding();
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND replication_epoch=? AND stream_identity=? AND copied=0`)
    .get(parseWorkspaceId(workspaceId), identity.replicationEpoch, identity.streamIdentity) !== undefined;
}
