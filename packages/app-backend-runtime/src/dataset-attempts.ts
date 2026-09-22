import { randomBytes } from "node:crypto";
import { parseDatasetAttemptRequest, parseDatasetAttemptResult, type DatasetAttemptResult } from "@dohc/security-contract/dataset-attempts";
import type { JournalDb } from "./journal.js";

export interface DatasetAttemptScope {
  workspaceId: string; datasetId: string; appId: string; principalKey: string; operationId: string;
  revisionSha256: string;
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
