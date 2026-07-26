import type { AgentDispatchStore } from "@dohc/workspace-engine";

type AwaitableMethod<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => TResult | Promise<TResult>
  : never;

export type AwaitableAgentDispatchStore = {
  [TKey in keyof AgentDispatchStore]: AwaitableMethod<
    AgentDispatchStore[TKey]
  >;
};
