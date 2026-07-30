import { randomUUID } from "node:crypto";
import { AgentDispatchStoreError } from "@dohc/workspace-contracts/engine";
import type {
  AgentDispatchClaim,
  AgentDispatchRecord,
  AgentDispatchState,
  AgentDispatchStore,
  AgentDispatchStoreErrorCode,
  AgentRunRecord,
  ThreadDispatchPauseState,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import type { EngineSqliteDb } from "./engineDbSchema";

export type {
  AgentDispatchClaim,
  AgentDispatchRecord,
  AgentDispatchState,
  AgentDispatchStore,
  AgentDispatchStoreErrorCode,
  AgentRunRecord,
  ThreadDispatchPauseState,
} from "@dohc/workspace-contracts/engine";

export { AgentDispatchStoreError } from "@dohc/workspace-contracts/engine";

export interface AgentDispatchStoreOptions {
  nowMs?: () => number;
  createRunId?: () => string;
}

function invalidInput(message: string): AgentDispatchStoreError {
  return new AgentDispatchStoreError("invalid-input", message);
}

function corruptStore(cause?: unknown): AgentDispatchStoreError {
  const error = new AgentDispatchStoreError("state-corrupt", "Agent dispatch store is corrupt.");
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function normalizeRequiredId(value: string, label: string): string {
  if (typeof value !== "string") throw invalidInput(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || normalized.includes("\u0000")) {
    throw invalidInput(`${label} is invalid.`);
  }
  return normalized;
}

function normalizeWorkspaceId(value: WorkspaceId): WorkspaceId {
  return normalizeRequiredId(value, "Workspace id");
}

function normalizeOptionalVerifiedUserId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\u0000")) {
    throw invalidInput("Verified user id is invalid.");
  }
  return value;
}

function normalizeCommand(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw invalidInput("Runner command is invalid.");
  }
  return value;
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) {
    throw invalidInput("Run log path is invalid.");
  }
  return value;
}

function normalizeExitCode(value: number): number {
  if (!Number.isSafeInteger(value)) throw invalidInput("Run exit code must be an integer.");
  return value;
}

function normalizeOptionalExitCode(value: number | undefined): number | undefined {
  return value === undefined ? undefined : normalizeExitCode(value);
}

function normalizeFailureReason(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
    throw invalidInput("Run failure reason is invalid.");
  }
  return value;
}

function normalizeSinceMs(value: number): number {
  if (!Number.isFinite(value)) throw invalidInput("Dispatch window start must be finite.");
  return value;
}

function normalizeOptionalRunLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidInput("Run record limit must be a positive integer.");
  }
  return value;
}

function normalizePaused(value: boolean): boolean {
  if (typeof value !== "boolean") throw invalidInput("Dispatch pause state must be boolean.");
  return value;
}

function normalizeNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput("Dispatch timestamp must be a non-negative integer.");
  }
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw corruptStore();
  return value;
}

function integerValue(value: unknown): number {
  const number = numberValue(value);
  if (!Number.isSafeInteger(number)) throw corruptStore();
  return number;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return integerValue(value);
}

function timestampValue(value: unknown): number {
  const timestamp = integerValue(value);
  if (timestamp < 0) throw corruptStore();
  return timestamp;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return timestampValue(value);
}

function booleanValue(value: unknown): boolean {
  const number = integerValue(value);
  if (number !== 0 && number !== 1) throw corruptStore();
  return number === 1;
}

function dispatchStateValue(value: unknown): AgentDispatchState {
  const state = stringValue(value);
  if (state !== "pending" && state !== "running" && state !== "done" && state !== "failed") {
    throw corruptStore();
  }
  return state;
}

function dispatchFromRow(row: Record<string, unknown>): AgentDispatchRecord {
  const state = dispatchStateValue(row.state);
  const runId = optionalString(row.run_id);
  const failureReason = optionalString(row.failure_reason);
  const attemptCount = integerValue(row.attempt_count);
  if (attemptCount < 0) throw corruptStore();
  if (state === "pending" && runId !== undefined) throw corruptStore();
  if ((state === "running" || state === "done") && (runId === undefined || attemptCount === 0)) {
    throw corruptStore();
  }
  // A pending trigger can fail before a process exists (for example, when no
  // runner is configured). Those terminal rows deliberately have no run id.
  if (state === "failed" && runId !== undefined && attemptCount === 0) {
    throw corruptStore();
  }
  if (state !== "failed" && failureReason !== undefined) throw corruptStore();
  if (failureReason !== undefined && !failureReason.trim()) throw corruptStore();
  return {
    workspaceId: stringValue(row.workspace_id),
    triggerMessageId: stringValue(row.trigger_message_id),
    threadId: stringValue(row.thread_id),
    state,
    ...(runId !== undefined ? { runId } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    attemptCount,
    createdAtMs: timestampValue(row.created_at_ms),
    updatedAtMs: timestampValue(row.updated_at_ms),
  };
}

function runFromRow(row: Record<string, unknown>): AgentRunRecord {
  const endedAtMs = optionalTimestamp(row.ended_at_ms);
  const exitCode = optionalInteger(row.exit_code);
  const failureReason = optionalString(row.failure_reason);
  const logPath = optionalString(row.log_path);
  if (endedAtMs === undefined && exitCode !== undefined) throw corruptStore();
  if (endedAtMs === undefined && failureReason !== undefined) throw corruptStore();
  if (failureReason !== undefined && !failureReason.trim()) throw corruptStore();
  return {
    workspaceId: stringValue(row.workspace_id),
    runId: stringValue(row.run_id),
    threadId: stringValue(row.thread_id),
    triggerMessageId: stringValue(row.trigger_message_id),
    command: stringValue(row.command),
    startedAtMs: timestampValue(row.started_at_ms),
    ...(endedAtMs !== undefined ? { endedAtMs } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
    failureNotePosted: booleanValue(row.failure_note_posted),
  };
}

function pauseStateFromRow(row: Record<string, unknown>): ThreadDispatchPauseState {
  const reason = optionalString(row.reason);
  const paused = booleanValue(row.paused);
  if (reason !== undefined && !reason.trim()) throw corruptStore();
  if (!paused && reason !== undefined) throw corruptStore();
  return {
    workspaceId: stringValue(row.workspace_id),
    threadId: stringValue(row.thread_id),
    paused,
    ...(reason !== undefined ? { reason } : {}),
    updatedAtMs: timestampValue(row.updated_at_ms),
  };
}

function runRowsById(db: EngineSqliteDb, runId: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM agent_run_records WHERE run_id = ?").all(runId);
}

function requireRunById(db: EngineSqliteDb, runId: string): AgentRunRecord {
  const rows = runRowsById(db, runId);
  if (rows.length === 0) {
    throw new AgentDispatchStoreError("run-not-found", `Agent run ${runId} was not found.`);
  }
  if (rows.length !== 1) throw corruptStore();
  return runFromRow(rows[0]);
}

function ledgerForRun(db: EngineSqliteDb, run: AgentRunRecord): AgentDispatchRecord {
  const row = db
    .prepare(
      `SELECT * FROM chat_dispatch_ledger
       WHERE workspace_id = ? AND trigger_message_id = ?`,
    )
    .get(run.workspaceId, run.triggerMessageId);
  if (!row) throw corruptStore();
  const dispatch = dispatchFromRow(row);
  if (dispatch.threadId !== run.threadId || dispatch.runId !== run.runId) throw corruptStore();
  return dispatch;
}

function claimFromRows(
  dispatchRow: Record<string, unknown>,
  runRow: Record<string, unknown>,
): AgentDispatchClaim {
  const dispatch = dispatchFromRow(dispatchRow);
  const run = runFromRow(runRow);
  if (
    dispatch.workspaceId !== run.workspaceId ||
    dispatch.threadId !== run.threadId ||
    dispatch.triggerMessageId !== run.triggerMessageId ||
    dispatch.runId !== run.runId ||
    dispatch.state !== "running" ||
    run.endedAtMs !== undefined
  ) {
    throw corruptStore();
  }
  return { dispatch, run };
}

function defaultCreateRunId(): string {
  return `run_${randomUUID()}`;
}

export function createAgentDispatchStore(
  db: EngineSqliteDb,
  options: AgentDispatchStoreOptions = {},
): AgentDispatchStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const createRunId = options.createRunId ?? defaultCreateRunId;

  function timestamp(): number {
    return normalizeNowMs(nowMs());
  }

  function withImmediateTransaction<T>(task: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = task();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  function freshRunId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runId = normalizeRequiredId(createRunId(), "Run id");
      if (runRowsById(db, runId).length === 0) return runId;
    }
    throw new AgentDispatchStoreError("state-corrupt", "Could not allocate a fresh run id.");
  }

  function assertOpenRunsSane(workspaceId: WorkspaceId): AgentDispatchClaim[] {
    const dispatchRows = db
      .prepare(
        `SELECT * FROM chat_dispatch_ledger
         WHERE workspace_id = ? AND state = 'running'
         ORDER BY updated_at_ms, trigger_message_id`,
      )
      .all(workspaceId);
    const claims = dispatchRows.map((dispatchRow) => {
      const runId = optionalString(dispatchRow.run_id);
      if (runId === undefined) throw corruptStore();
      const runRows = db
        .prepare(
          `SELECT * FROM agent_run_records
           WHERE workspace_id = ? AND run_id = ? AND ended_at_ms IS NULL`,
        )
        .all(workspaceId, runId);
      if (runRows.length !== 1) throw corruptStore();
      return claimFromRows(dispatchRow, runRows[0]);
    });
    const unmatched = db
      .prepare(
        `SELECT 1
         FROM agent_run_records r
         LEFT JOIN chat_dispatch_ledger l
           ON l.workspace_id = r.workspace_id
          AND l.trigger_message_id = r.trigger_message_id
         WHERE r.workspace_id = ?
           AND r.ended_at_ms IS NULL
           AND (l.trigger_message_id IS NULL OR l.state <> 'running' OR l.run_id <> r.run_id)
         LIMIT 1`,
      )
      .get(workspaceId);
    if (unmatched) throw corruptStore();
    return claims;
  }

  return {
    recordEligibleTriggers(input) {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const verifiedUserId = normalizeOptionalVerifiedUserId(input.verifiedUserId);
      const atMs = timestamp();
      return withImmediateTransaction(() => {
        const cursorRow = db
          .prepare(
            `SELECT max_created_at_ms
             FROM chat_dispatch_scan_cursor
             WHERE workspace_id = ?`,
          )
          .get(workspaceId);
        const maxCreatedAtMs = cursorRow
          ? timestampValue(cursorRow.max_created_at_ms)
          : undefined;
        // Keep a one-millisecond overlap. Chat timestamps are integer
        // milliseconds, so this rechecks every row tied at the high-water mark
        // while the ledger's primary key keeps the scan idempotent.
        const scanAfterMs = maxCreatedAtMs === undefined
          ? -1
          : Math.max(-1, maxCreatedAtMs - 1);
        const recorded = db
          .prepare(
            `INSERT OR IGNORE INTO chat_dispatch_ledger (
               workspace_id, trigger_message_id, thread_id, state, run_id,
               attempt_count, created_at_ms, updated_at_ms
             )
             SELECT m.workspace_id, m.message_id, m.thread_id, 'pending', NULL,
                    0, m.created_at_ms, ?
             FROM chat_messages m
             JOIN chat_threads t
               ON t.workspace_id = m.workspace_id
              AND t.thread_id = m.thread_id
             LEFT JOIN chat_channels c
               ON c.workspace_id = t.workspace_id
              AND c.channel_id = t.channel_id
             LEFT JOIN chat_dispatch_ledger ledger
               ON ledger.workspace_id = m.workspace_id
              AND ledger.trigger_message_id = m.message_id
             WHERE m.workspace_id = ?
               AND m.created_at_ms > ?
               AND ledger.trigger_message_id IS NULL
               AND (
                 c.kind = 'agent'
                 OR EXISTS (
                   SELECT 1
                   FROM chat_mentions mention
                   WHERE mention.workspace_id = m.workspace_id
                     AND mention.message_id = m.message_id
                     AND mention.handle = 'agent'
                 )
               )
               AND m.author_kind = 'human'
               AND COALESCE(m.origin, '') <> 'cli'
               AND (
                 m.author_user_id IS NULL
                 OR (? IS NOT NULL AND m.author_user_id = ?)
               )`,
          )
          .run(
            atMs,
            workspaceId,
            scanAfterMs,
            verifiedUserId ?? null,
            verifiedUserId ?? null,
          );
        const scanned = db
          .prepare(
            `SELECT MAX(m.created_at_ms) AS max_created_at_ms
             FROM chat_messages m
             WHERE m.workspace_id = ?
               AND m.created_at_ms > ?`,
          )
          .get(workspaceId, scanAfterMs);
        const scannedMax = optionalTimestamp(scanned?.max_created_at_ms);
        if (scannedMax !== undefined) {
          db.prepare(
            `INSERT INTO chat_dispatch_scan_cursor (
               workspace_id, max_created_at_ms, updated_at_ms
             ) VALUES (?, ?, ?)
             ON CONFLICT(workspace_id) DO UPDATE SET
               max_created_at_ms = MAX(
                 chat_dispatch_scan_cursor.max_created_at_ms,
                 excluded.max_created_at_ms
               ),
               updated_at_ms = excluded.updated_at_ms`,
          ).run(workspaceId, scannedMax, atMs);
        }
        return recorded.changes;
      });
    },

    recordTrigger(input) {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const triggerMessageId = normalizeRequiredId(input.triggerMessageId, "Trigger message id");
      const threadId = normalizeRequiredId(input.threadId, "Thread id");
      const atMs = timestamp();
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO chat_dispatch_ledger (
             workspace_id, trigger_message_id, thread_id, state, run_id,
             attempt_count, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'pending', NULL, 0, ?, ?)`,
        )
        .run(workspaceId, triggerMessageId, threadId, atMs, atMs);
      if (result.changes === 1) return true;
      const existing = db
        .prepare(
          `SELECT * FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(workspaceId, triggerMessageId);
      if (!existing || dispatchFromRow(existing).threadId !== threadId) throw corruptStore();
      return false;
    },

    /** Covered triggers stay done if the primary run fails; a retry repacks the whole thread. */
    claimNextPending(workspaceIdInput, claimOptions = {}) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      const command = normalizeCommand(claimOptions.command);
      const logPath = normalizeOptionalPath(claimOptions.logPath);
      return withImmediateTransaction(() => {
        if (assertOpenRunsSane(workspaceId).length > 0) return null;
        const dispatchRow = db
          .prepare(
            `SELECT l.*
             FROM chat_dispatch_ledger l
             WHERE l.workspace_id = ?
               AND l.state = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM chat_dispatch_pause p
                 WHERE p.workspace_id = l.workspace_id
                   AND p.thread_id = l.thread_id
                   AND p.paused = 1
               )
             ORDER BY l.created_at_ms, l.trigger_message_id
             LIMIT 1`,
          )
          .get(workspaceId);
        if (!dispatchRow) return null;
        const pending = dispatchFromRow(dispatchRow);
        if (pending.state !== "pending") throw corruptStore();
        const runId = freshRunId();
        const startedAtMs = timestamp();
        const updated = db
          .prepare(
            `UPDATE chat_dispatch_ledger
             SET state = 'running', run_id = ?, attempt_count = attempt_count + 1,
                 updated_at_ms = ?
             WHERE workspace_id = ? AND trigger_message_id = ? AND state = 'pending'`,
          )
          .run(runId, startedAtMs, workspaceId, pending.triggerMessageId);
        if (updated.changes !== 1) throw corruptStore();
        // The runner prompt contains the complete thread. Cover every trigger
        // that was pending in this thread when the claim was made so one
        // process handles the whole visible request. A later message is not
        // part of this transaction and remains pending for a follow-up run.
        db.prepare(
          `UPDATE chat_dispatch_ledger
           SET state = 'done', run_id = ?, attempt_count = attempt_count + 1,
               updated_at_ms = ?
           WHERE workspace_id = ? AND thread_id = ? AND state = 'pending'`,
        ).run(runId, startedAtMs, workspaceId, pending.threadId);
        db.prepare(
          `INSERT INTO agent_run_records (
             workspace_id, run_id, thread_id, trigger_message_id, command,
             started_at_ms, ended_at_ms, exit_code, failure_reason, log_path,
             failure_note_posted
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0)`,
        ).run(
          workspaceId,
          runId,
          pending.threadId,
          pending.triggerMessageId,
          command,
          startedAtMs,
          logPath ?? null,
        );
        const claimedDispatch = db
          .prepare(
            `SELECT * FROM chat_dispatch_ledger
             WHERE workspace_id = ? AND trigger_message_id = ?`,
          )
          .get(workspaceId, pending.triggerMessageId);
        const runRow = db
          .prepare(
            `SELECT * FROM agent_run_records
             WHERE workspace_id = ? AND run_id = ?`,
          )
          .get(workspaceId, runId);
        if (!claimedDispatch || !runRow) throw corruptStore();
        return claimFromRows(claimedDispatch, runRow);
      });
    },

    failPendingForThread(input) {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const threadId = normalizeRequiredId(input.threadId, "Thread id");
      // Failure text belongs in the caller's durable service note, matching
      // failRun. The ledger records the terminal fact without fabricating an
      // agent_run_records row for a process that never existed.
      const failureReason = normalizeFailureReason(input.reason);
      return withImmediateTransaction(
        () =>
          db
            .prepare(
              `UPDATE chat_dispatch_ledger
             SET state = 'failed', failure_reason = ?, updated_at_ms = ?
             WHERE workspace_id = ? AND thread_id = ? AND state = 'pending'`,
            )
            .run(failureReason, timestamp(), workspaceId, threadId).changes,
      );
    },

    completeRun(input) {
      const runId = normalizeRequiredId(input.runId, "Run id");
      const exitCode = normalizeExitCode(input.exitCode);
      return withImmediateTransaction(() => {
        const current = requireRunById(db, runId);
        const dispatch = ledgerForRun(db, current);
        if (current.endedAtMs !== undefined) {
          if (dispatch.state === "done") return current;
          throw new AgentDispatchStoreError(
            "run-state-mismatch",
            `Agent run ${runId} is already ${dispatch.state}.`,
          );
        }
        if (dispatch.state !== "running") throw corruptStore();
        const endedAtMs = timestamp();
        const runUpdate = db
          .prepare(
            `UPDATE agent_run_records
             SET ended_at_ms = ?, exit_code = ?
             WHERE workspace_id = ? AND run_id = ? AND ended_at_ms IS NULL`,
          )
          .run(endedAtMs, exitCode, current.workspaceId, runId);
        const ledgerUpdate = db
          .prepare(
            `UPDATE chat_dispatch_ledger
             SET state = 'done', updated_at_ms = ?
             WHERE workspace_id = ? AND trigger_message_id = ?
               AND state = 'running' AND run_id = ?`,
          )
          .run(endedAtMs, current.workspaceId, current.triggerMessageId, runId);
        if (runUpdate.changes !== 1 || ledgerUpdate.changes !== 1) throw corruptStore();
        return requireRunById(db, runId);
      });
    },

    failRun(input) {
      const runId = normalizeRequiredId(input.runId, "Run id");
      const exitCode = normalizeOptionalExitCode(input.exitCode);
      // Failure text belongs in the caller's durable chat note; the private
      // run table stores terminal metadata and a log path, never raw output.
      const failureReason = normalizeFailureReason(input.reason);
      return withImmediateTransaction(() => {
        const current = requireRunById(db, runId);
        const dispatch = ledgerForRun(db, current);
        if (current.endedAtMs !== undefined) {
          if (dispatch.state === "failed") return current;
          throw new AgentDispatchStoreError(
            "run-state-mismatch",
            `Agent run ${runId} is already ${dispatch.state}.`,
          );
        }
        if (dispatch.state !== "running") throw corruptStore();
        const endedAtMs = timestamp();
        const runUpdate = db
          .prepare(
            `UPDATE agent_run_records
             SET ended_at_ms = ?, exit_code = ?, failure_reason = ?
             WHERE workspace_id = ? AND run_id = ? AND ended_at_ms IS NULL`,
          )
          .run(
            endedAtMs,
            exitCode ?? null,
            failureReason,
            current.workspaceId,
            runId,
          );
        const ledgerUpdate = db
          .prepare(
            `UPDATE chat_dispatch_ledger
             SET state = 'failed', failure_reason = ?, updated_at_ms = ?
             WHERE workspace_id = ? AND trigger_message_id = ?
               AND state = 'running' AND run_id = ?`,
          )
          .run(
            failureReason,
            endedAtMs,
            current.workspaceId,
            current.triggerMessageId,
            runId,
          );
        if (runUpdate.changes !== 1 || ledgerUpdate.changes !== 1) throw corruptStore();
        return requireRunById(db, runId);
      });
    },

    listPending(workspaceIdInput) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      return db
        .prepare(
          `SELECT * FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND state = 'pending'
           ORDER BY created_at_ms, trigger_message_id`,
        )
        .all(workspaceId)
        .map(dispatchFromRow);
    },

    openRuns(workspaceIdInput) {
      return assertOpenRunsSane(normalizeWorkspaceId(workspaceIdInput));
    },

    markFailureNotePosted(runIdInput) {
      const runId = normalizeRequiredId(runIdInput, "Run id");
      const run = requireRunById(db, runId);
      if (run.failureNotePosted) return run;
      const result = db
        .prepare(
          `UPDATE agent_run_records
           SET failure_note_posted = 1
           WHERE workspace_id = ? AND run_id = ? AND failure_note_posted = 0`,
        )
        .run(run.workspaceId, runId);
      if (result.changes !== 1) throw corruptStore();
      return requireRunById(db, runId);
    },

    recentDispatchCount(input) {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const threadId = normalizeRequiredId(input.threadId, "Thread id");
      const sinceMs = normalizeSinceMs(input.sinceMs);
      const row = db
        .prepare(
          `SELECT COUNT(*) AS dispatch_count
           FROM agent_run_records
           WHERE workspace_id = ? AND thread_id = ? AND started_at_ms >= ?`,
        )
        .get(workspaceId, threadId, sinceMs);
      const count = integerValue(row?.dispatch_count);
      if (count < 0) throw corruptStore();
      return count;
    },

    recordRunMessage(input) {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const messageId = normalizeRequiredId(input.messageId, "Message id");
      const runId = normalizeRequiredId(input.runId, "Run id");
      const run = requireRunById(db, runId);
      if (run.workspaceId !== workspaceId) {
        throw new AgentDispatchStoreError(
          "run-not-found",
          `Agent run ${runId} was not found in workspace ${workspaceId}.`,
        );
      }
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO run_message_links (
             workspace_id, message_id, run_id
           ) VALUES (?, ?, ?)`,
        )
        .run(workspaceId, messageId, runId);
      if (result.changes === 1) return true;
      const existing = db
        .prepare(
          `SELECT run_id FROM run_message_links
           WHERE workspace_id = ? AND message_id = ?`,
        )
        .get(workspaceId, messageId);
      if (!existing || stringValue(existing.run_id) !== runId) throw corruptStore();
      return false;
    },

    listRunMessages(workspaceIdInput, runIdInput) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      const runId = normalizeRequiredId(runIdInput, "Run id");
      return db
        .prepare(
          `SELECT message_id FROM run_message_links
           WHERE workspace_id = ? AND run_id = ?
           ORDER BY message_id`,
        )
        .all(workspaceId, runId)
        .map((row) => stringValue(row.message_id));
    },

    runIdForMessage(workspaceIdInput, messageIdInput) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      const messageId = normalizeRequiredId(messageIdInput, "Message id");
      const row = db
        .prepare(
          `SELECT run_id FROM run_message_links
           WHERE workspace_id = ? AND message_id = ?`,
        )
        .get(workspaceId, messageId);
      return row ? stringValue(row.run_id) : null;
    },

    runRecordsForThread(workspaceIdInput, threadIdInput, options = {}) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      const threadId = normalizeRequiredId(threadIdInput, "Thread id");
      const limit = normalizeOptionalRunLimit(options.limit);
      const rows = db
        .prepare(
          `${limit === undefined ? "" : `WITH recent_runs AS (
             SELECT * FROM agent_run_records
             WHERE workspace_id = ? AND thread_id = ?
             ORDER BY started_at_ms DESC, run_id DESC
             LIMIT ?
           )`}
           SELECT links.message_id AS linked_message_id, runs.*
           FROM run_message_links links
           JOIN ${limit === undefined ? "agent_run_records" : "recent_runs"} runs
             ON runs.workspace_id = links.workspace_id
            AND runs.run_id = links.run_id
           WHERE runs.workspace_id = ? AND runs.thread_id = ?
           ORDER BY runs.started_at_ms DESC, runs.run_id DESC, links.message_id`,
        )
        .all(
          ...(limit === undefined
            ? [workspaceId, threadId]
            : [workspaceId, threadId, limit, workspaceId, threadId]),
        );
      return Object.fromEntries(
        rows.map((row) => [stringValue(row.linked_message_id), runFromRow(row)]),
      );
    },

    getRunRecord(runIdInput) {
      const runId = normalizeRequiredId(runIdInput, "Run id");
      const rows = runRowsById(db, runId);
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw corruptStore();
      return runFromRow(rows[0]);
    },

    setThreadDispatchPaused(input) {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const threadId = normalizeRequiredId(input.threadId, "Thread id");
      const paused = normalizePaused(input.paused);
      const reason = paused
        ? input.reason === undefined
          ? undefined
          : normalizeFailureReason(input.reason)
        : undefined;
      const updatedAtMs = timestamp();
      db.prepare(
        `INSERT INTO chat_dispatch_pause (
           workspace_id, thread_id, paused, reason, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, thread_id) DO UPDATE SET
           paused = excluded.paused,
           reason = excluded.reason,
           updated_at_ms = excluded.updated_at_ms`,
      ).run(workspaceId, threadId, paused ? 1 : 0, reason ?? null, updatedAtMs);
      const row = db
        .prepare(
          `SELECT * FROM chat_dispatch_pause
           WHERE workspace_id = ? AND thread_id = ?`,
        )
        .get(workspaceId, threadId);
      if (!row) throw corruptStore();
      return pauseStateFromRow(row);
    },

    threadDispatchPaused(workspaceIdInput, threadIdInput) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      const threadId = normalizeRequiredId(threadIdInput, "Thread id");
      const row = db
        .prepare(
          `SELECT * FROM chat_dispatch_pause
           WHERE workspace_id = ? AND thread_id = ?`,
        )
        .get(workspaceId, threadId);
      return row ? pauseStateFromRow(row).paused : false;
    },

    getThreadDispatchPauseState(workspaceIdInput, threadIdInput) {
      const workspaceId = normalizeWorkspaceId(workspaceIdInput);
      const threadId = normalizeRequiredId(threadIdInput, "Thread id");
      const row = db
        .prepare(
          `SELECT * FROM chat_dispatch_pause
           WHERE workspace_id = ? AND thread_id = ?`,
        )
        .get(workspaceId, threadId);
      return row ? pauseStateFromRow(row) : null;
    },
  };
}
