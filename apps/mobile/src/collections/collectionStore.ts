import type { ScopedEnds } from "../pages/pageLive";
import type { SignIn } from "../server/account";
import { requestGenerations, shownProblem } from "../server/client";
import {
  collectionOperations,
  type CollectionDescription,
  type CollectionRecord,
  type PhoneCollection,
  type RecordCursor,
} from "../server/phoneCollections";
import type { ReadProblem } from "../server/workspaceData";

// The open workspace's transactional Collections, and the one Collection on screen, in memory only.
//
// One store per sign-in and workspace. Its answers land only while its sign-in is current and it hasn't stopped, and
// each read only while it is the latest of its kind, so a late answer never paints another workspace or table. The
// account clears it, dropping what it read and every read on its way, before other work at Sign out, a sign-in change
// (a 401 included), a workspace switch and Show on phone off (appTeardown). A Sign out that fails keeps the sign-in, so
// the store reads again when asked.

export interface CollectionsState {
  readonly collections: readonly PhoneCollection[] | null;
  readonly problem: ReadProblem | null;
  readonly failures: number;
}

/** The record on its own screen, with its files' names. A refresh that reads pages without it keeps it. */
export interface OpenRecord {
  readonly tableId: string;
  readonly record: CollectionRecord;
  readonly files: Readonly<Record<string, string>>;
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
  /** Why the last read failed, and whether it was the next page's, which Try again reads again. */
  readonly problem: { readonly cause: ReadProblem; readonly more: boolean } | null;
  readonly opened: OpenRecord | null;
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
  /** Keeps a record of the table on screen for its own screen. */
  openRecord(record: CollectionRecord): void;
  stop(): void;
}

const NO_LIST: CollectionsState = { collections: null, problem: null, failures: 0 };

export function createWorkspaceCollections(
  signIn: Pick<SignIn, "client" | "isCurrent">,
  workspaceId: string,
  ends: Pick<ScopedEnds, "add">,
): WorkspaceCollections {
  let controller = new AbortController();
  let operations = collectionOperations(signIn.client, workspaceId, controller.signal);
  let stopped = false;
  const listReads = requestGenerations();
  const viewReads = requestGenerations();
  const listeners = new Set<() => void>();
  let list = NO_LIST;
  let view: CollectionView | null = null;
  const isLive = () => !stopped && signIn.isCurrent();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const update = (datasetId: string, change: Partial<CollectionView>) => {
    if (view?.datasetId !== datasetId) return;
    view = { ...view, ...change };
    emit();
  };
  const clear = () => {
    controller.abort();
    controller = new AbortController();
    operations = collectionOperations(signIn.client, workspaceId, controller.signal);
    listReads.next();
    viewReads.next();
    list = NO_LIST;
    view = null;
    emit();
  };
  const remove = ends.add({ signIn, workspaceId }, { end: clear });

  const refresh = async () => {
    if (!isLive()) return;
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

  // A page of the table on screen, after the Collection's tables when `describe` is set or none are known yet: from the
  // table's start, replacing what shows once it lands, or for `more` after the last, adding to it.
  async function read(mode: "first" | "refresh" | "more", describe: boolean) {
    const now = view;
    if (!now) return;
    const { datasetId } = now;
    const request = viewReads.next();
    const lands = () => isLive() && viewReads.isLatest(request) && view?.datasetId === datasetId;
    const more = mode === "more";
    update(datasetId, { reading: mode });
    try {
      const description =
        describe || !now.description ? await operations.describe(datasetId) : now.description;
      if (!lands()) return;
      const table =
        description.tables.find((table) => table.tableId === now.tableId) ?? description.tables[0];
      const page = table
        ? await operations.records(datasetId, table, more ? now.next : null)
        : null;
      if (!lands() || !view) return;
      const ready = page?.status === "ready" ? page : null;
      const { opened } = view;
      const fresh =
        opened?.tableId === table?.tableId
          ? ready?.rows.find((row) => row.id === opened?.record.id)
          : undefined;
      update(datasetId, {
        description,
        tableId: table?.tableId ?? null,
        rows: !ready ? [] : more ? [...view.rows, ...ready.rows] : ready.rows,
        files: !ready ? {} : more ? { ...view.files, ...ready.files } : ready.files,
        next: ready?.next ?? null,
        refused: page?.status === "refused",
        reading: null,
        problem: null,
        opened:
          opened && fresh && ready ? { ...opened, record: fresh, files: ready.files } : opened,
      });
    } catch (error) {
      const cause = shownProblem(error);
      if (lands())
        update(datasetId, {
          reading: null,
          problem: cause ? { cause, more } : (view?.problem ?? null),
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
        opened: null,
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
    more: () =>
      view?.next && view.reading === null && !view.refused
        ? read("more", false)
        : Promise.resolve(),
    openRecord(record) {
      if (view?.tableId)
        update(view.datasetId, { opened: { tableId: view.tableId, record, files: view.files } });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      remove();
      clear();
    },
  };
}
