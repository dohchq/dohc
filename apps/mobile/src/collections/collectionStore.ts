import type { SignIn } from "../server/account";
import { requestGenerations, shownProblem } from "../server/client";
import {
  collectionOperations,
  type CollectionDescription,
  type CollectionRecord,
  type PhoneCollection,
  type RecordCursor,
  type RecordId,
} from "../server/phoneCollections";
import type { ReadProblem } from "../server/workspaceData";

// The open workspace's transactional Collections, and the one Collection on screen, in memory only.
//
// One store per sign-in and workspace. Its answers land only while its sign-in is current and it hasn't stopped, and
// each read only while it is the latest of its kind, so a late answer never paints another workspace or table. The
// account stops it, dropping everything it read, before other work at Sign out, a sign-in change (a 401 included), a
// workspace switch and Show on phone off (appTeardown, through collectionStores).

export interface CollectionsState {
  readonly collections: readonly PhoneCollection[] | null;
  readonly problem: ReadProblem | null;
  readonly failures: number;
}

/** The Collection on screen: its tables, and the records of one, read a page at a time. */
export interface CollectionView {
  readonly datasetId: string;
  readonly description: CollectionDescription | null;
  readonly tableId: string | null;
  readonly rows: readonly CollectionRecord[];
  readonly files: Readonly<Record<string, string>>;
  readonly next: RecordCursor | null;
  /** `first` reads the table from its start, `refresh` reads it again while it shows, `more` its next page. */
  readonly reading: "first" | "refresh" | "more" | null;
  /** Nothing in the Collection reads this table. */
  readonly refused: boolean;
  readonly problem: ReadProblem | null;
  /** The failed read was the next page's, so Try again reads it again. */
  readonly moreFailed: boolean;
}

export interface WorkspaceCollections {
  readonly signIn: object;
  readonly workspaceId: string;
  state(): CollectionsState;
  view(): CollectionView | null;
  subscribe(listener: () => void): () => void;
  /** Reads the list again. Only the latest read lands. */
  refresh(): Promise<void>;
  /** Puts `datasetId` on screen and reads it, replacing the last one. */
  open(datasetId: string): Promise<void>;
  /** Leaves `datasetId`, unless another Collection replaced it. */
  close(datasetId: string): void;
  /** Reads the Collection on screen again: its tables, then its table's first page. */
  reload(): Promise<void>;
  chooseTable(tableId: string): Promise<void>;
  /** Reads the next page, unless the table has none or a read is running. */
  more(): Promise<void>;
  /** A record of the table on screen, or null. */
  record(datasetId: string, tableId: string, id: RecordId): CollectionRecord | null;
  stop(): void;
}

const NO_LIST: CollectionsState = { collections: null, problem: null, failures: 0 };

export function createWorkspaceCollections(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent">;
  readonly workspaceId: string;
  readonly onStop?: () => void;
}): WorkspaceCollections {
  const { signIn, workspaceId } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const operations = collectionOperations(signIn.client, workspaceId, signal);
  const listReads = requestGenerations();
  const viewReads = requestGenerations();
  const listeners = new Set<() => void>();
  let list = NO_LIST;
  let view: CollectionView | null = null;
  const isLive = () => !signal.aborted && signIn.isCurrent();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const update = (datasetId: string, change: Partial<CollectionView>) => {
    if (view?.datasetId !== datasetId) return;
    view = { ...view, ...change };
    emit();
  };

  const refresh = async () => {
    const request = listReads.next();
    const lands = () => isLive() && listReads.isLatest(request);
    try {
      const collections = await operations.list();
      if (!lands()) return;
      list = { collections, problem: null, failures: list.failures };
      emit();
    } catch (error) {
      const problem = shownProblem(error);
      if (!lands() || problem === null) return;
      list = { ...list, problem, failures: list.failures + 1 };
      emit();
    }
  };

  // The table from its start, after the Collection's tables when `describe` is set or none are known yet. What shows
  // stays until the answer replaces it.
  async function read(mode: "first" | "refresh", describe: boolean) {
    if (!view) return;
    const { datasetId } = view;
    const request = viewReads.next();
    const lands = () => isLive() && viewReads.isLatest(request) && view?.datasetId === datasetId;
    update(datasetId, { reading: mode });
    try {
      const description =
        describe || !view.description ? await operations.describe(datasetId) : view.description;
      if (!lands()) return;
      const table =
        description.tables.find((table) => table.tableId === view?.tableId) ??
        description.tables[0];
      const page = table ? await operations.records(datasetId, table, null) : null;
      if (!lands()) return;
      update(datasetId, {
        description,
        tableId: table?.tableId ?? null,
        rows: page?.status === "ready" ? page.rows : [],
        files: page?.status === "ready" ? page.files : {},
        next: page?.status === "ready" ? page.next : null,
        refused: page?.status === "refused",
        reading: null,
        problem: null,
        moreFailed: false,
      });
    } catch (error) {
      const problem = shownProblem(error);
      if (lands())
        update(datasetId, {
          reading: null,
          problem: problem ?? view?.problem ?? null,
          moreFailed: false,
        });
    }
  }

  return {
    signIn,
    workspaceId,
    state: () => list,
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    open(datasetId) {
      if (!isLive()) return Promise.resolve();
      view = {
        datasetId,
        description: null,
        tableId: null,
        rows: [],
        files: {},
        next: null,
        reading: null,
        refused: false,
        problem: null,
        moreFailed: false,
      };
      emit();
      return read("first", true);
    },
    close(datasetId) {
      if (view?.datasetId !== datasetId) return;
      viewReads.next();
      view = null;
      emit();
    },
    reload: () => read("refresh", true),
    chooseTable(tableId) {
      if (!view || view.tableId === tableId) return Promise.resolve();
      update(view.datasetId, { tableId, rows: [], files: {}, next: null, refused: false });
      return read("first", false);
    },
    async more() {
      const now = view;
      const table = now?.description?.tables.find((table) => table.tableId === now.tableId);
      if (!now || !table || !now.next || now.reading !== null || now.refused) return;
      const { datasetId } = now;
      // A newer read of the table, or another table, drops this page.
      const request = viewReads.next();
      const lands = () => isLive() && viewReads.isLatest(request) && view?.datasetId === datasetId;
      update(datasetId, { reading: "more" });
      try {
        const page = await operations.records(datasetId, table, now.next);
        if (!lands() || !view) return;
        update(
          datasetId,
          page.status === "ready"
            ? {
                rows: [...view.rows, ...page.rows],
                files: { ...view.files, ...page.files },
                next: page.next,
                reading: null,
                problem: null,
                moreFailed: false,
              }
            : { rows: [], next: null, refused: true, reading: null },
        );
      } catch (error) {
        const problem = shownProblem(error);
        if (lands())
          update(datasetId, {
            reading: null,
            problem: problem ?? view?.problem ?? null,
            moreFailed: problem !== null,
          });
      }
    },
    record(datasetId, tableId, id) {
      if (view?.datasetId !== datasetId || view.tableId !== tableId) return null;
      const key = JSON.stringify(id);
      return view.rows.find((row) => JSON.stringify(row.id) === key) ?? null;
    },
    stop() {
      if (signal.aborted) return;
      controller.abort();
      list = NO_LIST;
      view = null;
      emit();
      options.onStop?.();
    },
  };
}

/**
 * Every store the account made, so the account can end them before other work, as it ends a running app (appTeardown).
 */
export function createCollectionStores() {
  const live = new Set<WorkspaceCollections>();
  return {
    create(signIn: Pick<SignIn, "client" | "isCurrent">, workspaceId: string) {
      const store = createWorkspaceCollections({
        signIn,
        workspaceId,
        onStop: () => live.delete(store),
      });
      live.add(store);
      return store;
    },
    end(match: (scope: { signIn: object; workspaceId: string }) => boolean = () => true) {
      for (const store of [...live]) if (match(store)) store.stop();
    },
  };
}
