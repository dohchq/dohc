import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  LINKED_CHAT_STORE_RELATIVE_PATH,
  createAgentDispatchStore,
  type AgentDispatchStore,
  type AgentRunRecord,
} from "@dohc/workspace-engine";
import {
  APP_QUIT_EXIT_CODE,
  RUN_ID_LOG_TOKEN,
  type ChatDispatchRecovery,
} from "./chatDispatchService";

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen?: boolean;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDb;
}

export interface DesktopAgentDispatchStoreHandle {
  store: AgentDispatchStore;
  requeueFailedTrigger(input: {
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  }): boolean;
  listAppQuitRecoveries(workspaceId: string): ChatDispatchRecovery[];
  close(): void;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

function requireDispatchSchema(db: SqliteDb): void {
  for (const table of [
    "chat_dispatch_ledger",
    "agent_run_records",
    "run_message_links",
  ]) {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!row) {
      throw new Error(`Agent dispatch database is missing ${table}.`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent dispatch ${label} is corrupt.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(`Agent dispatch ${label} is corrupt.`);
  }
  return value;
}

export function createDesktopAgentDispatchStore(
  rootDir: string,
): DesktopAgentDispatchStoreHandle {
  const path = join(resolve(rootDir), LINKED_CHAT_STORE_RELATIVE_PATH);
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  requireDispatchSchema(db);

  let preparedRunId: string | null = null;
  const base = createAgentDispatchStore(db, {
    createRunId: () => {
      const runId = preparedRunId ?? `run_${randomUUID()}`;
      preparedRunId = null;
      return runId;
    },
  });
  const store: AgentDispatchStore = {
    ...base,
    claimNextPending(workspaceId, claimOptions = {}) {
      const runId = `run_${randomUUID()}`;
      preparedRunId = runId;
      try {
        return base.claimNextPending(workspaceId, {
          ...claimOptions,
          ...(claimOptions.logPath
            ? {
                logPath: claimOptions.logPath.replaceAll(
                  RUN_ID_LOG_TOKEN,
                  runId,
                ),
              }
            : {}),
        });
      } finally {
        preparedRunId = null;
      }
    },
  };

  return {
    store,
    requeueFailedTrigger(input) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = db
          .prepare(
            `SELECT ended_at_ms
             FROM agent_run_records
             WHERE workspace_id = ? AND run_id = ?`,
          )
          .get(input.workspaceId, input.runId);
        if (!run || run.ended_at_ms === null || run.ended_at_ms === undefined) {
          db.exec("ROLLBACK");
          return false;
        }
        const updated = db
          .prepare(
            `UPDATE chat_dispatch_ledger
             SET state = 'pending', run_id = NULL, updated_at_ms = ?
             WHERE workspace_id = ? AND trigger_message_id = ?
               AND state = 'failed' AND run_id = ? AND attempt_count < 2`,
          )
          .run(
            Date.now(),
            input.workspaceId,
            input.triggerMessageId,
            input.runId,
          );
        db.exec("COMMIT");
        return updated.changes === 1;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
    listAppQuitRecoveries(workspaceId) {
      const normalizedWorkspaceId = requiredString(
        workspaceId,
        "workspace id",
      );
      return db
        .prepare(
          `SELECT r.run_id, l.attempt_count
           FROM agent_run_records r
           JOIN chat_dispatch_ledger l
             ON l.workspace_id = r.workspace_id
            AND l.trigger_message_id = r.trigger_message_id
            AND l.run_id = r.run_id
           WHERE r.workspace_id = ?
             AND r.ended_at_ms IS NOT NULL
             AND r.exit_code = ?
             AND r.failure_note_posted = 0
             AND l.state = 'failed'
           ORDER BY r.started_at_ms, r.run_id`,
        )
        .all(normalizedWorkspaceId, APP_QUIT_EXIT_CODE)
        .map((row): ChatDispatchRecovery => {
          const runId = requiredString(row.run_id, "run id");
          const run: AgentRunRecord | null = store.getRunRecord(runId);
          if (!run || run.workspaceId !== normalizedWorkspaceId) {
            throw new Error("Agent dispatch app-quit recovery is corrupt.");
          }
          return {
            run,
            attemptCount: nonNegativeInteger(
              row.attempt_count,
              "attempt count",
            ),
          };
        });
    },
    close() {
      if (db.isOpen !== false) db.close();
    },
  };
}
