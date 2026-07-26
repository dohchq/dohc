import { randomUUID } from "node:crypto";
import {
  CHATS_METHOD,
  ChatsLiveAdapter,
  type ChatDispatch,
  type ChatDispatchClaim,
  type ChatRecoveriesPage,
  type ChatRunMessagesPage,
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
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AgentDispatchRequestOptions,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";

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

export const TERMINAL_DISPATCH_DEADLINE_MS = AGENT_DISPATCH_RPC_DEADLINE_MS;

function toAgentDispatchRecords(
  records: ChatDispatch[],
): AgentDispatchRecord[] {
  return records;
}

function toAgentDispatchClaims(
  claims: ChatDispatchClaim[],
): AgentDispatchClaim[] {
  return claims;
}

export function createLiveAgentDispatchStore(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
  options: { createRunId?: () => string } = {},
): LiveAgentDispatchStoreHandle {
  const createRunId = options.createRunId ?? (() => `run_${randomUUID()}`);
  const unresolvedClaimRunIds = new Map<string, string>();

  const invoke = async <T>(
    operation: (adapter: ChatsLiveAdapter) => Promise<T>,
    invokeOptions: {
      runId?: string;
      retryTransportErrors?: boolean;
    } = {},
  ): Promise<T> =>
    await sessions.run(workspace, async ({ client, workspace: handle }) => {
      const adapter = new ChatsLiveAdapter(client, handle, {
        workspaceId: workspace.workspaceId,
        ...(invokeOptions.runId
          ? {
              createId: (kind) =>
                kind === "run"
                  ? invokeOptions.runId!
                  : `${kind}-${randomUUID()}`,
            }
          : {}),
      });
      return await operation(adapter);
    }, {
      retryTransportErrors: invokeOptions.retryTransportErrors,
    });

  const store: AwaitableAgentDispatchStore = {
    recordEligibleTriggers: async (input) =>
      await invoke(async (adapter) => await adapter.recordEligibleTriggers(input)),
    recordTrigger: async (input) =>
      await invoke(async (adapter) => await adapter.recordTrigger(input)),
    claimNextPending: async (workspaceId, claimOptions = {}) => {
      if (workspaceId !== workspace.workspaceId) {
        throw new Error(
          `Workspace ${workspaceId} does not match this dispatch store.`,
        );
      }
      const runId = unresolvedClaimRunIds.get(workspaceId) ?? createRunId();
      unresolvedClaimRunIds.set(workspaceId, runId);
      const claim = await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchClaimNextPending,
            {
              runId,
              ...claimOptions,
              ...(claimOptions.logPath
                ? {
                    logPath: claimOptions.logPath.replaceAll(
                      RUN_ID_LOG_TOKEN,
                      runId,
                    ),
                  }
                : {}),
            },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { runId, retryTransportErrors: true },
      );
      if (unresolvedClaimRunIds.get(workspaceId) === runId) {
        unresolvedClaimRunIds.delete(workspaceId);
      }
      return claim as AgentDispatchClaim | null;
    },
    failPendingForThread: async (input) =>
      await invoke(async (adapter) => await adapter.failPendingForThread(input)),
    completeRun: async (input) =>
      await invoke(
        async (adapter) => {
          const requestOptions = {
            deadlineMs: TERMINAL_DISPATCH_DEADLINE_MS,
          };
          await adapter.request(
            CHATS_METHOD.dispatchComplete,
            input,
            requestOptions,
          );
          const completed = await adapter.request(
            CHATS_METHOD.dispatchGetRunRecord,
            { runId: input.runId },
            requestOptions,
          );
          if (!completed) {
            throw new Error(
              "The daemon acknowledged completion but did not return the run record.",
            );
          }
          return completed as AgentRunRecord;
        },
        { retryTransportErrors: true },
      ),
    failRun: async (input) =>
      await invoke(
        async (adapter) => {
          const requestOptions = {
            deadlineMs: TERMINAL_DISPATCH_DEADLINE_MS,
          };
          await adapter.request(
            CHATS_METHOD.dispatchFail,
            input,
            requestOptions,
          );
          const failed = await adapter.request(
            CHATS_METHOD.dispatchGetRunRecord,
            { runId: input.runId },
            requestOptions,
          );
          if (!failed) {
            throw new Error(
              "The daemon acknowledged failure but did not return the run record.",
            );
          }
          return failed as AgentRunRecord;
        },
        { retryTransportErrors: true },
      ),
    listPending: async (workspaceId) =>
      toAgentDispatchRecords(
        await invoke(async (adapter) => await adapter.listPending(workspaceId)),
      ),
    openRuns: async (workspaceId) =>
      toAgentDispatchClaims(
        await invoke(async (adapter) => await adapter.openRuns(workspaceId)),
      ),
    markFailureNotePosted: async (
      runId,
      requestOptions?: AgentDispatchRequestOptions,
    ) =>
      (await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchMarkFailureNotePosted,
            { runId },
            requestOptions,
          ),
        { retryTransportErrors: requestOptions?.retryTransportErrors },
      )) as AgentRunRecord,
    recentDispatchCount: async (input) =>
      await invoke(async (adapter) => await adapter.recentDispatchCount(input)),
    recordRunMessage: async (
      input,
      requestOptions?: AgentDispatchRequestOptions,
    ) =>
      await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchRecordRunMessage,
            {
              messageId: input.messageId,
              runId: input.runId,
            },
            requestOptions,
          ),
        { retryTransportErrors: requestOptions?.retryTransportErrors },
      ),
    listRunMessages: async (
      workspaceId,
      runId,
      requestOptions?: AgentDispatchRequestOptions,
    ) => {
      if (workspaceId !== workspace.workspaceId) {
        throw new Error(
          `Workspace ${workspaceId} does not match this dispatch store.`,
        );
      }
      return await invoke(
        async (adapter) => {
          const messageIds: string[] = [];
          let cursor: string | undefined;
          do {
            const page: ChatRunMessagesPage = await adapter.request(
              CHATS_METHOD.dispatchListRunMessages,
              {
                runId,
                pageLimit: 500,
                ...(cursor !== undefined ? { cursor } : {}),
              },
              requestOptions,
            );
            messageIds.push(...page.messageIds);
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);
          return messageIds;
        },
        { retryTransportErrors: requestOptions?.retryTransportErrors },
      );
    },
    runIdForMessage: async (workspaceId, messageId) =>
      await invoke(async (adapter) => await adapter.runIdForMessage(workspaceId, messageId)),
    runRecordsForThread: async (workspaceId, threadId, options) =>
      (await invoke(
        async (adapter) =>
          await adapter.runRecordsForThread(workspaceId, threadId, options),
      )) as Record<string, AgentRunRecord>,
    getRunRecord: async (
      runId,
      requestOptions?: AgentDispatchRequestOptions,
    ) =>
      (await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchGetRunRecord,
            { runId },
            requestOptions,
          ),
        { retryTransportErrors: requestOptions?.retryTransportErrors },
      )) as AgentRunRecord | null,
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
        async (adapter) => {
          const requeued = await adapter.request(
            CHATS_METHOD.dispatchRequeueFailedTrigger,
            {
              triggerMessageId: input.triggerMessageId,
              runId: input.runId,
            },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          );
          if (requeued) return true;
          const pending = await adapter.listPending(input.workspaceId);
          return pending.some(
            (candidate) =>
              candidate.triggerMessageId === input.triggerMessageId &&
              candidate.state === "pending",
          );
        },
        { retryTransportErrors: true },
      ),
    listAppQuitRecoveries: async (workspaceId) => {
      if (workspaceId !== workspace.workspaceId) {
        throw new Error(
          `Workspace ${workspaceId} does not match this dispatch store.`,
        );
      }
      return await invoke(
        async (adapter) => {
          const recoveries: ChatDispatchRecovery[] = [];
          let cursor: string | undefined;
          do {
            const page: ChatRecoveriesPage = await adapter.request(
              CHATS_METHOD.dispatchListAppQuitRecoveries,
              {
                pageLimit: 500,
                ...(cursor !== undefined ? { cursor } : {}),
              },
              { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
            );
            recoveries.push(...page.recoveries);
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);
          return recoveries;
        },
        { retryTransportErrors: true },
      );
    },
    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };
}
