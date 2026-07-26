import { randomUUID } from "node:crypto";
import {
  CHATS_METHOD,
  ChatsLiveAdapter,
  type ChatRecoveriesPage,
} from "@dohc/workspace-engine-client";
import type {
  AgentDispatchClaim,
  AgentDispatchRecord,
  AgentRunRecord,
  ThreadDispatchPauseState,
} from "@dohc/workspace-engine";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "../workspaces/engineWorkspaceSessions";
import {
  RUN_ID_LOG_TOKEN,
  type ChatDispatchRecovery,
} from "./chatDispatchService";
import type { AwaitableAgentDispatchStore } from "./awaitableAgentDispatchStore";

export interface LiveAgentDispatchStoreHandle {
  store: AwaitableAgentDispatchStore;
  requeueFailedTrigger(input: {
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  }): Promise<boolean>;
  listAppQuitRecoveries(workspaceId: string): Promise<ChatDispatchRecovery[]>;
  close(): Promise<void>;
}

export function createLiveAgentDispatchStore(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
  options: { createRunId?: () => string } = {},
): LiveAgentDispatchStoreHandle {
  const createRunId = options.createRunId ?? (() => `run_${randomUUID()}`);

  const invoke = async <T>(
    operation: (adapter: ChatsLiveAdapter) => Promise<T>,
    runId?: string,
  ): Promise<T> =>
    await sessions.run(workspace, async ({ client, workspace: handle }) => {
      const adapter = new ChatsLiveAdapter(client, handle, {
        workspaceId: workspace.workspaceId,
        ...(runId
          ? {
              createId: (kind) =>
                kind === "run" ? runId : `${kind}-${randomUUID()}`,
            }
          : {}),
      });
      return await operation(adapter);
    });

  const store: AwaitableAgentDispatchStore = {
    recordEligibleTriggers: async (input) =>
      await invoke(async (adapter) => await adapter.recordEligibleTriggers(input)),
    recordTrigger: async (input) =>
      await invoke(async (adapter) => await adapter.recordTrigger(input)),
    claimNextPending: async (workspaceId, claimOptions = {}) => {
      const runId = createRunId();
      return await invoke(
        async (adapter) =>
          await adapter.claimNextPending(workspaceId, {
            ...claimOptions,
            ...(claimOptions.logPath
              ? {
                  logPath: claimOptions.logPath.replaceAll(
                    RUN_ID_LOG_TOKEN,
                    runId,
                  ),
                }
              : {}),
          }),
        runId,
      );
    },
    failPendingForThread: async (input) =>
      await invoke(async (adapter) => await adapter.failPendingForThread(input)),
    completeRun: async (input) =>
      await invoke(async (adapter) => await adapter.completeRun(input)),
    failRun: async (input) =>
      await invoke(async (adapter) => await adapter.failRun(input)),
    listPending: async (workspaceId) =>
      (await invoke(async (adapter) => await adapter.listPending(workspaceId))) as AgentDispatchRecord[],
    openRuns: async (workspaceId) =>
      (await invoke(async (adapter) => await adapter.openRuns(workspaceId))) as AgentDispatchClaim[],
    markFailureNotePosted: async (runId) =>
      (await invoke(async (adapter) => await adapter.markFailureNotePosted(runId))) as AgentRunRecord,
    recentDispatchCount: async (input) =>
      await invoke(async (adapter) => await adapter.recentDispatchCount(input)),
    recordRunMessage: async (input) =>
      await invoke(async (adapter) => await adapter.recordRunMessage(input)),
    listRunMessages: async (workspaceId, runId) =>
      await invoke(async (adapter) => await adapter.listRunMessages(workspaceId, runId)),
    runIdForMessage: async (workspaceId, messageId) =>
      await invoke(async (adapter) => await adapter.runIdForMessage(workspaceId, messageId)),
    runRecordsForThread: async (workspaceId, threadId, options) =>
      (await invoke(
        async (adapter) =>
          await adapter.runRecordsForThread(workspaceId, threadId, options),
      )) as Record<string, AgentRunRecord>,
    getRunRecord: async (runId) =>
      (await invoke(async (adapter) => await adapter.getRunRecord(runId))) as AgentRunRecord | null,
    setThreadDispatchPaused: async (input) =>
      (await invoke(async (adapter) => await adapter.setThreadDispatchPaused(input))) as ThreadDispatchPauseState,
    threadDispatchPaused: async (workspaceId, threadId) =>
      await invoke(
        async (adapter) =>
          await adapter.threadDispatchPaused(workspaceId, threadId),
      ),
    getThreadDispatchPauseState: async (workspaceId, threadId) =>
      (await invoke(
        async (adapter) =>
          await adapter.getThreadDispatchPauseState(workspaceId, threadId),
      )) as ThreadDispatchPauseState | null,
  };

  return {
    store,
    requeueFailedTrigger: async (input) =>
      await invoke(
        async (adapter) =>
          await adapter.request(CHATS_METHOD.dispatchRequeueFailedTrigger, {
            triggerMessageId: input.triggerMessageId,
            runId: input.runId,
          }),
      ),
    listAppQuitRecoveries: async (workspaceId) => {
      if (workspaceId !== workspace.workspaceId) {
        throw new Error(
          `Workspace ${workspaceId} does not match this dispatch store.`,
        );
      }
      return await invoke(async (adapter) => {
        const recoveries: ChatDispatchRecovery[] = [];
        let cursor: string | undefined;
        do {
          const page: ChatRecoveriesPage = await adapter.request(
            CHATS_METHOD.dispatchListAppQuitRecoveries,
            {
              pageLimit: 500,
              ...(cursor !== undefined ? { cursor } : {}),
            },
          );
          recoveries.push(...page.recoveries);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return recoveries;
      });
    },
    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };
}
