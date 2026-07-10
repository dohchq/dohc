import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDispatchStoreError, createAgentDispatchStore } from "./agentDispatchStore";
import { createEngineSchema, type EngineSqliteDb } from "./engineDbSchema";

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => EngineSqliteDb;
};

const WORKSPACE_ID = "workspace-a";

let root: string;
const databases: EngineSqliteDb[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-agent-dispatch-"));
});

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await rm(root, { recursive: true, force: true });
});

function database(path = ":memory:"): EngineSqliteDb {
  const db = new DatabaseSync(path);
  databases.push(db);
  createEngineSchema(db);
  return db;
}

function ledgerState(db: EngineSqliteDb, triggerMessageId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT state FROM chat_dispatch_ledger
       WHERE workspace_id = ? AND trigger_message_id = ?`,
    )
    .get(WORKSPACE_ID, triggerMessageId);
  return row ? String(row.state) : undefined;
}

describe("agent dispatch store", () => {
  it("records each trigger once and keeps pending rows in deterministic FIFO order", () => {
    const db = database();
    let now = 1000;
    const store = createAgentDispatchStore(db, { nowMs: () => now });

    expect(
      store.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: "message-b",
        threadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      store.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: "message-b",
        threadId: "thread-1",
      }),
    ).toBe(false);
    now = 900;
    expect(
      store.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: "message-a",
        threadId: "thread-1",
      }),
    ).toBe(true);

    expect(store.listPending(WORKSPACE_ID)).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: "message-a",
        threadId: "thread-1",
        state: "pending",
        attemptCount: 0,
        createdAtMs: 900,
        updatedAtMs: 900,
      },
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: "message-b",
        threadId: "thread-1",
        state: "pending",
        attemptCount: 0,
        createdAtMs: 1000,
        updatedAtMs: 1000,
      },
    ]);
  });

  it("claims once atomically and exposes the running pair for startup sweep", () => {
    const path = join(root, "dispatch.db");
    const firstDb = database(path);
    const secondDb = new DatabaseSync(path);
    databases.push(secondDb);
    secondDb.exec("PRAGMA busy_timeout = 5000");
    let now = 1000;
    let nextRun = 0;
    const options = {
      nowMs: () => now,
      createRunId: () => `run-${(nextRun += 1)}`,
    };
    const first = createAgentDispatchStore(firstDb, options);
    const second = createAgentDispatchStore(secondDb, options);
    first.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-1",
      threadId: "thread-1",
    });

    now = 1100;
    const claim = first.claimNextPending(WORKSPACE_ID, {
      command: "codex exec",
      logPath: "/private/runs/run-1.log",
    });
    expect(claim).toEqual({
      dispatch: {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: "message-1",
        threadId: "thread-1",
        state: "running",
        runId: "run-1",
        attemptCount: 1,
        createdAtMs: 1000,
        updatedAtMs: 1100,
      },
      run: {
        workspaceId: WORKSPACE_ID,
        runId: "run-1",
        threadId: "thread-1",
        triggerMessageId: "message-1",
        command: "codex exec",
        startedAtMs: 1100,
        logPath: "/private/runs/run-1.log",
        failureNotePosted: false,
      },
    });
    expect(second.claimNextPending(WORKSPACE_ID)).toBeNull();
    expect(second.openRuns(WORKSPACE_ID)).toEqual([claim]);

    expect(first.markFailureNotePosted("run-1").failureNotePosted).toBe(true);
    expect(second.markFailureNotePosted("run-1").failureNotePosted).toBe(true);
  });

  it("atomically covers every currently-pending trigger in the claimed thread", () => {
    const db = database();
    let now = 1000;
    const store = createAgentDispatchStore(db, {
      nowMs: () => now,
      createRunId: () => "run-thread",
    });
    for (const triggerMessageId of ["message-1", "message-2", "message-3"]) {
      store.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: "thread-1",
      });
    }
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-other",
      threadId: "thread-2",
    });

    now = 1100;
    const claim = store.claimNextPending(WORKSPACE_ID);
    expect(claim?.dispatch.triggerMessageId).toBe("message-1");
    expect(store.listPending(WORKSPACE_ID).map((row) => row.triggerMessageId)).toEqual([
      "message-other",
    ]);
    expect(
      db
        .prepare(
          `SELECT trigger_message_id, state, run_id
           FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND thread_id = ?
           ORDER BY trigger_message_id`,
        )
        .all(WORKSPACE_ID, "thread-1"),
    ).toEqual([
      {
        trigger_message_id: "message-1",
        state: "running",
        run_id: "run-thread",
      },
      { trigger_message_id: "message-2", state: "done", run_id: "run-thread" },
      { trigger_message_id: "message-3", state: "done", run_id: "run-thread" },
    ]);
  });

  it("keeps covered triggers done when the primary trigger's run fails", () => {
    const db = database();
    const store = createAgentDispatchStore(db, {
      nowMs: () => 1000,
      createRunId: () => "run-failed-thread",
    });
    for (const triggerMessageId of [
      "message-primary",
      "message-secondary-a",
      "message-secondary-b",
    ]) {
      store.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: "thread-1",
      });
    }

    const claim = store.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected the thread dispatch claim.");
    store.failRun({ runId: claim.run.runId, reason: "runner failed" });

    expect(
      db
        .prepare(
          `SELECT trigger_message_id, state, run_id
           FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND thread_id = ?
           ORDER BY trigger_message_id`,
        )
        .all(WORKSPACE_ID, "thread-1"),
    ).toEqual([
      {
        trigger_message_id: "message-primary",
        state: "failed",
        run_id: "run-failed-thread",
      },
      {
        trigger_message_id: "message-secondary-a",
        state: "done",
        run_id: "run-failed-thread",
      },
      {
        trigger_message_id: "message-secondary-b",
        state: "done",
        run_id: "run-failed-thread",
      },
    ]);
  });

  it("fails pending triggers without fabricating a run record", () => {
    const db = database();
    const store = createAgentDispatchStore(db, { nowMs: () => 1200 });
    for (const triggerMessageId of ["message-1", "message-2"]) {
      store.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: "thread-no-runner",
      });
    }

    expect(
      store.failPendingForThread({
        workspaceId: WORKSPACE_ID,
        threadId: "thread-no-runner",
        reason: "no-runner",
      }),
    ).toBe(2);
    expect(store.listPending(WORKSPACE_ID)).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT state, run_id, failure_reason FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND thread_id = ?
           ORDER BY trigger_message_id`,
        )
        .all(WORKSPACE_ID, "thread-no-runner"),
    ).toEqual([
      { state: "failed", run_id: null, failure_reason: "no-runner" },
      { state: "failed", run_id: null, failure_reason: "no-runner" },
    ]);
    expect(db.prepare("SELECT * FROM agent_run_records").all()).toEqual([]);
  });

  it("completes and fails runs with matching ledger transitions", () => {
    const db = database();
    let now = 1000;
    let nextRun = 0;
    const store = createAgentDispatchStore(db, {
      nowMs: () => now,
      createRunId: () => `run-${(nextRun += 1)}`,
    });
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-complete",
      threadId: "thread-1",
    });
    const completedClaim = store.claimNextPending(WORKSPACE_ID);
    if (!completedClaim) throw new Error("Expected the first dispatch claim.");
    expect(completedClaim.run.command).toBe("");
    expect(completedClaim.run.logPath).toBeUndefined();

    now = 1200;
    expect(store.completeRun({ runId: completedClaim.run.runId, exitCode: 0 })).toEqual({
      ...completedClaim.run,
      endedAtMs: 1200,
      exitCode: 0,
    });
    expect(ledgerState(db, "message-complete")).toBe("done");
    expect(store.openRuns(WORKSPACE_ID)).toEqual([]);

    now = 1300;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-fail",
      threadId: "thread-1",
    });
    const failedClaim = store.claimNextPending(WORKSPACE_ID);
    if (!failedClaim) throw new Error("Expected the second dispatch claim.");
    now = 1400;
    expect(
      store.failRun({
        runId: failedClaim.run.runId,
        exitCode: 9,
        reason: "runner exited before reporting",
      }),
    ).toEqual({
      ...failedClaim.run,
      endedAtMs: 1400,
      exitCode: 9,
      failureReason: "runner exited before reporting",
    });
    expect(ledgerState(db, "message-fail")).toBe("failed");
    expect(store.getRunRecord(failedClaim.run.runId)).toEqual({
      ...failedClaim.run,
      endedAtMs: 1400,
      exitCode: 9,
      failureReason: "runner exited before reporting",
    });
  });

  it("counts dispatch starts in the requested thread and rolling window", () => {
    const db = database();
    let now = 1000;
    let nextRun = 0;
    const store = createAgentDispatchStore(db, {
      nowMs: () => now,
      createRunId: () => `run-${(nextRun += 1)}`,
    });

    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-1",
      threadId: "thread-1",
    });
    const first = store.claimNextPending(WORKSPACE_ID);
    if (!first) throw new Error("Expected first run.");
    store.completeRun({ runId: first.run.runId, exitCode: 0 });

    now = 2000;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-2",
      threadId: "thread-1",
    });
    const second = store.claimNextPending(WORKSPACE_ID);
    if (!second) throw new Error("Expected second run.");
    store.completeRun({ runId: second.run.runId, exitCode: 0 });

    now = 3000;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-other-thread",
      threadId: "thread-2",
    });
    const third = store.claimNextPending(WORKSPACE_ID);
    if (!third) throw new Error("Expected third run.");

    expect(
      store.recentDispatchCount({
        workspaceId: WORKSPACE_ID,
        threadId: "thread-1",
        sinceMs: 0,
      }),
    ).toBe(2);
    expect(
      store.recentDispatchCount({
        workspaceId: WORKSPACE_ID,
        threadId: "thread-1",
        sinceMs: 1500,
      }),
    ).toBe(1);
    expect(
      store.recentDispatchCount({
        workspaceId: WORKSPACE_ID,
        threadId: "thread-2",
        sinceMs: 2500,
      }),
    ).toBe(1);
  });

  it("links report messages to a known run locally and idempotently", () => {
    const db = database();
    let nextRun = 0;
    const store = createAgentDispatchStore(db, {
      createRunId: () => `run-${(nextRun += 1)}`,
    });
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-trigger-1",
      threadId: "thread-1",
    });
    const first = store.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!first) throw new Error("Expected a run to link messages to.");

    expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-b",
        runId: first.run.runId,
      }),
    ).toBe(true);
    expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-a",
        runId: first.run.runId,
      }),
    ).toBe(true);
    expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-a",
        runId: first.run.runId,
      }),
    ).toBe(false);
    expect(store.listRunMessages(WORKSPACE_ID, first.run.runId)).toEqual([
      "message-report-a",
      "message-report-b",
    ]);
    expect(store.runIdForMessage(WORKSPACE_ID, "message-report-a")).toBe(first.run.runId);
    expect(store.runIdForMessage(WORKSPACE_ID, "message-unlinked")).toBeNull();
    expect(store.runRecordsForThread(WORKSPACE_ID, "thread-1")).toEqual({
      "message-report-a": first.run,
      "message-report-b": first.run,
    });
    expect(store.runRecordsForThread(WORKSPACE_ID, "thread-unlinked")).toEqual({});

    expect(db.prepare("SELECT op_kind FROM replication_log").all()).toEqual([]);

    expect(() =>
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-unknown-run",
        runId: "run-missing",
      }),
    ).toThrowError(AgentDispatchStoreError);

    store.completeRun({ runId: first.run.runId, exitCode: 0 });
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-trigger-2",
      threadId: "thread-1",
    });
    const second = store.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!second) throw new Error("Expected a second run.");
    let conflict: unknown;
    try {
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId: "message-report-a",
        runId: second.run.runId,
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "state-corrupt" });
  });

  it("bounds thread history by newest runs without dropping their linked messages", () => {
    const db = database();
    let now = 1000;
    let nextRun = 0;
    const store = createAgentDispatchStore(db, {
      nowMs: () => now,
      createRunId: () => `run-${(nextRun += 1)}`,
    });
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-trigger-old",
      threadId: "thread-1",
    });
    const oldRun = store.claimNextPending(WORKSPACE_ID);
    if (!oldRun) throw new Error("Expected the old run.");
    store.recordRunMessage({
      workspaceId: WORKSPACE_ID,
      messageId: "message-report-old",
      runId: oldRun.run.runId,
    });
    store.completeRun({ runId: oldRun.run.runId, exitCode: 0 });

    now = 2000;
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-trigger-new",
      threadId: "thread-1",
    });
    const newRun = store.claimNextPending(WORKSPACE_ID);
    if (!newRun) throw new Error("Expected the new run.");
    for (const messageId of ["message-report-new-a", "message-report-new-b"]) {
      store.recordRunMessage({
        workspaceId: WORKSPACE_ID,
        messageId,
        runId: newRun.run.runId,
      });
    }

    const recent = store.runRecordsForThread(WORKSPACE_ID, "thread-1", {
      limit: 1,
    });
    expect(Object.keys(recent)).toEqual([
      "message-report-new-a",
      "message-report-new-b",
    ]);
    expect(Object.values(recent).map((run) => run.runId)).toEqual([
      newRun.run.runId,
      newRun.run.runId,
    ]);
    expect(() =>
      store.runRecordsForThread(WORKSPACE_ID, "thread-1", { limit: 0 }),
    ).toThrowError(AgentDispatchStoreError);
  });

  it("persists pause state and never claims work from a paused thread", () => {
    const db = database();
    let now = 1000;
    let nextRun = 0;
    const store = createAgentDispatchStore(db, {
      nowMs: () => now,
      createRunId: () => `run-${(nextRun += 1)}`,
    });
    expect(store.threadDispatchPaused(WORKSPACE_ID, "thread-paused")).toBe(false);
    expect(store.getThreadDispatchPauseState(WORKSPACE_ID, "thread-paused")).toBeNull();
    expect(
      store.setThreadDispatchPaused({
        workspaceId: WORKSPACE_ID,
        threadId: "thread-paused",
        paused: true,
        reason: "dispatch budget exceeded",
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      threadId: "thread-paused",
      paused: true,
      reason: "dispatch budget exceeded",
      updatedAtMs: 1000,
    });
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-paused",
      threadId: "thread-paused",
    });
    store.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-ready",
      threadId: "thread-ready",
    });

    const ready = store.claimNextPending(WORKSPACE_ID);
    expect(ready?.dispatch.triggerMessageId).toBe("message-ready");
    if (!ready) throw new Error("Expected the unpaused dispatch.");
    store.completeRun({ runId: ready.run.runId, exitCode: 0 });
    expect(store.claimNextPending(WORKSPACE_ID)).toBeNull();

    now = 1500;
    expect(
      store.setThreadDispatchPaused({
        workspaceId: WORKSPACE_ID,
        threadId: "thread-paused",
        paused: false,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      threadId: "thread-paused",
      paused: false,
      updatedAtMs: 1500,
    });
    expect(store.threadDispatchPaused(WORKSPACE_ID, "thread-paused")).toBe(false);
    expect(store.getThreadDispatchPauseState(WORKSPACE_ID, "thread-paused")).toEqual({
      workspaceId: WORKSPACE_ID,
      threadId: "thread-paused",
      paused: false,
      updatedAtMs: 1500,
    });
    expect(store.claimNextPending(WORKSPACE_ID)?.dispatch.triggerMessageId).toBe("message-paused");
  });
});
