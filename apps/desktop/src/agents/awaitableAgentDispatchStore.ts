import type { AgentDispatchStore } from "@dohc/workspace-engine";

type AwaitableMethod<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => TResult | Promise<TResult>
  : never;

type AwaitableAgentDispatchStoreBase = {
  [TKey in keyof AgentDispatchStore]: AwaitableMethod<
    AgentDispatchStore[TKey]
  >;
};

export interface AgentDispatchRequestOptions {
  deadlineMs?: number;
  retryTransportErrors?: boolean;
}

export const AGENT_DISPATCH_RPC_DEADLINE_MS = 2_000;

export type AwaitableAgentDispatchStore = Omit<
  AwaitableAgentDispatchStoreBase,
  | "getRunRecord"
  | "listRunMessages"
  | "markFailureNotePosted"
  | "recordRunMessage"
> & {
  getRunRecord(
    runId: Parameters<AgentDispatchStore["getRunRecord"]>[0],
    options?: AgentDispatchRequestOptions,
  ): ReturnType<AgentDispatchStore["getRunRecord"]> | Promise<
    ReturnType<AgentDispatchStore["getRunRecord"]>
  >;
  recordRunMessage(
    input: Parameters<AgentDispatchStore["recordRunMessage"]>[0],
    options?: AgentDispatchRequestOptions,
  ): ReturnType<AgentDispatchStore["recordRunMessage"]> | Promise<
    ReturnType<AgentDispatchStore["recordRunMessage"]>
  >;
  listRunMessages(
    workspaceId: Parameters<AgentDispatchStore["listRunMessages"]>[0],
    runId: Parameters<AgentDispatchStore["listRunMessages"]>[1],
    options?: AgentDispatchRequestOptions,
  ): ReturnType<AgentDispatchStore["listRunMessages"]> | Promise<
    ReturnType<AgentDispatchStore["listRunMessages"]>
  >;
  markFailureNotePosted(
    runId: Parameters<AgentDispatchStore["markFailureNotePosted"]>[0],
    options?: AgentDispatchRequestOptions,
  ): ReturnType<AgentDispatchStore["markFailureNotePosted"]> | Promise<
    ReturnType<AgentDispatchStore["markFailureNotePosted"]>
  >;
};
