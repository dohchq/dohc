import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BoardView,
  CalendarView,
  createCollectionStore,
  TableView,
  useCollectionStore,
  type CollectionCellChange,
  type CollectionOptionCreate,
} from "@dohc/collection-views";
import type {
  CollectionQueryParams,
  CollectionRecord,
  CollectionSchema,
  CollectionValue,
  ViewDefinition,
} from "@dohc/workspace-contracts";
import type { WorkspaceActivityEvent } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { createActivityCoalescer } from "./workspaceActivityCoalescer";
import { useEngineDoc } from "./collab/useEngineDoc";
import { SecondaryButton } from "./ui/controls";
import { FieldsDialog } from "./collections/FieldsDialog";
import { ViewsDialog } from "./collections/ViewsDialog";
import { addSelectOption } from "./collections/schemaAuthoring";
import { rewriteCollectionSchema } from "./collections/schemaWrite";

// The collection surface behind a dohc://collection/<path> tab: the shared
// @dohc/collection-views components bound to the desktop's collections.*
// bridge. Reads come from the engine's index; writes ride the record's live
// document frontmatter map — the SAME path agents and the PropertiesPanel
// take, so attribution and history stay parallel.

// The live document field PropertiesPanel writes; one name for one thing.
const FRONTMATTER_FIELD = "frontmatter";

// How long a cell write may sit "file-locked" before the queue reports it.
// Main's settle retries double from 800 ms to a 10 s cap, so 15 s spans the
// whole ladder: a lock still held then is a program sitting on the file, not
// a blip worth waiting out silently.
export const FILE_LOCKED_REPORT_MS = 15_000;

export interface CollectionPageProps {
  workspaceId: string;
  collectionPath: string;
  // Which view is open is per-user local state the shell persists in the
  // workbench UI state, keyed by collection path — closing the tab or
  // restarting the app must not reset it. null means "no stored choice":
  // the page falls back to the schema's first view.
  activeViewName: string | null;
  onActiveViewChange: (viewName: string | null) => void;
  // The shell creates the record file (untitled naming needs the file
  // listing, which the shell owns) and opens it; adoption mints the id.
  onNewRecord: (collectionPath: string) => void;
  // The md file IS the record: opening one goes through the shell's normal
  // file tab machinery, which composes PropertiesPanel and the live editor.
  onOpenRecord: (recordPath: string) => void;
}

/**
 * Frontmatter values are what js-yaml round-trips. The one indexed shape it
 * cannot carry as-is is bigint (the engine's wire marker for big integers):
 * write it back as a number when exact, else as its decimal text.
 */
export function frontmatterWriteValue(value: CollectionValue): unknown {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= max && value >= -max ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) return value.map(frontmatterWriteValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        frontmatterWriteValue(entry),
      ]),
    );
  }
  return value;
}

/**
 * Applies ONE cell change through the record's live document: open the
 * engine doc session, set the field on the frontmatter map inside a
 * transaction, then hold the lease until the engine reports the save
 * settled (local updates are staged and flushed asynchronously, so
 * releasing at transact time could drop the write). A save stuck
 * "file-locked" past FILE_LOCKED_REPORT_MS reports the lock and releases —
 * the engine holds the write durably and keeps retrying. Renders nothing.
 */
export function CollectionRecordFieldWrite({
  workspaceId,
  change,
  onDone,
  onError,
}: {
  workspaceId: string;
  change: CollectionCellChange;
  onDone: () => void;
  // The full state line the queue shows, or null for its generic one.
  onError: (message: string | null) => void;
}) {
  const docState = useEngineDoc({
    workspaceId,
    path: change.recordPath,
    enabled: true,
  });
  const applied = useRef(false);
  const sawSaving = useRef(false);
  const lockedReport = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (lockedReport.current !== null) clearTimeout(lockedReport.current);
    },
    [],
  );

  useEffect(() => {
    if (applied.current || docState.opening) return;
    if (!docState.available || !docState.doc) {
      // The open settled without a session (conflict, deletion, engine off).
      onError(null);
      onDone();
      return;
    }
    applied.current = true;
    const doc = docState.doc;
    doc.transact(() => {
      doc
        .getMap(FRONTMATTER_FIELD)
        .set(change.field, frontmatterWriteValue(change.value));
    });
  }, [docState.opening, docState.available, docState.doc, change, onDone, onError]);

  useEffect(() => {
    if (!applied.current) return;
    switch (docState.saveState) {
      case "saving":
        sawSaving.current = true;
        return;
      case "saved":
        // Only a "saved" AFTER our own edit was staged counts: the session
        // opens in "saved", and releasing on that one would race the flush.
        if (sawSaving.current) onDone();
        return;
      case "file-locked":
        // Main retries this transient refusal until the lock releases, but
        // nothing bounds that wait. A "file-locked" report means the settle
        // committed — the edit is journaled and its write job durably
        // pending, retried while the session lives and paid after release —
        // so after the window the queue reports the lock and moves on
        // instead of stalling every later edit behind this one. A retry's
        // own saving flip must not reset the window: the timer arms once.
        if (lockedReport.current === null) {
          lockedReport.current = setTimeout(() => {
            const file =
              change.recordPath.split("/").at(-1) ?? change.recordPath;
            onError(
              `Another program has ${file} open, so dohc can't update it on disk. This change is saved and dohc retries until the file is free.`,
            );
            onDone();
          }, FILE_LOCKED_REPORT_MS);
        }
        return;
      case "error":
      case "read-only":
      case "changed-on-disk":
      case "deleted":
        onError(
          docState.saveError
            ? `dohc could not save this change. ${docState.saveError}`
            : null,
        );
        onDone();
        return;
    }
  }, [docState.saveState, docState.saveError, change.recordPath, onDone, onError]);

  return null;
}

function NewRecordButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="collection-new-record"
      onClick={onClick}
      className="rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
    >
      New record
    </button>
  );
}

export function CollectionPage({
  workspaceId,
  collectionPath,
  activeViewName,
  onActiveViewChange,
  onNewRecord,
  onOpenRecord,
}: CollectionPageProps) {
  const [details, setDetails] = useState<{ schema: CollectionSchema } | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // Latest-wins token (engineRebuildToken idiom): only the newest read may
  // write state, so a slow response can never repaint a newer one. The tab
  // is keyed by its path and the shell remounts per workspace, so the pair
  // (workspaceId, collectionPath) is fixed for this component's lifetime —
  // the token guards out-of-order responses within it.
  const detailsRequest = useRef(0);
  const refreshDetails = useCallback(async () => {
    const request = ++detailsRequest.current;
    try {
      const result = await bridge().getCollection({
        workspaceId,
        collectionPath,
      });
      if (request !== detailsRequest.current) return;
      setDetails({ schema: result.schema });
      setLoadError(null);
    } catch (error) {
      if (request !== detailsRequest.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [workspaceId, collectionPath]);
  useEffect(() => {
    void refreshDetails();
    return () => {
      // A response landing after unmount must not write state.
      detailsRequest.current += 1;
    };
  }, [refreshDetails]);

  // The store owns query state and guards its own async responses with a
  // request token; the desktop binds its executor to the query bridge call.
  const executor = useCallback(
    async (params: CollectionQueryParams) =>
      await bridge().queryCollectionRecords({ workspaceId, ...params }),
    [workspaceId],
  );
  const store = useMemo(
    () => createCollectionStore({ collectionPath, executor }),
    [collectionPath, executor],
  );
  const state = useCollectionStore(store);

  const views = details?.schema.views ?? [];
  const activeView: ViewDefinition | null =
    views.find((view) => view.name === activeViewName) ?? views[0] ?? null;

  // One query per (schema arrival, view change): columns need the schema
  // anyway, so nothing is gained by querying before it loads.
  const activeViewKey = activeView
    ? JSON.stringify([
        activeView.name,
        activeView.kind,
        activeView.groupBy,
        activeView.sort,
      ])
    : "";
  const detailsLoaded = details !== null;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  useEffect(() => {
    if (!detailsLoaded) return;
    const view = activeViewRef.current;
    void store.setQuery({
      groupBy:
        view?.kind === "board" && view.groupBy ? view.groupBy : undefined,
      sort: view && view.sort.length > 0 ? view.sort : undefined,
      resolveRelations: true,
    });
  }, [store, detailsLoaded, activeViewKey]);

  // Invalidation: refresh when a settled batch touches this collection's
  // folder (or arrives without path detail), on the shell's trailing-edge
  // coalescing cadence. The store's token makes the refresh latest-wins.
  useEffect(() => {
    const coalescer = createActivityCoalescer(() => {
      void store.refresh();
      void refreshDetails();
    });
    const prefix = `${collectionPath}/`;
    const unsubscribe = bridge().onWorkspaceActivity(
      (event: WorkspaceActivityEvent) => {
        // Another workspace's activity is never this collection's; a
        // scope-free event (logout, registry change) still refreshes.
        if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) {
          return;
        }
        if (
          event.paths?.length &&
          !event.paths.some(
            (path) => path === collectionPath || path.startsWith(prefix),
          )
        ) {
          return;
        }
        coalescer.schedule();
      },
    );
    return () => {
      coalescer.cancel();
      unsubscribe();
    };
  }, [store, refreshDetails, workspaceId, collectionPath]);

  // Board and calendar place every record, so they cannot stop at the
  // engine's first page: once a page settles with a cursor, ask for the
  // next until the cursor runs out. One call per settled page — the effect
  // re-runs when the cursor changes, nothing fires after unmount, and the
  // store ignores overlapping loadMore calls.
  const drainAllPages =
    activeView?.kind === "board" || activeView?.kind === "calendar";
  useEffect(() => {
    if (!drainAllPages || state.status !== "ready" || state.nextCursor === null) {
      return;
    }
    void store.loadMore();
  }, [drainAllPages, state.status, state.nextCursor, store]);

  // The table pages on demand instead: TableView reports when the viewport
  // nears the end of the loaded rows.
  const loadNextPage = useCallback(() => void store.loadMore(), [store]);

  // Cell edits queue one at a time through the live document write path.
  const nextWriteId = useRef(0);
  const [writes, setWrites] = useState<
    { id: number; change: CollectionCellChange }[]
  >([]);
  const [writeError, setWriteError] = useState<string | null>(null);
  const enqueueCellChange = useCallback((change: CollectionCellChange) => {
    const id = ++nextWriteId.current;
    // A new write is a new attempt: clear the stale failure; failWrite
    // repaints it if this one fails too.
    setWriteError(null);
    setWrites((queue) => [...queue, { id, change }]);
  }, []);
  const completeWrite = useCallback(() => {
    setWrites((queue) => queue.slice(1));
    // The index updates when the engine applies the settled write; re-read
    // now instead of waiting for the activity event.
    void store.refresh();
  }, [store]);
  const failWrite = useCallback((message: string | null) => {
    setWriteError(message ?? "dohc could not save this change.");
  }, []);
  const headWrite = writes[0];

  const newRecord = useCallback(
    () => onNewRecord(collectionPath),
    [onNewRecord, collectionPath],
  );
  const openRecord = useCallback(
    (record: CollectionRecord) => onOpenRecord(record.path),
    [onOpenRecord],
  );

  // Schema authoring: fields and views change by rewriting the schema
  // through the authored write path (collections/schemaWrite). Returns a
  // user-facing sentence on failure, null on success, so the dialogs and
  // the in-cell option flow share one contract.
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const applySchemaChange = useCallback(
    async (
      mutate: (schema: CollectionSchema) => CollectionSchema,
    ): Promise<string | null> => {
      const result = await rewriteCollectionSchema({
        workspaceId,
        collectionPath,
        mutate,
      });
      if (result.status === "written") {
        void refreshDetails();
        void store.refresh();
        return null;
      }
      if (result.status === "conflict") {
        // The conflict machinery holds the other write; re-read and retry.
        void refreshDetails();
        return "This collection changed while you were editing. Try again.";
      }
      return result.detail
        ? `dohc could not update this collection. ${result.detail}`
        : "dohc could not update this collection.";
    },
    [workspaceId, collectionPath, refreshDetails, store],
  );

  // A typed select value not in the options yet: the option lands in the
  // schema FIRST; the cell write is enqueued only after that write settles.
  const createOption = useCallback(
    async (create: CollectionOptionCreate) => {
      const failure = await applySchemaChange((schema) =>
        addSelectOption(schema, create.field, create.option),
      );
      setSchemaError(failure);
      if (failure !== null) return;
      enqueueCellChange({
        recordId: create.recordId,
        recordPath: create.recordPath,
        field: create.field,
        value: create.value,
      });
    },
    [applySchemaChange, enqueueCellChange],
  );

  // Relation fields target other collections; the list loads when the
  // fields dialog opens. Best-effort: without it there is nothing to pick.
  const [relationTargets, setRelationTargets] = useState<string[]>([]);
  useEffect(() => {
    if (!fieldsOpen) return;
    let stale = false;
    void bridge()
      .listCollections({ workspaceId })
      .then((result) => {
        if (stale) return;
        setRelationTargets(result.collections.map((entry) => entry.path));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [fieldsOpen, workspaceId]);

  if (loadError !== null && details === null) {
    return (
      <div
        data-testid="collection-error"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
      >
        <span className="text-sm text-muted">
          dohc could not load this collection. {loadError}
        </span>
        <button
          type="button"
          onClick={() => {
            void refreshDetails();
            void store.refresh();
          }}
          className="rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
        >
          Retry
        </button>
      </div>
    );
  }

  // Only the first load shows a placeholder. A refresh keeps the current
  // data on screen: unmounting the views would close open cell editors and
  // flicker every view on every activity event.
  const neverLoaded =
    (state.status === "loading" || state.status === "idle") &&
    state.collection === null;
  if (details === null || neverLoaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-subtle">
        Loading collection...
      </div>
    );
  }

  const schema = details.schema;
  const empty =
    state.collection !== null &&
    state.records.length === 0 &&
    (state.groups === null ||
      state.groups.every((group) => group.records.length === 0));

  // Settled 2026-08-31: a collection with no records shows one line and the
  // New record action, nothing else.
  if (empty) {
    return (
      <div
        data-testid="collection-empty"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center"
      >
        <span className="text-sm text-muted">
          No records in this collection yet.
        </span>
        <NewRecordButton onClick={newRecord} />
      </div>
    );
  }

  const kind = activeView?.kind ?? "table";
  const boardReady =
    kind === "board" && activeView?.groupBy && state.groups !== null;
  const calendarReady = kind === "calendar" && activeView?.dateField;

  return (
    <div
      data-testid="collection-page"
      className="flex min-h-0 flex-1 flex-col bg-bg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 truncate text-sm font-semibold text-ink">
          {schema.name ?? collectionPath.split("/").at(-1)}
        </span>
        {views.length > 1 ? (
          <div
            data-testid="collection-view-switcher"
            className="flex rounded-lg border border-line bg-panel-2 p-0.5"
          >
            {views.map((view) => (
              <button
                key={view.name}
                type="button"
                onClick={() => onActiveViewChange(view.name)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  view.name === (activeView?.name ?? "")
                    ? "bg-bg text-ink shadow-sm"
                    : "text-muted hover:text-ink"
                }`}
              >
                {view.name}
              </button>
            ))}
          </div>
        ) : null}
        <span className="flex-1" />
        {state.status === "error" ? (
          <>
            <span className="truncate text-[11px] text-danger">
              dohc could not read this collection's records. {state.error}
            </span>
            <SecondaryButton onClick={() => void store.refresh()}>
              Retry
            </SecondaryButton>
          </>
        ) : writeError ? (
          <span data-testid="collection-write-error" className="truncate text-[11px] text-danger">
            {writeError}
          </span>
        ) : schemaError ? (
          <span data-testid="collection-schema-error" className="truncate text-[11px] text-danger">
            {schemaError}
          </span>
        ) : null}
        <SecondaryButton
          data-testid="collection-fields-button"
          onClick={() => setFieldsOpen(true)}
        >
          Fields
        </SecondaryButton>
        <SecondaryButton
          data-testid="collection-views-button"
          onClick={() => setViewsOpen(true)}
        >
          Views
        </SecondaryButton>
        <NewRecordButton onClick={newRecord} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {boardReady ? (
          <BoardView
            schema={schema}
            groups={state.groups ?? []}
            groupBy={activeView?.groupBy ?? ""}
            visibleFields={activeView?.visibleFields ?? null}
            onCellChange={enqueueCellChange}
            onOpenRecord={openRecord}
          />
        ) : calendarReady ? (
          <CalendarView
            schema={schema}
            records={state.records}
            dateField={activeView?.dateField ?? ""}
            visibleFields={activeView?.visibleFields ?? null}
            onCellChange={enqueueCellChange}
            onOpenRecord={openRecord}
          />
        ) : (
          <TableView
            schema={schema}
            records={state.records}
            sort={state.query.sort ?? []}
            visibleFields={activeView?.visibleFields ?? null}
            onSortChange={(sort) => void store.setQuery({ sort })}
            onCellChange={enqueueCellChange}
            onCreateOption={createOption}
            onOpenRecord={openRecord}
            relationExecutor={executor}
            onNearEnd={loadNextPage}
          />
        )}
      </div>
      {fieldsOpen ? (
        <FieldsDialog
          schema={schema}
          relationTargets={relationTargets}
          apply={applySchemaChange}
          onClose={() => setFieldsOpen(false)}
        />
      ) : null}
      {viewsOpen ? (
        <ViewsDialog
          schema={schema}
          apply={applySchemaChange}
          onClose={() => setViewsOpen(false)}
          onRenamed={(from, to) => {
            if (activeViewName === from) onActiveViewChange(to);
          }}
          onDeleted={(name) => {
            if (activeViewName === name) onActiveViewChange(null);
          }}
        />
      ) : null}
      {headWrite ? (
        <CollectionRecordFieldWrite
          key={headWrite.id}
          workspaceId={workspaceId}
          change={headWrite.change}
          onDone={completeWrite}
          onError={failWrite}
        />
      ) : null}
    </div>
  );
}
