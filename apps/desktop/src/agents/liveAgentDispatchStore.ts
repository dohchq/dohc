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
} from "@dohc/workspace-contracts/engine";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
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
  const assertWorkspaceId = (workspaceId: string): void => {
    if (workspaceId !== workspace.workspaceId) {
      throw new Error(
        `Workspace ${workspaceId} does not match this dispatch store.`,
      );
    }
  };

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

  const claimPending = async (
    workspaceId: string,
    claimOptions: Parameters<
      AwaitableAgentDispatchStore["claimNextPending"]
    >[1] = {},
    unresolvedOnly = false,
  ): Promise<AgentDispatchClaim | null> => {
    assertWorkspaceId(workspaceId);
    const unresolvedRunId = unresolvedClaimRunIds.get(workspaceId);
    if (unresolvedOnly && !unresolvedRunId) return null;
    const runId = unresolvedRunId ?? createRunId();
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
  };

  const store: AwaitableAgentDispatchStore = {
    recordEligibleTriggers: async (input) => {
      assertWorkspaceId(input.workspaceId);
      return await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchRecordEligibleTriggers,
            {
              ...(input.verifiedUserId
                ? { verifiedUserId: input.verifiedUserId }
                : {}),
            },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { retryTransportErrors: true },
      );
    },
    recordTrigger: async (input) =>
      await invoke(async (adapter) => await adapter.recordTrigger(input)),
    claimNextPending: async (workspaceId, claimOptions = {}) =>
      await claimPending(workspaceId, claimOptions),
    resolveUncertainClaim: async (workspaceId, claimOptions = {}) =>
      await claimPending(workspaceId, claimOptions, true),
    failPendingForThread: async (input) => {
      assertWorkspaceId(input.workspaceId);
      return await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchFailPendingForThread,
            {
              threadId: input.threadId,
              reason: input.reason,
            },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { retryTransportErrors: true },
      );
    },
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
    listPending: async (workspaceId) => {
      assertWorkspaceId(workspaceId);
      return toAgentDispatchRecords(
        await invoke(
          async (adapter) => {
            const records: ChatDispatch[] = [];
            let cursor: string | undefined;
            do {
              const page = await adapter.request(
                CHATS_METHOD.dispatchListPending,
                {
                  pageLimit: 500,
                  ...(cursor !== undefined ? { cursor } : {}),
                },
                { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
              );
              records.push(...page.dispatches);
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
            return records;
          },
          { retryTransportErrors: true },
        ),
      );
    },
    openRuns: async (workspaceId) => {
      assertWorkspaceId(workspaceId);
      return toAgentDispatchClaims(
        await invoke(
          async (adapter) => {
            const claims: ChatDispatchClaim[] = [];
            let cursor: string | undefined;
            do {
              const page = await adapter.request(
                CHATS_METHOD.dispatchOpenRuns,
                {
                  pageLimit: 500,
                  ...(cursor !== undefined ? { cursor } : {}),
                },
                { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
              );
              claims.push(...page.claims);
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
            return claims;
          },
          { retryTransportErrors: true },
        ),
      );
    },
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
    recentDispatchCount: async (input) => {
      assertWorkspaceId(input.workspaceId);
      return await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchRecentCount,
            {
              threadId: input.threadId,
              sinceMs: input.sinceMs,
            },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { retryTransportErrors: true },
      );
    },
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
    setThreadDispatchPaused: async (input) => {
      assertWorkspaceId(input.workspaceId);
      return (await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchSetThreadPaused,
            {
              threadId: input.threadId,
              paused: input.paused,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
            },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { retryTransportErrors: true },
      )) as ThreadDispatchPauseState;
    },
    threadDispatchPaused: async (workspaceId, threadId) => {
      assertWorkspaceId(workspaceId);
      return await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchIsThreadPaused,
            { threadId },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { retryTransportErrors: true },
      );
    },
    getThreadDispatchPauseState: async (workspaceId, threadId) => {
      assertWorkspaceId(workspaceId);
      return (await invoke(
        async (adapter) =>
          await adapter.request(
            CHATS_METHOD.dispatchGetThreadPauseState,
            { threadId },
            { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
          ),
        { retryTransportErrors: true },
      )) as ThreadDispatchPauseState | null;
    },
  };

  return {
    store,
    requeueFailedTrigger: async (input) => {
      assertWorkspaceId(input.workspaceId);
      return await invoke(
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
          let cursor: string | undefined;
          do {
            const page = await adapter.request(
              CHATS_METHOD.dispatchListPending,
              {
                pageLimit: 500,
                ...(cursor !== undefined ? { cursor } : {}),
              },
              { deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS },
            );
            if (
              page.dispatches.some(
                (candidate) =>
                  candidate.triggerMessageId === input.triggerMessageId &&
                  candidate.state === "pending",
              )
            ) {
              return true;
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);
          return false;
        },
        { retryTransportErrors: true },
      );
    },
    listAppQuitRecoveries: async (workspaceId) => {
      assertWorkspaceId(workspaceId);
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
