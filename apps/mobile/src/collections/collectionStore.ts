import type { ScopedEnds } from "../pages/pageLive";
import type { SignIn } from "../server/account";
import { requestGenerations, ServerError, shownProblem } from "../server/client";
import {
  collectionOperations,
  type ChangeAnswer,
  type CollectionDescription,
  type CollectionField,
  type CollectionRecord,
  type FieldChange,
  type PhoneCollection,
  type RecordCursor,
  type RecordId,
  type RecordValue,
} from "../server/phoneCollections";
import type { ReadProblem } from "../server/workspaceData";

// The open workspace's transactional Collections, and the one Collection on screen, in memory only.
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

export const recordKey = (datasetId: string, tableId: string, id: RecordId): string =>
  JSON.stringify([datasetId, tableId, id]);

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
  /** The record's screen closed, so a Reload on its way no longer lands. */
  closeRecord(): void;
  /** Each record's last change, by `recordKey`. */
  changes(): ReadonlyMap<string, RecordChange>;
  /** A field of the open record as its editor starts, or null when the phone can't change it. */
  edit(fieldId: string): FieldEdit | null;
  /** Sends `value` as `edit` opened it, unless the record's last change is still saving. */
  change(edit: FieldEdit, value: RecordValue): void;
  /** Sends a failed change again, as it was. */
  retry(key: string): void;
  /** Drops a change that isn't saving. */
  discard(key: string): void;
  undo(key: string): void;
  /** Reads the Collection's rules and the open record again, and drops its change. False when that failed. */
  reloadRecord(): Promise<boolean>;
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
  const recordReads = requestGenerations();
  const listeners = new Set<() => void>();
  let list = NO_LIST;
  let view: CollectionView | null = null;
  let changes: ReadonlyMap<string, RecordChange> = new Map();
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
    recordReads.next();
    list = NO_LIST;
    view = null;
    changes = new Map();
    emit();
  };
  const remove = ends.add({ signIn, workspaceId }, { end: clear });

  const setChange = (key: string, next: RecordChange | null) => {
    const copy = new Map(changes);
    if (next) copy.set(key, next);
    else copy.delete(key);
    changes = copy;
    emit();
  };
  // The record as a saved change left it, wherever the Collection on screen shows it.
  const saved = (
    { datasetId, tableId, recordId, fieldId, value }: FieldChange,
    version: number,
  ) => {
    const now = view;
    if (now?.datasetId !== datasetId) return;
    const patch = (record: CollectionRecord) =>
      record.id === recordId
        ? { ...record, version, values: { ...record.values, [fieldId]: value } }
        : record;
    const { opened } = now;
    update(datasetId, {
      rows: now.tableId === tableId ? now.rows.map(patch) : now.rows,
      opened: opened?.tableId === tableId ? { ...opened, record: patch(opened.record) } : opened,
    });
  };
  // An answer lands only while its change is still the record's, so one Discard dropped, or a store cleared, never
  // comes back.
  async function send(key: string, entry: Omit<RecordChange, "state">, retry = false) {
    if (!isLive()) return;
    const sent: RecordChange = { ...entry, state: { kind: "saving" } };
    setChange(key, sent);
    const lands = () => isLive() && changes.get(key) === sent;
    try {
      const answer = await operations.change(sent.change);
      if (!lands()) return;
      setChange(key, { ...sent, state: answer });
      if (answer.kind === "saved") saved(sent.change, answer.version);
    } catch (error) {
      const problem = shownProblem(error);
      // A cancelled change belongs to a store cleared already, and a 401 clears it.
      if (!lands() || problem === null) return;
      // A retry's key already used: the rules changed between tries, and the first may have saved.
      const used = retry && error instanceof ServerError && error.status === 409;
      setChange(key, {
        ...sent,
        state: used ? { kind: "rulesChanged" } : { kind: "failed", problem },
      });
    }
  }

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
      const held = new Map(
        view.tableId === table?.tableId
          ? view.rows.map((row) => [JSON.stringify(row.id), row])
          : [],
      );
      const rows = (ready?.rows ?? []).map((row) => newest(row, held.get(JSON.stringify(row.id))));
      const fresh =
        opened?.tableId === table?.tableId
          ? rows.find((row) => row.id === opened?.record.id)
          : undefined;
      update(datasetId, {
        description,
        tableId: table?.tableId ?? null,
        rows: more ? [...view.rows, ...rows] : rows,
        files: !ready ? {} : more ? { ...view.files, ...ready.files } : ready.files,
        next: ready?.next ?? null,
        refused: page?.status === "refused",
        reading: null,
        problem: null,
        opened:
          opened && fresh && ready && newest(fresh, opened.record) === fresh
            ? { ...opened, record: fresh, files: ready.files }
            : opened,
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
      recordReads.next();
      if (view?.tableId)
        update(view.datasetId, { opened: { tableId: view.tableId, record, files: view.files } });
    },
    closeRecord: () => void recordReads.next(),
    changes: () => changes,
    edit(fieldId) {
      const opened = view?.opened;
      const description = view?.description;
      const field = description?.tables
        .find((table) => table.tableId === opened?.tableId)
        ?.fields.find((field) => field.fieldId === fieldId);
      if (!view || !opened || !description || !field?.editable || opened.record.version === null)
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
    change({ field, from }, value) {
      const key = recordKey(from.datasetId, from.tableId, from.recordId);
      if (changes.get(key)?.state.kind === "saving") return;
      void send(key, {
        change: { ...from, value, idempotencyKey: crypto.randomUUID() },
        reversible: field.reversible,
      });
    },
    retry(key) {
      const last = changes.get(key);
      if (last?.state.kind === "failed") void send(key, last, true);
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
          : { record: null, files: {} };
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
          problem: null,
          opened: record
            ? { ...view.opened, record, files: record === held ? view.opened.files : read.files }
            : null,
        });
        if (changes.get(key)?.state.kind !== "saving") setChange(key, null);
        return record !== null;
      } catch (error) {
        const cause = shownProblem(error);
        if (lands() && cause) update(datasetId, { problem: { cause, more: false } });
        return false;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      remove();
      clear();
    },
  };
}
