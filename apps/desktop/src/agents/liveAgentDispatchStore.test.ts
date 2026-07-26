import type {
  JsonValue,
  Request,
  Response,
} from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineWorkspaceRebindError,
  EngineWorkspaceSessions,
  WORKSPACE_OPEN_DEADLINE_MS,
} from "../workspaces/engineWorkspaceSessions";
import {
  TERMINAL_DISPATCH_DEADLINE_MS,
  createLiveAgentDispatchStore,
} from "./liveAgentDispatchStore";

const WORKSPACE = {
  workspaceId: "workspace-live-dispatch",
  rootPath: "C:\\workspace-live-dispatch",
};

const dispatch = {
  workspaceId: WORKSPACE.workspaceId,
  triggerMessageId: "trigger",
  threadId: "thread",
  state: "running" as const,
  runId: "run-fixed",
  attemptCount: 1,
  createdAtMs: 1,
  updatedAtMs: 2,
};

const run = {
  workspaceId: WORKSPACE.workspaceId,
  runId: "run-fixed",
  threadId: "thread",
  triggerMessageId: "trigger",
  command: "codex",
  startedAtMs: 3,
  logPath: "logs/run-fixed/run-fixed.log",
  failureNotePosted: false,
};

const pause = {
  workspaceId: WORKSPACE.workspaceId,
  threadId: "thread",
  paused: true,
  reason: "budget",
  updatedAtMs: 4,
};

type RequestHandler = (request: Request) => JsonValue | Promise<JsonValue>;

function mockClient(handler: RequestHandler) {
  const requests: Request[] = [];
  return {
    requests,
    close: () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      return { id: request.id, result: await handler(request) };
    },
  };
}

function dispatchResult(request: Request): JsonValue {
  switch (request.method) {
    case "workspace.open":
      return { workspace: "handle-1" };
    case "workspace.close":
      return { closed: true };
    case "chats.dispatch.recordEligibleTriggers":
      return 2;
    case "chats.dispatch.enqueue":
      return { enqueued: true };
    case "chats.dispatch.claimNextPending":
      return { dispatch, run };
    case "chats.dispatch.failPendingForThread":
      return 1;
    case "chats.dispatch.complete":
      return { completed: true };
    case "chats.dispatch.fail":
      return { failed: true };
    case "chats.dispatch.listPending":
      return { dispatches: [dispatch], nextCursor: null };
    case "chats.dispatch.openRuns":
      return { claims: [{ dispatch, run }], nextCursor: null };
    case "chats.dispatch.markFailureNotePosted":
      return { ...run, failureNotePosted: true };
    case "chats.dispatch.recentCount":
      return 3;
    case "chats.dispatch.recordRunMessage":
      return true;
    case "chats.dispatch.listRunMessages":
      return { messageIds: ["reply"], nextCursor: null };
    case "chats.dispatch.runIdForMessage":
      return run.runId;
    case "chats.dispatch.runRecordsForThread":
      return { runs: { trigger: run }, nextCursor: null };
    case "chats.dispatch.getRunRecord":
      return run;
    case "chats.dispatch.setThreadPaused":
      return pause;
    case "chats.dispatch.isThreadPaused":
      return true;
    case "chats.dispatch.getThreadPauseState":
      return pause;
    case "chats.dispatch.requeueFailedTrigger":
      return true;
    case "chats.dispatch.listAppQuitRecoveries":
      return {
        recoveries: [{ run: { ...run, endedAtMs: 5 }, attemptCount: 1 }],
        nextCursor: null,
      };
    default:
      throw new Error(`Unexpected request: ${request.method}`);
  }
}

const openSessions: EngineWorkspaceSessions[] = [];

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map(async (sessions) => {
    await sessions.closeAll();
  }));
});

describe("live agent dispatch store", () => {
  it("live_dispatch_round_trips_every_store_method_and_extra_rpc", async () => {
    const client = mockClient(dispatchResult);
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    openSessions.push(sessions);
    const handle = createLiveAgentDispatchStore(WORKSPACE, sessions, {
      createRunId: () => "run-fixed",
    });
    const { store } = handle;

    await expect(
      store.recordEligibleTriggers({
        workspaceId: WORKSPACE.workspaceId,
        verifiedUserId: "user",
      }),
    ).resolves.toBe(2);
    await expect(
      store.recordTrigger({
        workspaceId: WORKSPACE.workspaceId,
        triggerMessageId: "trigger",
        threadId: "thread",
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimNextPending(WORKSPACE.workspaceId, {
        command: "codex",
        logPath: "logs/{runId}/{runId}.log",
      }),
    ).resolves.toEqual({ dispatch, run });
    await expect(
      store.failPendingForThread({
        workspaceId: WORKSPACE.workspaceId,
        threadId: "thread",
        reason: "stop",
      }),
    ).resolves.toBe(1);
    await expect(
      store.completeRun({ runId: run.runId, exitCode: 0 }),
    ).resolves.toEqual(run);
    await expect(
      store.failRun({ runId: run.runId, exitCode: 1, reason: "failed" }),
    ).resolves.toEqual(run);
    await expect(store.listPending(WORKSPACE.workspaceId)).resolves.toEqual([
      dispatch,
    ]);
    await expect(store.openRuns(WORKSPACE.workspaceId)).resolves.toEqual([
      { dispatch, run },
    ]);
    await expect(
      store.markFailureNotePosted(run.runId, { deadlineMs: 432 }),
    ).resolves.toEqual({
      ...run,
      failureNotePosted: true,
    });
    await expect(
      store.recentDispatchCount({
        workspaceId: WORKSPACE.workspaceId,
        threadId: "thread",
        sinceMs: 0,
      }),
    ).resolves.toBe(3);
    await expect(
      store.recordRunMessage({
        workspaceId: WORKSPACE.workspaceId,
        messageId: "reply",
        runId: run.runId,
      }, { deadlineMs: 321 }),
    ).resolves.toBe(true);
    await expect(
      store.listRunMessages(
        WORKSPACE.workspaceId,
        run.runId,
        { deadlineMs: 543 },
      ),
    ).resolves.toEqual(["reply"]);
    await expect(
      store.runIdForMessage(WORKSPACE.workspaceId, "reply"),
    ).resolves.toBe(run.runId);
    await expect(
      store.runRecordsForThread(WORKSPACE.workspaceId, "thread"),
    ).resolves.toEqual({ trigger: run });
    await expect(
      store.getRunRecord(run.runId, { deadlineMs: 654 }),
    ).resolves.toEqual(run);
    await expect(
      store.setThreadDispatchPaused({
        workspaceId: WORKSPACE.workspaceId,
        threadId: "thread",
        paused: true,
        reason: "budget",
      }),
    ).resolves.toEqual(pause);
    await expect(
      store.threadDispatchPaused(WORKSPACE.workspaceId, "thread"),
    ).resolves.toBe(true);
    await expect(
      store.getThreadDispatchPauseState(WORKSPACE.workspaceId, "thread"),
    ).resolves.toEqual(pause);
    await expect(
      handle.requeueFailedTrigger({
        workspaceId: WORKSPACE.workspaceId,
        triggerMessageId: "trigger",
        runId: run.runId,
      }),
    ).resolves.toBe(true);
    await expect(
      handle.listAppQuitRecoveries(WORKSPACE.workspaceId),
    ).resolves.toEqual([
      { run: { ...run, endedAtMs: 5 }, attemptCount: 1 },
    ]);

    expect(
      client.requests.find(
        ({ method }) => method === "chats.dispatch.claimNextPending",
      )?.deadlineMs,
    ).toBe(TERMINAL_DISPATCH_DEADLINE_MS);
    expect(
      client.requests.find(
        ({ method }) => method === "chats.dispatch.claimNextPending",
      ),
    ).toMatchObject({
      params: {
        runId: "run-fixed",
        command: "codex",
        logPath: "logs/run-fixed/run-fixed.log",
      },
    });
    expect(
      client.requests.find(
        ({ method }) => method === "chats.dispatch.markFailureNotePosted",
      )?.deadlineMs,
    ).toBe(432);
    expect(
      client.requests.find(
        ({ method }) => method === "chats.dispatch.listRunMessages",
      )?.deadlineMs,
    ).toBe(543);
    expect(
      client.requests.find(
        ({ method }) => method === "chats.dispatch.recordRunMessage",
      )?.deadlineMs,
    ).toBe(321);
    expect(
      client.requests
        .filter(({ method }) => method === "chats.dispatch.getRunRecord")
        .at(-1)?.deadlineMs,
    ).toBe(654);
    // MUTATION: restore the convenience completeRun/failRun calls -> these
    // terminal attempts (including their read-after-write) lose their deadlines.
    expect(
      client.requests
        .filter(
          ({ method }) =>
            method === "chats.dispatch.complete" ||
            method === "chats.dispatch.fail",
        )
        .map(({ deadlineMs }) => deadlineMs),
    ).toEqual([
      TERMINAL_DISPATCH_DEADLINE_MS,
      TERMINAL_DISPATCH_DEADLINE_MS,
    ]);
    expect(
      client.requests
        .filter(({ method }) => method === "chats.dispatch.getRunRecord")
        .slice(0, 2)
        .map(({ deadlineMs }) => deadlineMs),
    ).toEqual([
      TERMINAL_DISPATCH_DEADLINE_MS,
      TERMINAL_DISPATCH_DEADLINE_MS,
    ]);
    expect(
      new Set(
        client.requests
          .filter(({ method }) => method.startsWith("chats.dispatch."))
          .map(({ method }) => method),
      ),
    ).toEqual(
      new Set([
        "chats.dispatch.recordEligibleTriggers",
        "chats.dispatch.enqueue",
        "chats.dispatch.claimNextPending",
        "chats.dispatch.failPendingForThread",
        "chats.dispatch.complete",
        "chats.dispatch.fail",
        "chats.dispatch.listPending",
        "chats.dispatch.openRuns",
        "chats.dispatch.markFailureNotePosted",
        "chats.dispatch.recentCount",
        "chats.dispatch.recordRunMessage",
        "chats.dispatch.listRunMessages",
        "chats.dispatch.runIdForMessage",
        "chats.dispatch.runRecordsForThread",
        "chats.dispatch.getRunRecord",
        "chats.dispatch.setThreadPaused",
        "chats.dispatch.isThreadPaused",
        "chats.dispatch.getThreadPauseState",
        "chats.dispatch.requeueFailedTrigger",
        "chats.dispatch.listAppQuitRecoveries",
      ]),
    );
  });

  it("reuses one pre-minted run id until an ambiguous claim resolves", async () => {
    // MUTATION: mint inside each attempt or clear the unresolved id on rejection
    // -> the three claim requests carry different ids and strand the committed run.
    let claimAttempts = 0;
    const client = mockClient((request) => {
      if (request.method === "workspace.open") {
        return { workspace: "handle-claim-retry" };
      }
      if (request.method === "workspace.close") return { closed: true };
      if (request.method !== "chats.dispatch.claimNextPending") {
        throw new Error(`Unexpected request: ${request.method}`);
      }
      claimAttempts += 1;
      if (claimAttempts <= 2) {
        throw {
          code: "transport-error",
          message: "claim response was lost",
        };
      }
      return { dispatch, run };
    });
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => client },
      {
        transportRebindAttempts: 2,
        sleep: async () => undefined,
      },
    );
    openSessions.push(sessions);
    const createRunId = vi.fn(() => "run-fixed");
    const { store } = createLiveAgentDispatchStore(WORKSPACE, sessions, {
      createRunId,
    });

    await expect(
      store.claimNextPending(WORKSPACE.workspaceId, {
        command: "codex",
        logPath: "logs/{runId}.log",
      }),
    ).rejects.toMatchObject({ code: "transport-error" });
    await expect(
      store.claimNextPending(WORKSPACE.workspaceId, {
        command: "codex",
        logPath: "logs/{runId}.log",
      }),
    ).resolves.toEqual({ dispatch, run });

    const claims = client.requests.filter(
      ({ method }) => method === "chats.dispatch.claimNextPending",
    );
    expect(createRunId).toHaveBeenCalledTimes(1);
    expect(claims).toHaveLength(3);
    expect(
      claims.map(
        ({ params }) => (params as { runId?: JsonValue }).runId,
      ),
    ).toEqual([
      "run-fixed",
      "run-fixed",
      "run-fixed",
    ]);
    expect(
      claims.map(
        ({ params }) => (params as { logPath?: JsonValue }).logPath,
      ),
    ).toEqual([
      "logs/run-fixed.log",
      "logs/run-fixed.log",
      "logs/run-fixed.log",
    ]);
    expect(claims.map(({ deadlineMs }) => deadlineMs)).toEqual([
      TERMINAL_DISPATCH_DEADLINE_MS,
      TERMINAL_DISPATCH_DEADLINE_MS,
      TERMINAL_DISPATCH_DEADLINE_MS,
    ]);
  });

  it("verifies an ambiguously committed interrupted-run requeue", async () => {
    // MUTATION: remove transport retries or the pending-state verification ->
    // a committed requeue whose first response is lost is reported as false.
    let requeueAttempts = 0;
    const client = mockClient((request) => {
      if (request.method === "workspace.open") {
        return { workspace: `handle-requeue-${requeueAttempts}` };
      }
      if (request.method === "workspace.close") return { closed: true };
      if (request.method === "chats.dispatch.requeueFailedTrigger") {
        requeueAttempts += 1;
        if (requeueAttempts === 1) {
          throw {
            code: "transport-error",
            message: "requeue response was lost after commit",
          };
        }
        return false;
      }
      if (request.method === "chats.dispatch.listPending") {
        return {
          dispatches: [{ ...dispatch, state: "pending" }],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected request: ${request.method}`);
    });
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => client },
      { sleep: async () => undefined },
    );
    openSessions.push(sessions);
    const handle = createLiveAgentDispatchStore(WORKSPACE, sessions);

    await expect(
      handle.requeueFailedTrigger({
        workspaceId: WORKSPACE.workspaceId,
        triggerMessageId: dispatch.triggerMessageId,
        runId: run.runId,
      }),
    ).resolves.toBe(true);

    const requests = client.requests.filter(
      ({ method }) => method === "chats.dispatch.requeueFailedTrigger",
    );
    expect(requests).toHaveLength(2);
    expect(requests.map(({ deadlineMs }) => deadlineMs)).toEqual([
      TERMINAL_DISPATCH_DEADLINE_MS,
      TERMINAL_DISPATCH_DEADLINE_MS,
    ]);
  });

  it("live_dispatch_rejects_a_corrupt_dispatch_decode", async () => {
    const client = mockClient((request) =>
      request.method === "workspace.open"
        ? { workspace: "handle-1" }
        : request.method === "workspace.close"
          ? { closed: true }
          : { dispatches: [{ ...dispatch, attemptCount: "1" }], nextCursor: null },
    );
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    openSessions.push(sessions);
    const { store } = createLiveAgentDispatchStore(WORKSPACE, sessions);

    await expect(store.listPending(WORKSPACE.workspaceId)).rejects.toMatchObject({
      name: "ChatsProtocolShapeError",
    });
  });

  it("workspace_sessions_join_one_in_progress_rebind_after_concurrent_reconnects", async () => {
    // MUTATION: clear entry.opening in either reconnect catch -> both stale
    // operations issue workspace.open and leak one of the resulting handles.
    let openCount = 0;
    let staleOperationCount = 0;
    let releaseStaleOperations!: () => void;
    const staleOperations = new Promise<void>((resolve) => {
      releaseStaleOperations = resolve;
    });
    let signalReopenStarted!: () => void;
    const reopenStarted = new Promise<void>((resolve) => {
      signalReopenStarted = resolve;
    });
    let releaseReopen!: () => void;
    const reopenGate = new Promise<void>((resolve) => {
      releaseReopen = resolve;
    });
    const client = mockClient(async (request) => {
      if (request.method === "workspace.open") {
        openCount += 1;
        if (openCount === 2) {
          signalReopenStarted();
          await reopenGate;
        }
        return { workspace: `handle-${openCount}` };
      }
      if (request.method === "workspace.close") return { closed: true };
      if (request.workspace === "handle-1") {
        staleOperationCount += 1;
        if (staleOperationCount === 2) releaseStaleOperations();
        await staleOperations;
        throw {
          wireError: {
            code: "WORKSPACE_UNAVAILABLE",
            message: "stale workspace handle",
            retry: "afterReconnect",
          },
        };
      }
      return true;
    });
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    openSessions.push(sessions);
    const { store } = createLiveAgentDispatchStore(WORKSPACE, sessions);

    const operations = Promise.all([
      store.recordRunMessage({
        workspaceId: WORKSPACE.workspaceId,
        messageId: "reply-a",
        runId: run.runId,
      }),
      store.recordRunMessage({
        workspaceId: WORKSPACE.workspaceId,
        messageId: "reply-b",
        runId: run.runId,
      }),
    ]);
    await reopenStarted;
    releaseReopen();

    await expect(operations).resolves.toEqual([true, true]);
    expect(staleOperationCount).toBe(2);
    expect(openCount).toBe(2);
    expect(
      client.requests
        .filter(({ method }) => method === "workspace.open")
        .map(({ params }) => params),
    ).toEqual([
      {
        rootDir: WORKSPACE.rootPath,
        workspaceId: WORKSPACE.workspaceId,
        recoverRunningDispatches: false,
      },
      {
        rootDir: WORKSPACE.rootPath,
        workspaceId: WORKSPACE.workspaceId,
        recoverRunningDispatches: false,
      },
    ]);
  });

  it("workspace_sessions_deadline_every_workspace_open", async () => {
    // MUTATION: omit the workspace.open deadline -> a non-responsive daemon
    // can wedge every bounded dispatch operation before that operation starts.
    const client = mockClient(dispatchResult);
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    openSessions.push(sessions);
    const { store } = createLiveAgentDispatchStore(WORKSPACE, sessions);

    await expect(store.getRunRecord(run.runId)).resolves.toEqual(run);

    expect(
      client.requests.find(({ method }) => method === "workspace.open")
        ?.deadlineMs,
    ).toBe(WORKSPACE_OPEN_DEADLINE_MS);
  });

  it("workspace_sessions_surface_typed_error_when_reopen_fails", async () => {
    let opened = false;
    const client = mockClient((request) => {
      if (request.method === "workspace.open") {
        if (!opened) {
          opened = true;
          return { workspace: "handle-1" };
        }
        throw {
          wireError: {
            code: "WORKSPACE_UNAVAILABLE",
            message: "workspace remains unavailable",
            retry: "afterReconnect",
          },
        };
      }
      if (request.method === "workspace.close") return { closed: true };
      throw {
        wireError: {
          code: "WORKSPACE_UNAVAILABLE",
          message: "stale workspace handle",
          retry: "afterReconnect",
        },
      };
    });
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    openSessions.push(sessions);
    const { store } = createLiveAgentDispatchStore(WORKSPACE, sessions);

    await expect(store.getRunRecord(run.runId)).rejects.toBeInstanceOf(
      EngineWorkspaceRebindError,
    );
  });

  it("workspace_sessions_reopen_on_lifecycle_client_replacement_and_close", async () => {
    const first = mockClient((request) =>
      request.method === "workspace.open"
        ? { workspace: "generation-1" }
        : request.method === "workspace.close"
          ? { closed: true }
          : true,
    );
    const second = mockClient((request) =>
      request.method === "workspace.open"
        ? { workspace: "generation-2" }
        : request.method === "workspace.close"
          ? { closed: true }
          : true,
    );
    let current = first;
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => current,
    });
    openSessions.push(sessions);
    const handle = createLiveAgentDispatchStore(WORKSPACE, sessions);

    await expect(
      handle.store.recordRunMessage({
        workspaceId: WORKSPACE.workspaceId,
        messageId: "generation-1-message",
        runId: run.runId,
      }),
    ).resolves.toBe(true);
    current = second;
    await expect(
      handle.store.recordRunMessage({
        workspaceId: WORKSPACE.workspaceId,
        messageId: "generation-2-message",
        runId: run.runId,
      }),
    ).resolves.toBe(true);
    await handle.close();

    expect(first.requests.map(({ method }) => method)).toEqual([
      "workspace.open",
      "chats.dispatch.recordRunMessage",
    ]);
    expect(second.requests.map(({ method }) => method)).toEqual([
      "workspace.open",
      "chats.dispatch.recordRunMessage",
      "workspace.close",
    ]);
    expect(second.requests[0]?.params).toEqual({
      rootDir: WORKSPACE.rootPath,
      workspaceId: WORKSPACE.workspaceId,
      recoverRunningDispatches: false,
    });
  });
});
