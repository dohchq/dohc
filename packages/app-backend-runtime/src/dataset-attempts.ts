import { createHash, randomBytes } from "node:crypto";
import { parseDatasetAttemptRequest, parseDatasetAttemptResult, type DatasetAttemptResult } from "@dohc/security-contract/dataset-attempts";
import type { DatasetScope, JournalDb } from "./journal.js";

export interface DatasetAttemptScope {
  workspaceId: string; datasetId: string; appId: string; principalKey: string; operationId: string;
  revisionSha256: string;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function committedAttempt(db: JournalDb, scope: DatasetScope, row: Record<string, unknown>) {
  const attempt = parseDatasetAttemptResult(JSON.parse(String(row.attempt_json))).attempt!;
  const callerKey = digest([row.principal_key, {kind: "app", appId: row.app_id}]);
  const receipt = db.prepare(`SELECT r.payload_sha256,r.revision,e.operation,e.recorded_at_ms,json_array_length(e.attached_file_ids) AS attachment_count
    FROM dohc_dataset_receipts r JOIN dohc_dataset_events e ON e.workspace_id=r.workspace_id AND e.dataset_id=r.dataset_id AND e.revision=r.revision
    WHERE r.workspace_id=? AND r.dataset_id=? AND r.caller_key=? AND r.idempotency_key=?
      AND e.caller_key=r.caller_key AND e.idempotency_key=r.idempotency_key AND e.payload_sha256=r.payload_sha256 AND e.result_json=r.result_json`)
    .get(scope.workspaceId, scope.datasetId, callerKey, attempt.idempotencyKey);
  return receipt?.payload_sha256 === digest([row.revision_sha256, row.operation_id, attempt.input]) ? receipt : undefined;
}
const reviewReference = (scope: DatasetScope, row: Record<string, unknown>) => digest([scope.workspaceId, scope.datasetId, row.app_id, row.principal_key, row.operation_id, parseDatasetAttemptResult(JSON.parse(String(row.attempt_json))).attempt!.token]);
export interface PendingAttemptReview {
  reference: string; operation: string; recordedAtMs: number | null; revision: number | null;
  outcome: "committed" | "unconfirmed"; attachmentCount: number;
}
/** Owner-facing metadata excludes submission input, participant identity, and the participant retry key. */
export function reviewDatasetAttempts(db: JournalDb, scope: DatasetScope, after = 0, limit = 50) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid pending response page.");
  const rows = db.prepare("SELECT rowid,* FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=? AND rowid>? ORDER BY rowid LIMIT ?").all(scope.workspaceId, scope.datasetId, after, limit + 1);
  const selected = rows.slice(0, limit);
  const entries: PendingAttemptReview[] = selected.map(row => {
    const receipt = committedAttempt(db, scope, row);
    const catalog = db.prepare(`SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=? AND json_extract(revision_json,'$.revisionSha256')=?
      UNION ALL SELECT revision_json FROM dohc_dataset_catalog_history WHERE workspace_id=? AND dataset_id=? AND json_extract(revision_json,'$.revisionSha256')=? LIMIT 1`)
      .get(scope.workspaceId, scope.datasetId, row.revision_sha256, scope.workspaceId, scope.datasetId, row.revision_sha256);
    const approved = catalog ? JSON.parse(String(catalog.revision_json)) as {definition: {operations: {operationId: string; label: string}[]}} : undefined;
    return {reference: reviewReference(scope, row), operation: approved?.definition.operations.find(operation => operation.operationId === row.operation_id)?.label ?? "Submission",
      recordedAtMs: receipt ? Number(receipt.recorded_at_ms) : null, revision: receipt ? Number(receipt.revision) : null,
      outcome: receipt ? "committed" : "unconfirmed", attachmentCount: receipt ? Number(receipt.attachment_count) : 0};
  });
  return {datasetId: scope.datasetId, entries, nextAfter: rows.length > limit ? Number(selected.at(-1)!.rowid) : null};
}
/** Caller supplies owner authorization and byte accounting in the surrounding transaction. */
export function reconcileDatasetAttempt(db: JournalDb, scope: DatasetScope, reference: string): number {
  if (typeof reference !== "string" || reference.length !== 64 || !/^[a-f0-9]{64}$/.test(reference)) throw new Error("Invalid pending response reference.");
  let after = 0;
  for (;;) {
    const rows = db.prepare("SELECT rowid,* FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=? AND rowid>? ORDER BY rowid LIMIT 64").all(scope.workspaceId, scope.datasetId, after);
    if (!rows.length) return 0;
    for (const row of rows) {
      after = Number(row.rowid);
      if (reviewReference(scope, row) !== reference) continue;
      if (!committedAttempt(db, scope, row)) throw new Error("This submission is unconfirmed. Retry it in the original app before clearing its retry.");
      db.prepare("DELETE FROM dohc_dataset_attempts WHERE rowid=?").run(row.rowid);
      return Number(row.storage_bytes);
    }
  }
}
export function initializeDatasetAttempts(db: JournalDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS dohc_dataset_attempts(
    workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,app_id TEXT NOT NULL,principal_key TEXT NOT NULL,operation_id TEXT NOT NULL,
    revision_sha256 TEXT NOT NULL,attempt_json TEXT NOT NULL,storage_bytes INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,dataset_id,app_id,principal_key,operation_id)) STRICT;`);
}
/** Runs within the same transaction as the source fence. Uncommitted uploads still belong to that source. */
export function assertDatasetAttemptsCommitted(db: JournalDb, scope: DatasetScope): void {
  let after = 0;
  for (;;) {
    const rows = db.prepare("SELECT rowid,* FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=? AND rowid>? ORDER BY rowid LIMIT 64").all(scope.workspaceId, scope.datasetId, after);
    if (!rows.length) return;
    for (const row of rows) {
      if (!committedAttempt(db, scope, row)) throw new Error("A submission is unconfirmed. Retry it in the current app before moving this Collection.");
      after = Number(row.rowid);
    }
  }
}
function sync<T>(run: () => T): T {
  if (run.constructor.name === "AsyncFunction") throw new Error("Pending submission callbacks must be synchronous.");
  const result = run();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Pending submission callbacks must be synchronous.");
  return result;
}

/** Scope and authorization come only from the trusted host, never from a browser payload. */
export function createDatasetAttempts(options: {
  db: JournalDb;
  transaction<T>(run: () => T): T;
  /** Charge positive/negative retained bytes in the same transaction. */
  account(scope: DatasetAttemptScope, bytes: number): void;
  maxAttemptsPerDataset?: number;
}) {
  const maximum = options.maxAttemptsPerDataset ?? 4096;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) throw new Error("Invalid pending submission bound.");
  const tx = <T>(run: () => T) => sync(() => options.transaction(() => sync(run)));
  tx(() => initializeDatasetAttempts(options.db));
  return {
    request(scope: DatasetAttemptScope, raw: unknown, authorize: () => void): DatasetAttemptResult {
      const request = parseDatasetAttemptRequest(raw);
      if ([scope.workspaceId, scope.datasetId, scope.appId, scope.principalKey, scope.operationId].some(part => typeof part !== "string" || !part || part.includes("\0") || Buffer.byteLength(part) > 1024) || !/^[a-f0-9]{64}$/.test(scope.revisionSha256)) throw new Error("Invalid pending submission scope.");
      const parameters = [scope.workspaceId, scope.datasetId, scope.appId, scope.principalKey, scope.operationId];
      return tx(() => {
        sync(authorize);
        const row = options.db.prepare("SELECT revision_sha256,attempt_json,storage_bytes FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=? AND app_id=? AND principal_key=? AND operation_id=?").get(...parameters);
        if (row && row.revision_sha256 !== scope.revisionSha256) throw new Error("The submission uses earlier Collection rules. Its outcome must be checked before starting another.");
        const existing = row ? parseDatasetAttemptResult(JSON.parse(String(row.attempt_json))) : { attempt: null };
        if (request.action === "get") { sync(authorize); return existing; }
        if (request.action === "clear") {
          if (existing.attempt && existing.attempt.token !== request.token) throw new Error("Another submission is waiting. Reload it before continuing.");
          if (row) { options.db.prepare("DELETE FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=? AND app_id=? AND principal_key=? AND operation_id=?").run(...parameters); sync(() => options.account(scope, -Number(row.storage_bytes))); }
          sync(authorize); return { attempt: null };
        }
        // The first tab wins. A second tab receives that exact attempt instead of replacing it.
        if (existing.attempt) { sync(authorize); return existing; }
        const count = Number(options.db.prepare("SELECT COUNT(*) AS count FROM dohc_dataset_attempts WHERE workspace_id=? AND dataset_id=?").get(scope.workspaceId, scope.datasetId)!.count);
        if (count >= maximum) throw new Error("This Collection has too many pending submissions. Try again later.");
        const result: DatasetAttemptResult = { attempt: { token: randomBytes(32).toString("base64url"), idempotencyKey: request.idempotencyKey, input: request.input } };
        const json = JSON.stringify(result), bytes = Buffer.byteLength(json) + parameters.reduce((sum, part) => sum + Buffer.byteLength(part), 0) + 512;
        options.db.prepare("INSERT INTO dohc_dataset_attempts VALUES(?,?,?,?,?,?,?,?)").run(...parameters, scope.revisionSha256, json, bytes);
        sync(() => options.account(scope, bytes)); sync(authorize); return result;
      });
    },
  };
}
