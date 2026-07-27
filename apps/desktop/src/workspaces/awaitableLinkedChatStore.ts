import type { LinkedChatStore } from "@dohc/workspace-engine";

type AwaitableMethod<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => TResult extends Promise<unknown>
    ? TResult
    : TResult | Promise<TResult>
  : never;

export type AwaitableLinkedChatStore = {
  [TKey in keyof LinkedChatStore]: AwaitableMethod<LinkedChatStore[TKey]>;
};
