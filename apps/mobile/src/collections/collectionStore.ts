import type { WorkspaceRole } from "../server/api";
import type { ScopedEnds } from "../pages/pageLive";
import type { SignIn } from "../server/account";
import { requestGenerations, ServerError, shownProblem } from "../server/client";
import {
  collectionOperations,
  type ChangeAnswer,
  type CollectionDescription,
  type CollectionField,
  type CollectionRecord,
  type CollectionTable,
  type FieldChange,
  type PhoneCollection,
  type RecordCreate,
  type RecordCursor,
  type RecordDelete,
  type RecordId,
  type RecordSort,
  type RecordValue,
  type RelationLabels,
  type RelationOptionsPage,
  type WriteRefusal,
} from "../server/phoneCollections";
import { cachedList, views, type ReadCache, type ReadProblem } from "../server/workspaceData";
import { supportsSort } from "./collectionFields";

// The open workspace's transactional Collections, and the one Collection on screen. The list is kept in the read
// cache with the workspace's views. Each Collection opened stays in memory, so opening it again shows it at once while
// it reads again, its tables first whatever table is chosen meanwhile. One the server refuses shows as refused.
//
// One store per sign-in and workspace. Its answers land only while its sign-in is current and it hasn't stopped, and
// each read only while it is the latest of its kind, so a late answer never paints another workspace or table. The
// account clears it, dropping what it read and every read on its way, before other work at Sign out, a sign-in change
// (a 401 included), a workspace switch and Show on phone off (appTeardown). A Sign out that fails keeps the sign-in, so
// the store reads again when asked.

/** A record's last change and where it stands. An Undo isn't `reversible`, so nothing undoes it. */
export interface RecordChange {
  readonly change: FieldChange;
  readonly reversible: boolean;
  readonly relationLabels?: Readonly<Record<string, string>>;
  readonly state:
    | { readonly kind: "saving" }
    | ChangeAnswer
    | { readonly kind: "failed"; readonly problem: ReadProblem };
}

/** A field of the open record as its editor opened: its value then, and the version and rules a change names. */
export interface FieldEdit {
  readonly field: CollectionField;
  readonly from: Omit<FieldChange, "idempotencyKey">;
}

/** A new record per table, or a deletion per record; a saved deletion stays until its record shows again. */
export type RecordAction = (
  | { readonly kind: "create"; readonly request: RecordCreate; readonly table: CollectionTable }
  | { readonly kind: "delete"; readonly request: RecordDelete }
) & {
  readonly state:
    | { readonly kind: "saving" }
    | { readonly kind: "saved" }
    | WriteRefusal
    | { readonly kind: "failed"; readonly problem: ReadProblem };
};

export const recordKey = (datasetId: string, tableId: string, id: RecordId): string =>
  JSON.stringify([datasetId, tableId, id]);
export const newRecordKey = (datasetId: string, tableId: string): string =>
  JSON.stringify([datasetId, tableId]);

export const canUndo = (last: RecordChange | undefined): boolean =>
  last?.state.kind === "saved" && last.reversible && "priorValue" in last.state;

// An older read never undoes what the phone holds of a later version, such as a confirmed change's.
const newest = (read: CollectionRecord, held: CollectionRecord | undefined): CollectionRecord =>
  held && (held.version ?? 0) > (read.version ?? 0) ? held : read;

/** Undo's change: the prior value, at the saved version, under the rules the edit ran under, with a new key. */
export function undoChange(last: RecordChange): FieldChange | null {
  const { state } = last;
  if (!canUndo(last) || state.kind !== "saved") return null;
  return {
    ...last.change,
    value: state.priorValue ?? null,
    expectedVersion: state.version,
    idempotencyKey: crypto.randomUUID(),
  };
}

export interface CollectionsState {
  readonly collections: readonly PhoneCollection[] | null;
  readonly problem: ReadProblem | null;
  readonly failures: number;
}

const mergeRelations = (base: RelationLabels, added: RelationLabels): RelationLabels => {
  if (!Object.keys(added).length) return base;
  const out: Record<string, Readonly<Record<string, string>>> = { ...base };
  for (const [fid, map] of Object.entries(added)) out[fid] = { ...out[fid], ...map };
  return out;
};

/** The record on its own screen, with its files' names and relation labels. */
export interface OpenRecord {
  readonly tableId: string;
  readonly record: CollectionRecord;
  readonly files: Readonly<Record<string, string>>;
  readonly relations: RelationLabels;
}

/** The Collection on screen: its tables, and the records of one, read a page at a time. */
export interface CollectionView {
  readonly datasetId: string;
  readonly description: CollectionDescription | null;
  readonly tableId: string | null;
  readonly rows: readonly CollectionRecord[];
  readonly files: Readonly<Record<string, string>>;
  readonly relations: RelationLabels;
  readonly next: RecordCursor | null;
  readonly search: string;
  readonly sort: RecordSort | null;
  /** `first` reads the table from its start, `refresh` reads it again while it shows, `more` its next page. */
  readonly reading: "first" | "refresh" | "more" | null;
  /** Nothing in the Collection reads this table. */
  readonly refused: boolean;
  readonly queryUnsupported: boolean;
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
  setQuery(patch: { readonly search?: string; readonly sort?: RecordSort | null }): Promise<void>;
  relationOptions(
    tableId: string,
    fieldId: string,
    search: string,
    after: RecordCursor | null,
    signal?: AbortSignal,
  ): Promise<RelationOptionsPage>;
  /** Reads the next page, unless the table has none or a read is running. */
  more(): Promise<void>;
  /** Keeps a record of the table on screen for its own screen. */
  openRecord(record: CollectionRecord): void;
  /** The record's screen closed, so a Reload on its way no longer lands. */
  closeRecord(): void;
  /** Each record's last change, by `recordKey`. */
  changes(): ReadonlyMap<string, RecordChange>;
  /** A field of the open record as its editor starts, or null when the phone can't change it. */
  edit(fieldId: string): FieldEdit | null;
  /** Sends `value` as `edit` opened it, unless the record's last change is still saving. */
  change(
    edit: FieldEdit,
    value: RecordValue,
    relationLabels?: Readonly<Record<string, string>>,
  ): void;
  /** Sends a failed change again, as it was. */
  retry(key: string): void;
  /** Drops a change that isn't saving. */
  discard(key: string): void;
  undo(key: string): void;
  /** Reads the Collection's rules and the open record again, and drops its change. False when that failed. */
  reloadRecord(): Promise<boolean>;
  actions(): ReadonlyMap<string, RecordAction>;
  /** Adds a record to the table on screen and lists it first; true if it opened, as no other record did meanwhile. */
  create(values?: Readonly<Record<string, RecordValue>>): Promise<boolean>;
  remove(): void;
  retryAction(key: string): Promise<boolean>;
  discardAction(key: string): void;
  stop(): void;
}

const NO_LIST: CollectionsState = { collections: null, problem: null, failures: 0 };

export function createWorkspaceCollections(
  signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">,
  workspaceId: string,
  ends: Pick<ScopedEnds, "add">,
  cache: ReadCache,
  role: WorkspaceRole = "owner",
  open: () => boolean = () => true,
): WorkspaceCollections {
  let controller = new AbortController();
  let operations = collectionOperations(signIn.client, workspaceId, controller.signal);
  let stopped = false;
  const listReads = requestGenerations();
  const viewReads = requestGenerations();
  const recordReads = requestGenerations();
  const listeners = new Set<() => void>();
  const listed = cachedList(cache, signIn, workspaceId, views.collections, role);
  let list: CollectionsState = { ...NO_LIST, collections: listed.value() };
  let view: CollectionView | null = null;
  const held = new Map<string, CollectionView>();
  let described: string | null = null;
  let changes: ReadonlyMap<string, RecordChange> = new Map();
  let actions: ReadonlyMap<string, RecordAction> = new Map();
  const isLive = () => !stopped && signIn.isCurrent() && open();
  const busy = (key: string) => {
    const action = actions.get(key)?.state.kind;
    return action === "saving" || action === "saved" || changes.get(key)?.state.kind === "saving";
  };
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
    recordReads.next();
    list = NO_LIST;
    view = null;
    held.clear();
    changes = new Map();
    actions = new Map();
    emit();
  };
  const remove = ends.add({ signIn, workspaceId }, { end: clear });
  void listed.restored.then(() => {
    const collections = listed.value();
    if (!isLive() || list.collections !== null || !collections) return;
    list = { ...list, collections };
    emit();
  });

  const setChange = (key: string, next: RecordChange | null) => {
    const copy = new Map(changes);
    if (next) copy.set(key, next);
    else copy.delete(key);
    changes = copy;
    emit();
  };
  const saved = (
    { datasetId, tableId, recordId, fieldId, value }: FieldChange,
    version: number,
    relationLabels?: Readonly<Record<string, string>>,
  ) => {
    const now = view;
    if (now?.datasetId !== datasetId) return;
    // A replayed receipt can be older than what a later read showed; that read wins.
    const patch = (record: CollectionRecord) =>
      record.id === recordId && (record.version ?? 0) < version
        ? { ...record, version, values: { ...record.values, [fieldId]: value } }
        : record;
    const added: RelationLabels =
      relationLabels && Object.keys(relationLabels).length ? { [fieldId]: relationLabels } : {};
    const { opened } = now;
    update(datasetId, {
      rows: now.tableId === tableId ? now.rows.map(patch) : now.rows,
      relations: now.tableId === tableId ? mergeRelations(now.relations, added) : now.relations,
      opened:
        opened?.tableId === tableId
          ? {
              ...opened,
              record: patch(opened.record),
              relations: mergeRelations(opened.relations, added),
            }
          : opened,
    });
  };
  // An answer lands only while its change is still the record's, so one Discard dropped, or a store cleared, never
  // comes back.
  async function send(key: string, entry: Omit<RecordChange, "state">) {
    if (!isLive() || busy(key)) return;
    const sent: RecordChange = { ...entry, state: { kind: "saving" } };
    setChange(key, sent);
    const lands = () => isLive() && changes.get(key) === sent;
    try {
      const answer = await operations.change(sent.change);
      if (!lands()) return;
      setChange(key, { ...sent, state: answer });
      if (answer.kind === "saved") saved(sent.change, answer.version, sent.relationLabels);
    } catch (error) {
      const problem = shownProblem(error);
      // A cancelled change belongs to a store cleared already, and a 401 clears it.
      if (!lands() || problem === null) return;
      setChange(key, { ...sent, state: { kind: "failed", problem } });
    }
  }

  const setAction = (key: string, next: RecordAction | null) => {
    const copy = new Map(actions);
    if (next) copy.set(key, next);
    else copy.delete(key);
    actions = copy;
    emit();
  };
  // A saved deletion's record that shows again was added again.
  const forget = (key: string) => {
    if (actions.get(key)?.state.kind === "saved") setAction(key, null);
  };
  // A read of the table on its way may have started before a write saved, so it starts again.
  const reread = (reading: CollectionView["reading"]) => {
    if (reading) void read(reading, reading !== "more");
  };
  // As `send`: an answer lands only while its action is still the key's.
  async function act(key: string, entry: RecordAction): Promise<boolean> {
    if (!isLive() || busy(key)) return false;
    const sent: RecordAction = { ...entry, state: { kind: "saving" } };
    setAction(key, sent);
    const lands = () => isLive() && actions.get(key) === sent;
    // A new record opens only if no record opened or closed while it saved.
    const screen = sent.kind === "create" ? recordReads.next() : null;
    try {
      const { datasetId, tableId } = sent.request;
      const shown = () => (view?.datasetId === datasetId && view.tableId === tableId ? view : null);
      if (sent.kind === "delete") {
        const answer = await operations.remove(sent.request);
        if (!lands()) return false;
        setAction(key, { ...sent, state: answer });
        if (answer.kind !== "saved") return false;
        setChange(key, null);
        const { recordId } = sent.request;
        const now = shown();
        if (now) {
          update(datasetId, { rows: now.rows.filter((row) => row.id !== recordId) });
          reread(now.reading);
        }
        return true;
      }
      const answer = await operations.create(sent.request);
      if (!lands()) return false;
      if (answer.kind !== "saved") {
        setAction(key, { ...sent, state: answer });
        return false;
      }
      // The record as it is now: with the rules' defaults, and any change since, if this answer was a replay.
      const created = recordKey(datasetId, tableId, answer.id);
      const deletionBefore = actions.get(created);
      const current = await operations.record(datasetId, sent.table, answer.id);
      if (!lands()) return false;
      setAction(key, null);
      const now = shown();
      // A deletion that saved while this read was on its way wins over what the read saw.
      if (!now || !current.record || actions.get(created) !== deletionBefore) return false;
      forget(created);
      const record = newest(
        current.record,
        now.rows.find((row) => row.id === answer.id),
      );
      const opens = screen !== null && recordReads.isLatest(screen);
      update(datasetId, {
        rows: [record, ...now.rows.filter((row) => row.id !== record.id)],
        files: { ...now.files, ...current.files },
        relations: mergeRelations(now.relations, current.relations),
        ...(opens
          ? { opened: { tableId, record, files: current.files, relations: current.relations } }
          : {}),
      });
      reread(now.reading);
      return opens;
    } catch (error) {
      const problem = shownProblem(error);
      if (lands() && problem !== null)
        setAction(key, { ...sent, state: { kind: "failed", problem } });
      return false;
    }
  }

  const refresh = async () => {
    if (!isLive()) return;
    const request = listReads.next();
    const lands = () => isLive() && listReads.isLatest(request);
    try {
      const [collections] = await Promise.all([operations.list(), listed.restored]);
      if (!lands()) return;
      listed.save(collections);
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
        describe || !now.description || described !== datasetId
          ? await operations.describe(datasetId)
          : now.description;
      if (!lands()) return;
      const table =
        description.tables.find((table) => table.tableId === now.tableId) ?? description.tables[0];
      const activeSort =
        table &&
        now.sort &&
        table.fields.some((f) => f.fieldId === now.sort!.fieldId && supportsSort(f))
          ? now.sort
          : null;
      const sameSort = activeSort === now.sort;
      const page = table
        ? await operations.records(datasetId, table, more && sameSort ? now.next : null, {
            search: now.search,
            sort: activeSort,
          })
        : null;
      if (!lands() || !view) return;
      described = datasetId;
      if (page?.status === "unsupported-query") {
        update(datasetId, {
          description,
          tableId: table?.tableId ?? null,
          sort: activeSort,
          rows: [],
          files: {},
          relations: {},
          next: null,
          refused: false,
          queryUnsupported: true,
          reading: null,
          problem: null,
        });
        return;
      }
      const ready = page?.status === "ready" ? page : null;
      const { opened } = view;
      const held = new Map(
        view.tableId === table?.tableId
          ? view.rows.map((row) => [JSON.stringify(row.id), row])
          : [],
      );
      const rows = (ready?.rows ?? []).map((row) => newest(row, held.get(JSON.stringify(row.id))));
      const pageRows = new Map(rows.map((row) => [JSON.stringify(row.id), row]));
      const fresh =
        opened?.tableId === table?.tableId
          ? rows.find((row) => row.id === opened?.record.id)
          : undefined;
      update(datasetId, {
        description,
        tableId: table?.tableId ?? null,
        sort: activeSort,
        // A record added here can come again in a later page.
        rows:
          more && sameSort && ready
            ? [
                ...view.rows.map((row) => pageRows.get(JSON.stringify(row.id)) ?? row),
                ...rows.filter((row) => !held.has(JSON.stringify(row.id))),
              ]
            : rows,
        files: !ready ? {} : more && sameSort ? { ...view.files, ...ready.files } : ready.files,
        relations: !ready
          ? {}
          : more && sameSort
            ? mergeRelations(view.relations, ready.relations)
            : ready.relations,
        next: ready?.next ?? null,
        refused: page?.status === "refused",
        queryUnsupported: false,
        reading: null,
        problem: null,
        opened:
          page?.status === "refused" && opened?.tableId === table?.tableId
            ? null
            : opened && fresh && ready && newest(fresh, opened.record) === fresh
              ? { ...opened, record: fresh, files: ready.files, relations: ready.relations }
              : opened,
      });
    } catch (error) {
      const cause = shownProblem(error);
      if (!lands()) return;
      const refused =
        cause === "refused" && !(error instanceof ServerError && error.status === 413);
      if (refused) held.delete(datasetId);
      update(datasetId, {
        ...(refused
          ? {
              description: null,
              rows: [],
              files: {},
              relations: {},
              next: null,
              queryUnsupported: false,
              opened: null,
            }
          : {}),
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
      const last = held.get(datasetId);
      described = null;
      view = last
        ? { ...last, search: "", sort: null, queryUnsupported: false, problem: null, opened: null }
        : {
            datasetId,
            description: null,
            tableId: null,
            rows: [],
            files: {},
            relations: {},
            next: null,
            search: "",
            sort: null,
            reading: null,
            refused: false,
            queryUnsupported: false,
            problem: null,
            opened: null,
          };
      emit();
      return read("first", true);
    },
    close(datasetId) {
      if (view?.datasetId !== datasetId) return;
      viewReads.next();
      if (view.refused) held.delete(datasetId);
      else held.set(datasetId, { ...view, reading: null });
      view = null;
      emit();
    },
    reload: () => read("refresh", true),
    chooseTable(tableId) {
      if (!view || view.tableId === tableId) return Promise.resolve();
      update(view.datasetId, {
        tableId,
        rows: [],
        files: {},
        relations: {},
        next: null,
        search: "",
        sort: null,
        refused: false,
        queryUnsupported: false,
      });
      return read("first", false);
    },
    setQuery(patch) {
      if (!view) return Promise.resolve();
      const search = patch.search !== undefined ? patch.search.slice(0, 200) : view.search;
      const sort = patch.sort !== undefined ? patch.sort : view.sort;
      if (
        search === view.search &&
        JSON.stringify(sort) === JSON.stringify(view.sort) &&
        !view.queryUnsupported
      )
        return Promise.resolve();
      update(view.datasetId, { search, sort, next: null, queryUnsupported: false });
      return read("first", false);
    },
    relationOptions(tableId, fieldId, search, after, signal) {
      if (!isLive() || !view) return Promise.reject(new ServerError("cancelled"));
      return operations.relationOptions(view.datasetId, tableId, fieldId, search, after, signal);
    },
    more: () =>
      view?.next && view.reading === null && !view.refused && !view.queryUnsupported
        ? read("more", false)
        : Promise.resolve(),
    openRecord(record) {
      recordReads.next();
      if (!view?.tableId) return;
      forget(recordKey(view.datasetId, view.tableId, record.id));
      update(view.datasetId, {
        opened: { tableId: view.tableId, record, files: view.files, relations: view.relations },
      });
    },
    closeRecord: () => void recordReads.next(),
    changes: () => changes,
    edit(fieldId) {
      const opened = view?.opened;
      const description = view?.description;
      const field = description?.tables
        .find((table) => table.tableId === opened?.tableId)
        ?.fields.find((field) => field.fieldId === fieldId);
      if (
        !view ||
        !opened ||
        !description ||
        !field?.editable ||
        opened.record.version === null ||
        busy(recordKey(view.datasetId, opened.tableId, opened.record.id))
      )
        return null;
      return {
        field,
        from: {
          datasetId: view.datasetId,
          tableId: opened.tableId,
          recordId: opened.record.id,
          fieldId,
          value: opened.record.values[fieldId] ?? null,
          expectedVersion: opened.record.version,
          revision: description.revision,
          revisionSha256: description.revisionSha256,
        },
      };
    },
    change({ field, from }, value, relationLabels) {
      void send(recordKey(from.datasetId, from.tableId, from.recordId), {
        change: { ...from, value, idempotencyKey: crypto.randomUUID() },
        reversible: field.reversible,
        ...(relationLabels ? { relationLabels } : {}),
      });
    },
    retry(key) {
      const last = changes.get(key);
      if (last?.state.kind === "failed") void send(key, last);
    },
    discard(key) {
      if (changes.has(key) && changes.get(key)?.state.kind !== "saving") setChange(key, null);
    },
    undo(key) {
      const last = changes.get(key);
      const change = last && undoChange(last);
      if (change) void send(key, { change, reversible: false });
    },
    async reloadRecord() {
      const now = view;
      const opened = now?.opened;
      if (!isLive() || !now || !opened) return false;
      const { datasetId } = now;
      const { tableId } = opened;
      const id = opened.record.id;
      const key = recordKey(datasetId, tableId, id);
      // Reload clears the change it was asked for, never one made while it read.
      const asked = changes.get(key);
      const request = recordReads.next();
      const lands = () =>
        isLive() &&
        recordReads.isLatest(request) &&
        view?.datasetId === datasetId &&
        view.opened?.tableId === tableId &&
        view.opened.record.id === id;
      try {
        const description = await operations.describe(datasetId);
        if (!lands()) return false;
        const table = description.tables.find((table) => table.tableId === tableId);
        const read = table
          ? await operations.record(datasetId, table, id)
          : { record: null, files: {}, relations: {} };
        if (!lands() || !view?.opened) return false;
        const held = view.opened.record;
        const record = read.record && newest(read.record, held);
        const shown = view.tableId === tableId;
        // A record that's gone leaves its screen, which says so.
        update(datasetId, {
          description,
          rows: !shown
            ? view.rows
            : record
              ? view.rows.map((row) => (row.id === id ? newest(record, row) : row))
              : view.rows.filter((row) => row.id !== id),
          files: shown ? { ...view.files, ...read.files } : view.files,
          relations: shown ? mergeRelations(view.relations, read.relations) : view.relations,
          problem: null,
          opened: record
            ? {
                ...view.opened,
                record,
                files: record === held ? view.opened.files : read.files,
                relations: record === held ? view.opened.relations : read.relations,
              }
            : null,
        });
        if (asked && changes.get(key) === asked) setChange(key, null);
        return record !== null;
      } catch (error) {
        const cause = shownProblem(error);
        if (lands() && cause) update(datasetId, { problem: { cause, more: false } });
        return false;
      }
    },
    actions: () => actions,
    create(values) {
      const now = view;
      const description = now?.description;
      const table = description?.tables.find((table) => table.tableId === now?.tableId);
      if (!now || !description || !table?.canCreate) return Promise.resolve(false);
      // One that didn't save waits for Try again or Discard, since a failed one may have saved.
      const key = newRecordKey(now.datasetId, table.tableId);
      const existing = actions.get(key);
      if (existing && (existing.state.kind === "saving" || existing.state.kind === "failed"))
        return Promise.resolve(false);
      return act(key, {
        kind: "create",
        table,
        request: {
          datasetId: now.datasetId,
          tableId: table.tableId,
          revision: description.revision,
          revisionSha256: description.revisionSha256,
          idempotencyKey: crypto.randomUUID(),
          ...(values ? { values } : {}),
        },
        state: { kind: "saving" },
      });
    },
    remove() {
      const now = view;
      const opened = now?.opened;
      const description = now?.description;
      const table = description?.tables.find((table) => table.tableId === opened?.tableId);
      if (!now || !opened || !description || !table?.canDelete || opened.record.version === null)
        return;
      void act(recordKey(now.datasetId, table.tableId, opened.record.id), {
        kind: "delete",
        request: {
          datasetId: now.datasetId,
          tableId: table.tableId,
          recordId: opened.record.id,
          expectedVersion: opened.record.version,
          revision: description.revision,
          revisionSha256: description.revisionSha256,
          idempotencyKey: crypto.randomUUID(),
        },
        state: { kind: "saving" },
      });
    },
    retryAction(key) {
      const last = actions.get(key);
      return last?.state.kind === "failed" ? act(key, last) : Promise.resolve(false);
    },
    discardAction(key) {
      const kind = actions.get(key)?.state.kind;
      if (kind !== undefined && kind !== "saving" && kind !== "saved") setAction(key, null);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      remove();
      clear();
    },
  };
}
