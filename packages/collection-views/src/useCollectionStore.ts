import { useSyncExternalStore } from "react";
import type { CollectionStore, CollectionStoreState } from "./store";

/** Subscribes a React component to a collection store's state. */
export function useCollectionStore(store: CollectionStore): CollectionStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
