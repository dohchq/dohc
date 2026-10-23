import type {StorageContext} from "./context";
import type {SqliteDb} from "./types";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {parseWorkspaceId} from "../requestInputs";

// Owner queues the service host keeps refused, one row per queue, so the owner
// can see and recover them after the host unloads, retires or restarts. The
// host's engine holds the bytes. `generation` counts the refusals recorded for
// the queue; a recovery copy covers the generation it was read at, since a
// refused queue only shrinks until it is refused again.
export const SERVICE_KEPT_EDITS = "sync_relay_service_kept_edits";
const MIGRATION = "service-kept-edits-v1";
const SQL = `CREATE TABLE ${SERVICE_KEPT_EDITS} (
  workspace_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('provenance-refused','delivery-conflict','capacity-refused','invalid-update')),
  head_delivery_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  retrying INTEGER NOT NULL CHECK (retrying IN (0,1)),
  copied_generation INTEGER CHECK (copied_generation IS NULL OR copied_generation BETWEEN 1 AND generation),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (workspace_id, outbox_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`;
const OBJECT_INDEX = "idx_sync_relay_service_kept_edits_object";
const OBJECT_INDEX_SQL = `CREATE INDEX ${OBJECT_INDEX} ON ${SERVICE_KEPT_EDITS}(workspace_id,object_id)`;
const MAX_ROWS = 256;
export type ServiceKeptEditsReason = "provenance-refused" | "delivery-conflict" | "capacity-refused" | "invalid-update";
const REASONS: readonly string[] = ["provenance-refused", "delivery-conflict", "capacity-refused", "invalid-update"];

/** One refused service-held queue. `copied` is whether the owner confirmed a recovery copy of this refusal. */
export interface ServiceKeptEdits {
  readonly workspaceId: string;
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
  const generation = value.generation, copied = value.copied_generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !REASONS.includes(String(value.reason)) ||
    (value.retrying !== 0 && value.retrying !== 1) || (copied !== null && typeof copied !== "number")) throw new Error("Service kept edits are damaged.");
  const binding = parseLiveObjectBinding(JSON.parse(String(value.binding_json)));
  const workspaceId = parseWorkspaceId(value.workspace_id), objectId = parseLiveUpdateIdentifier(value.object_id, "object ID");
  if (binding.workspaceId !== workspaceId || binding.objectId !== objectId) throw new Error("Service kept edits are damaged.");
  return Object.freeze({workspaceId, outboxId: parseLiveUpdateIdentifier(value.outbox_id, "outbox ID"), objectId, binding,
    reason: value.reason as ServiceKeptEditsReason, headDeliveryId: parseLiveUpdateIdentifier(value.head_delivery_id, "delivery ID"),
    generation, retrying: value.retrying === 1, copied: copied === generation});
}

/** Records a refusal of the queue's head. A later refusal of the same queue is a new generation, which no earlier copy covers. */
export function recordServiceKeptEdits(storage: StorageContext, input: {outboxId: string; binding: LiveObjectBinding; reason: string; headDeliveryId: string; nowMs: number}): void {
  const binding = parseLiveObjectBinding(input.binding);
  if (!REASONS.includes(input.reason)) throw new Error("Invalid kept edits reason.");
  const standing = storage.captureStanding();
  storage.tx(() => {
    standing();
    storage.db.prepare(`INSERT INTO ${SERVICE_KEPT_EDITS}(workspace_id,outbox_id,object_id,binding_json,reason,head_delivery_id,generation,retrying,recorded_at_ms)
      VALUES (?,?,?,?,?,?,1,0,?) ON CONFLICT(workspace_id,outbox_id) DO UPDATE SET binding_json=excluded.binding_json,reason=excluded.reason,
      head_delivery_id=excluded.head_delivery_id,generation=generation+1,retrying=0,recorded_at_ms=excluded.recorded_at_ms`)
      .run(binding.workspaceId, parseLiveUpdateIdentifier(input.outboxId, "outbox ID"), binding.objectId, JSON.stringify(binding),
        input.reason, parseLiveUpdateIdentifier(input.headDeliveryId, "delivery ID"), input.nowMs);
  });
}

/** Forgets a queue its host delivers again or no longer holds. */
export function forgetServiceKeptEdits(storage: StorageContext, input: {workspaceId: string; outboxId: string}): void {
  const workspaceId = parseWorkspaceId(input.workspaceId), standing = storage.captureStanding();
  if (!storage.db.prepare(`SELECT 1 FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND outbox_id=?`).get(workspaceId, input.outboxId)) return;
  storage.tx(() => {standing(); storage.db.prepare(`DELETE FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND outbox_id=?`).run(workspaceId, input.outboxId);});
}

export function listServiceKeptEdits(storage: StorageContext, workspaceId: string): readonly ServiceKeptEdits[] {
  storage.captureStanding();
  const values = storage.db.prepare(`SELECT * FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? ORDER BY object_id,outbox_id LIMIT ?`)
    .all(parseWorkspaceId(workspaceId), MAX_ROWS + 1);
  if (values.length > MAX_ROWS) throw new Error("Service kept edits capacity is damaged.");
  return values.map(row);
}

export function readServiceKeptEdits(storage: StorageContext, workspaceId: string, outboxId: string): ServiceKeptEdits | null {
  storage.captureStanding();
  const value = storage.db.prepare(`SELECT * FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND outbox_id=?`).get(parseWorkspaceId(workspaceId), outboxId);
  return value ? row(value) : null;
}

/** Marks the owner's Try again of this generation. Returns false once the queue changed. */
export function markServiceKeptEditsRetrying(storage: StorageContext, input: {workspaceId: string; outboxId: string; generation: number}): boolean {
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return storage.db.prepare(`UPDATE ${SERVICE_KEPT_EDITS} SET retrying=1 WHERE workspace_id=? AND outbox_id=? AND generation=?`)
      .run(parseWorkspaceId(input.workspaceId), input.outboxId, input.generation).changes === 1;
  });
}

/** Records the owner's durable recovery copy of this generation. Returns false once the queue changed. */
export function confirmServiceKeptEditsCopy(storage: StorageContext, input: {workspaceId: string; outboxId: string; generation: number}): boolean {
  const standing = storage.captureStanding();
  return storage.tx(() => {
    standing();
    return storage.db.prepare(`UPDATE ${SERVICE_KEPT_EDITS} SET copied_generation=generation WHERE workspace_id=? AND outbox_id=? AND generation=?`)
      .run(parseWorkspaceId(input.workspaceId), input.outboxId, input.generation).changes === 1;
  });
}

/** Whether the host must keep the document: one of its refused queues has no recovery copy of its latest refusal. */
export function serviceKeptEditsHeld(storage: StorageContext, document: {workspaceId: string; objectId: string}): boolean {
  return storage.db.prepare(`SELECT 1 FROM ${SERVICE_KEPT_EDITS} WHERE workspace_id=? AND object_id=?
    AND (copied_generation IS NULL OR copied_generation<>generation)`).get(document.workspaceId, document.objectId) !== undefined;
}
