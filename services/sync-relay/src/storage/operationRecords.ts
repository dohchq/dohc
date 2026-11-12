import { createHash } from "node:crypto";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { stableJsonStringify } from "../canonicalJson";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

export const ACCOUNT_OPERATIONS = "sync_relay_account_operations";
const WORKSPACE_DELETED = "sync_relay_account_operations_workspace_deleted";
const MARKER = "account-operations-v1";

// One row per phone write, keyed by the account and the phone's operation ID,
// written before the engine changes anything. It binds the write to the
// workspace, the operation, its arguments, and the copy it was made on, and
// holds what a retry or a restart needs to finish it. A row settled long ago
// becomes a tombstone that keeps only its key, binding, and final stage, so
// a retry of a forgotten write can still be told apart from a new one.
// Deleting a workspace leaves its rows as tombstones at once, so the table
// has no foreign key to the workspace.
const SCHEMA = {
  [ACCOUNT_OPERATIONS]: `CREATE TABLE sync_relay_account_operations (
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64 AND binding_hash NOT GLOB '*[^0-9a-f]*'),
  stage TEXT NOT NULL CHECK (stage IN ('recorded', 'reply-written', 'answer-written', 'publishing', 'saved', 'stalled', 'refused')),
  workspace_id TEXT,
  incarnation INTEGER CHECK (incarnation IS NULL OR incarnation BETWEEN 1 AND 9007199254740991),
  replication_epoch TEXT,
  stream_identity TEXT,
  operation TEXT CHECK (operation IS NULL OR length(operation) BETWEEN 1 AND 64),
  command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json)),
  message_state TEXT CHECK (message_state IS NULL OR message_state IN ('pending', 'published')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  active_until_ms INTEGER CHECK (active_until_ms IS NULL OR active_until_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER CHECK (created_at_ms IS NULL OR created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER CHECK (updated_at_ms IS NULL OR updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  settled_at_ms INTEGER CHECK (settled_at_ms IS NULL OR settled_at_ms BETWEEN created_at_ms AND 9007199254740991),
  PRIMARY KEY (account_id, operation_id),
  CHECK (CASE WHEN command_json IS NULL
    THEN stage IN ('saved', 'refused') AND workspace_id IS NULL AND incarnation IS NULL AND replication_epoch IS NULL
      AND stream_identity IS NULL AND operation IS NULL AND message_state IS NULL AND result_json IS NULL
      AND active_until_ms IS NULL AND created_at_ms IS NULL AND updated_at_ms IS NULL AND settled_at_ms IS NULL
    ELSE workspace_id IS NOT NULL AND incarnation IS NOT NULL AND replication_epoch IS NOT NULL
      AND stream_identity IS NOT NULL AND operation IS NOT NULL AND active_until_ms IS NOT NULL
      AND created_at_ms IS NOT NULL AND updated_at_ms IS NOT NULL
      AND (stage IN ('saved', 'refused')) = (settled_at_ms IS NOT NULL) END)
) STRICT`,
  idx_sync_relay_account_operations_workspace: `CREATE INDEX idx_sync_relay_account_operations_workspace
  ON sync_relay_account_operations(workspace_id, incarnation)`,
  idx_sync_relay_account_operations_settled: `CREATE INDEX idx_sync_relay_account_operations_settled
  ON sync_relay_account_operations(settled_at_ms) WHERE settled_at_ms IS NOT NULL`,
  // A deleted workspace can never publish, so its unfinished rows end refused.
  [WORKSPACE_DELETED]: `CREATE TRIGGER sync_relay_account_operations_workspace_deleted
  AFTER DELETE ON sync_relay_workspaces BEGIN
  UPDATE sync_relay_account_operations SET ${tombstone("CASE WHEN stage IN ('saved', 'refused') THEN stage ELSE 'refused' END")}
  WHERE workspace_id = OLD.workspace_id; END`,
} as const;

function tombstone(stage: string): string {
  return `stage = ${stage}, workspace_id = NULL, incarnation = NULL, replication_epoch = NULL, stream_identity = NULL,
    operation = NULL, command_json = NULL, message_state = NULL, result_json = NULL, active_until_ms = NULL,
    created_at_ms = NULL, updated_at_ms = NULL, settled_at_ms = NULL`;
}

const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

function assertSchema(db: SqliteDb): void {
  const objects = db.prepare("SELECT name, sql FROM sqlite_schema WHERE (tbl_name = ? OR name = ?) AND sql IS NOT NULL ORDER BY name")
    .all(ACCOUNT_OPERATIONS, WORKSPACE_DELETED);
  const expected = Object.keys(SCHEMA).sort();
  const schema: Record<string, string> = SCHEMA;
  if (
    objects.length !== expected.length ||
    objects.some((row, index) => row.name !== expected[index] || typeof row.sql !== "string" ||
      normalize(row.sql) !== normalize(schema[row.name as string]!))
  ) {
    throw new Error("account operation schema is missing or damaged");
  }
}

export function initializeOperationRecordSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assertSchema(db);
    return;
  }
  const names = Object.keys(SCHEMA);
  if (db.prepare(`SELECT 1 FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`).get(...names)) {
    throw new Error("unmarked account operation schema already exists");
  }
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
  assertSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(MARKER, Date.now());
}

// The end of active publication attempts, after which an unfinished row is stalled.
export const OPERATION_ACTIVE_MS = 24 * 60 * 60 * 1000;
// How long a settled row keeps its command and result before it becomes a tombstone.
export const OPERATION_KEEP_SETTLED_MS = 30 * 24 * 60 * 60 * 1000;
// The most rows one call turns into tombstones; the caller repeats until fewer come back.
export const OPERATION_TOMBSTONE_BATCH = 1_000;

export type OperationStage = "recorded" | "reply-written" | "answer-written" | "publishing" | "saved" | "stalled" | "refused";
export type OperationMessageState = "pending" | "published";

// A stage moves only forward along this order. `saved` and `refused` are final.
const STAGE_ORDER: Record<OperationStage, number> = {
  recorded: 0, "reply-written": 1, "answer-written": 2, publishing: 3, stalled: 4, saved: 5, refused: 5,
};
const isFinal = (stage: OperationStage) => stage === "saved" || stage === "refused";

/** What a retry must repeat exactly to be the same write. */
export interface OperationBinding {
  workspaceId: string;
  operation: string;
  /** The operation's canonical arguments. */
  args: JsonValue;
}

export interface OperationRecord {
  accountId: string;
  operationId: string;
  workspaceId: string;
  /** The copy's incarnation, epoch, and stream when the write was recorded. */
  incarnation: number;
  replicationEpoch: string;
  streamIdentity: string;
  operation: string;
  bindingHash: string;
  command: JsonValue;
  stage: OperationStage;
  /** Null for an operation that writes no message. */
  messageState: OperationMessageState | null;
  result: JsonValue | null;
  activeUntilMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  settledAtMs: number | null;
}

export type OperationLookup =
  | { kind: "absent" }
  | { kind: "found"; record: OperationRecord }
  /** The key was used for a different write. */
  | { kind: "mismatch" }
  /** The write settled long ago and only its tombstone is left. */
  | { kind: "too-old" };

export type OperationClaim = { kind: "recorded"; record: OperationRecord } | Exclude<OperationLookup, { kind: "absent" }>;

export interface RecordOperationInput {
  /** From the session, never from the request. */
  accountId: string;
  operationId: string;
  binding: OperationBinding;
  incarnation: number;
  replicationEpoch: string;
  streamIdentity: string;
  /** Resolved targets, derived IDs, and the author snapshot. */
  command: JsonValue;
  writesMessage: boolean;
  nowMs: number;
}

export interface AdvanceOperationInput {
  accountId: string;
  operationId: string;
  stage: OperationStage;
  message?: "published";
  result?: JsonValue;
  nowMs: number;
}

function bindingHash(binding: OperationBinding): string {
  return createHash("sha256").update(stableJsonStringify([binding.workspaceId, binding.operation, binding.args])).digest("hex");
}

const parse = (value: unknown) => JSON.parse(String(value)) as JsonValue;
const nullableNumber = (value: unknown) => value === null ? null : Number(value);

function recordOf(row: Record<string, unknown>): OperationRecord {
  return {
    accountId: String(row.account_id),
    operationId: String(row.operation_id),
    workspaceId: String(row.workspace_id),
    incarnation: Number(row.incarnation),
    replicationEpoch: String(row.replication_epoch),
    streamIdentity: String(row.stream_identity),
    operation: String(row.operation),
    bindingHash: String(row.binding_hash),
    command: parse(row.command_json),
    stage: String(row.stage) as OperationStage,
    messageState: row.message_state === null ? null : String(row.message_state) as OperationMessageState,
    result: row.result_json === null ? null : parse(row.result_json),
    activeUntilMs: Number(row.active_until_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    settledAtMs: nullableNumber(row.settled_at_ms),
  };
}

function readRow(storage: StorageContext, accountId: string, operationId: string): Record<string, unknown> | undefined {
  return storage.db.prepare("SELECT * FROM sync_relay_account_operations WHERE account_id = ? AND operation_id = ?")
    .get(accountId, operationId);
}

function classify(row: Record<string, unknown> | undefined, hash: string): OperationLookup {
  if (!row) return { kind: "absent" };
  if (row.binding_hash !== hash) return { kind: "mismatch" };
  if (row.command_json === null) return { kind: "too-old" };
  return { kind: "found", record: recordOf(row) };
}

/** Answers a retry from its record, without writing. */
export function lookupOperation(
  storage: StorageContext,
  input: { accountId: string; operationId: string; binding: OperationBinding },
): OperationLookup {
  return storage.readTx(() => classify(readRow(storage, input.accountId, input.operationId), bindingHash(input.binding)));
}

/**
 * Records a write before the engine is asked to change anything. The primary
 * key admits one row per key: a request that finds one already answers from
 * it, and writes nothing.
 */
export function recordOperation(storage: StorageContext, input: RecordOperationInput): OperationClaim {
  const hash = bindingHash(input.binding);
  return storage.tx(() => {
    const inserted = storage.db.prepare(
      `INSERT INTO sync_relay_account_operations (account_id, operation_id, binding_hash, stage, workspace_id, incarnation,
         replication_epoch, stream_identity, operation, command_json, message_state, result_json, active_until_ms,
         created_at_ms, updated_at_ms, settled_at_ms)
       VALUES (?, ?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
       ON CONFLICT (account_id, operation_id) DO NOTHING`,
    ).run(
      input.accountId, input.operationId, hash, input.binding.workspaceId, input.incarnation, input.replicationEpoch,
      input.streamIdentity, input.binding.operation, JSON.stringify(input.command), input.writesMessage ? "pending" : null,
      input.nowMs + OPERATION_ACTIVE_MS, input.nowMs, input.nowMs,
    );
    const row = readRow(storage, input.accountId, input.operationId);
    if (Number(inserted.changes) === 1) return { kind: "recorded", record: recordOf(row!) };
    const found = classify(row, hash);
    if (found.kind === "absent") throw new Error("An account operation conflicted without a row.");
    return found;
  });
}

/**
 * Moves a write's stage forward, marks its message published, or stores its
 * result. A stage never moves back and a final stage never changes, so a late
 * or repeated call leaves the row as it is and writes nothing. Returns the row
 * after the call and whether it changed, or null when only a tombstone or
 * nothing is left.
 */
export function advanceOperation(
  storage: StorageContext,
  input: AdvanceOperationInput,
): { moved: boolean; record: OperationRecord } | null {
  return storage.tx(() => {
    const row = readRow(storage, input.accountId, input.operationId);
    if (!row || row.command_json === null) return null;
    const record = recordOf(row);
    if (input.message !== undefined && record.messageState === null) {
      throw new Error("This operation writes no message.");
    }
    if (isFinal(record.stage) || STAGE_ORDER[input.stage] < STAGE_ORDER[record.stage]) return { moved: false, record };
    const messageState = input.message ?? record.messageState;
    const resultJson = input.result === undefined ? row.result_json : JSON.stringify(input.result);
    if (input.stage === record.stage && messageState === record.messageState && resultJson === row.result_json) {
      return { moved: false, record };
    }
    storage.db.prepare(
      `UPDATE sync_relay_account_operations SET stage = ?, message_state = ?, result_json = ?, updated_at_ms = ?, settled_at_ms = ?
       WHERE account_id = ? AND operation_id = ?`,
    ).run(
      input.stage, messageState, resultJson, Math.max(input.nowMs, record.createdAtMs),
      isFinal(input.stage) ? Math.max(input.nowMs, record.createdAtMs) : null, input.accountId, input.operationId,
    );
    return { moved: true, record: recordOf(readRow(storage, input.accountId, input.operationId)!) };
  });
}

/** The writes still to finish on one copy, oldest first, including stalled ones. */
export function listUnfinishedOperations(
  storage: StorageContext,
  input: { workspaceId: string; incarnation: number },
): OperationRecord[] {
  return storage.readTx(() => storage.db.prepare(
    `SELECT * FROM sync_relay_account_operations
     WHERE workspace_id = ? AND incarnation = ? AND stage NOT IN ('saved', 'refused')
     ORDER BY created_at_ms, account_id, operation_id`,
  ).all(input.workspaceId, input.incarnation).map(recordOf));
}

/** Turns rows settled more than OPERATION_KEEP_SETTLED_MS ago into tombstones. Returns how many. */
export function tombstoneSettledOperations(storage: StorageContext, nowMs: number): number {
  return storage.tx(() => Number(storage.db.prepare(
    `UPDATE sync_relay_account_operations SET ${tombstone("stage")}
     WHERE rowid IN (SELECT rowid FROM sync_relay_account_operations
       WHERE settled_at_ms IS NOT NULL AND settled_at_ms < ? LIMIT ?)`,
  ).run(nowMs - OPERATION_KEEP_SETTLED_MS, OPERATION_TOMBSTONE_BATCH).changes));
}
