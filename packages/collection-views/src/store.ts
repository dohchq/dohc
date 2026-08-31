import type {
  CollectionQueryCursor,
  CollectionQueryParams,
  CollectionQueryResult,
  CollectionQuerySort,
  CollectionRecord,
  CollectionRecordGroup,
  CollectionSummary,
  CollectionValue,
} from "@dohc/workspace-contracts";

/**
 * Runs one `collections.query` request. Hosts bind this to their transport:
 * the desktop renderer to its engine bridge, the SDK to its capability call.
 * The store never writes files or talks to an engine itself.
 */
export type CollectionQueryExecutor = (
  params: CollectionQueryParams,
) => Promise<CollectionQueryResult>;

export interface CollectionQueryInput {
  sort?: CollectionQuerySort[];
  groupBy?: string;
  resolveRelations?: boolean;
}

export type CollectionStoreStatus = "idle" | "loading" | "ready" | "error";

export interface CollectionStoreState {
  status: CollectionStoreStatus;
  collection: CollectionSummary | null;
  records: CollectionRecord[];
  groups: CollectionRecordGroup[] | null;
  nextCursor: CollectionQueryCursor | null;
  error: string | null;
  query: CollectionQueryInput;
}

export interface CollectionStore {
  getState(): CollectionStoreState;
  subscribe(listener: () => void): () => void;
  /** Re-runs the current query. Call on invalidation events from the host. */
  refresh(): Promise<void>;
  /** Merges `input` into the query, drops the cursor, and re-runs. */
  setQuery(input: Partial<CollectionQueryInput>): Promise<void>;
  /**
   * Fetches the next page and appends it. No-op without a cursor or while a
   * previous loadMore is still in flight, so hosts may call it eagerly
   * (scroll handlers, drain loops) without double-fetching a page.
   */
  loadMore(): Promise<void>;
}

export interface CollectionStoreOptions {
  collectionPath: string;
  executor: CollectionQueryExecutor;
}

function groupKey(value: CollectionValue): string {
  return JSON.stringify(value, (_key, raw: unknown) =>
    typeof raw === "bigint" ? `bigint:${raw}` : raw,
  );
}

function mergeGroups(
  existing: CollectionRecordGroup[] | null,
  incoming: CollectionRecordGroup[] | null,
): CollectionRecordGroup[] | null {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = existing.map((group) => ({ ...group }));
  const byKey = new Map(merged.map((group) => [groupKey(group.value), group]));
  for (const group of incoming) {
    const match = byKey.get(groupKey(group.value));
    if (match) {
      match.records = [...match.records, ...group.records];
    } else {
      merged.push(group);
    }
  }
  return merged;
}

export function createCollectionStore(
  options: CollectionStoreOptions,
): CollectionStore {
  const { collectionPath, executor } = options;
  const listeners = new Set<() => void>();
  // A monotonically increasing token guards every async response: only the
  // latest request may write state, so a slow response can never clobber a
  // newer one.
  let requestToken = 0;
  let loadingMore = false;

  let state: CollectionStoreState = {
    status: "idle",
    collection: null,
    records: [],
    groups: null,
    nextCursor: null,
    error: null,
    query: {},
  };

  function setState(next: Partial<CollectionStoreState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  async function run(
    query: CollectionQueryInput,
    cursor: CollectionQueryCursor | null,
  ): Promise<void> {
    const token = ++requestToken;
    if (!cursor) setState({ status: "loading", query });
    try {
      const result = await executor({ collectionPath, ...query, ...(cursor ? { cursor } : {}) });
      if (token !== requestToken) return;
      setState({
        status: "ready",
        collection: result.collection,
        records: cursor ? [...state.records, ...result.records] : result.records,
        groups: cursor ? mergeGroups(state.groups, result.groups) : result.groups,
        nextCursor: result.nextCursor,
        error: null,
      });
    } catch (error) {
      if (token !== requestToken) return;
      setState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => run(state.query, null),
    setQuery: (input) => run({ ...state.query, ...input }, null),
    loadMore() {
      if (loadingMore || !state.nextCursor || state.status !== "ready") {
        return Promise.resolve();
      }
      loadingMore = true;
      return run(state.query, state.nextCursor).finally(() => {
        loadingMore = false;
      });
    },
  };
}
