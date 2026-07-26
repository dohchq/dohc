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
}

export type AwaitableAgentDispatchStore = Omit<
  AwaitableAgentDispatchStoreBase,
  "getRunRecord" | "recordRunMessage"
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
};
