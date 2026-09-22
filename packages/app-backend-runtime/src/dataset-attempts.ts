import { randomBytes } from "node:crypto";
import { APP_BACKEND_INPUT_BYTES, parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { JournalDb } from "./journal.js";

export interface DatasetAttemptScope {
  workspaceId: string; datasetId: string; appId: string; principalKey: string; operationId: string;
  revisionSha256: string;
}
export interface DatasetPendingAttempt { token: string; idempotencyKey: string; input: AppBackendJson }
export type DatasetAttemptRequest = { action: "get" } | { action: "save"; idempotencyKey: string; input: AppBackendJson } | { action: "clear"; token: string };
export interface DatasetAttemptResult { attempt: DatasetPendingAttempt | null }
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function parseDatasetAttemptRequest(value: unknown): DatasetAttemptRequest {
  if (!isRecord(value)) throw new Error("Invalid pending submission request.");
  const keys = Object.keys(value).sort().join();
  if (value.action === "get" && keys === "action") return { action: "get" };
  if (value.action === "clear" && keys === "action,token" && typeof value.token === "string" && tokenPattern.test(value.token)) return { action: "clear", token: value.token };
  if (value.action === "save" && keys === "action,idempotencyKey,input" && typeof value.idempotencyKey === "string" && keyPattern.test(value.idempotencyKey)) return { action: "save", idempotencyKey: value.idempotencyKey, input: parseAppBackendJson(value.input, APP_BACKEND_INPUT_BYTES) };
  throw new Error("Invalid pending submission request.");
}
export function parseDatasetAttemptResult(value: unknown): DatasetAttemptResult {
  if (!isRecord(value) || Object.keys(value).join() !== "attempt") throw new Error("Invalid pending submission result.");
  if (value.attempt === null) return { attempt: null };
  const row = value.attempt;
  if (!isRecord(row) || Object.keys(row).sort().join() !== "idempotencyKey,input,token" || typeof row.token !== "string" || !tokenPattern.test(row.token)) throw new Error("Invalid pending submission result.");
  const input = parseDatasetAttemptRequest({ action: "save", idempotencyKey: row.idempotencyKey, input: row.input });
  if (input.action !== "save") throw new Error("Invalid pending submission result.");
  return { attempt: { token: row.token, idempotencyKey: input.idempotencyKey, input: input.input } };
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
  tx(() => options.db.exec(`CREATE TABLE IF NOT EXISTS dohc_dataset_attempts(
    workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,app_id TEXT NOT NULL,principal_key TEXT NOT NULL,operation_id TEXT NOT NULL,
    revision_sha256 TEXT NOT NULL,attempt_json TEXT NOT NULL,storage_bytes INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,dataset_id,app_id,principal_key,operation_id)) STRICT;`));
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
