import { useRequestSequence } from "./useRequestSequence";
import { collectionVersionError } from "@dohc/workspace-contracts/collection";
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
  recordLabel,
  TableView,
  useCollectionStore,
  type CollectionCellChange,
  type CollectionOptionCreate,
} from "@dohc/collection-views";
import type {
  CollectionQueryParams,
  CollectionRecord,
  CollectionSchema,
  FieldDefinition,
  ViewDefinition,
} from "@dohc/workspace-contracts";
import type { WorkspaceActivityEvent } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { createActivityCoalescer } from "./workspaceActivityCoalescer";
import { SecondaryButton } from "./ui/controls";
import { FieldsDialog } from "./collections/FieldsDialog";
import { ViewsDialog } from "./collections/ViewsDialog";
import {
  enqueueCollectionFieldWrite,
  useCollectionWriteLineage,
  useCollectionWritesPaused,
  useCollectionWriteStatus,
} from "./collections/recordFieldWrites";
import { rewriteCollectionSchema } from "./collections/schemaWrite";
import { withErrorWords } from "../ipc/errorWords";
import { useCollectionFieldMarks, useTableFieldMarks } from "./collections/collectionFieldMarks";
import {
  AUTOMATIONS_FILE,
  automationCount,
  AutomationsButton,
  AutomationsPanel,
  useCollectionAutomations,
} from "./collections/AutomationsPanel";
import { buttonAutomation } from "./collections/automationDraft";
import type { Automation } from "./collections/automationSentence";
import { RecordButton } from "./collections/RecordButton";
import { useAutomationButtons, useButtonStates } from "./collections/useAutomationButtons";

// The collection surface behind a tab://collection/<path> tab uses the shared
// @dohc/collection-views components bound to the desktop's collections.*
// bridge. Reads come from the engine's index; writes ride the record's live
// document frontmatter map — the same path agents and the PropertiesPanel
// take, so attribution and history stay parallel.

// How many records a board or calendar drains before the page-by-page
// drain stops. Ten default engine pages: enough for every view we have
// seen, small enough that a 10,000-record collection does not issue 100
// queries and mount them all. Exported for CollectionPage.test.tsx.
export const DRAIN_RECORD_LIMIT = 1000;

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
  // Opens any workspace file in a tab, such as automations.yaml.
  onOpenFile: (path: string) => void;
  // Opens the setting where the owner chooses which computer runs schedules.
  onOpenScheduleSettings: () => void;
  // The shell's error hook and success notices: a toast, then a row in
  // Notices. A success notice can carry an Undo.
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onNotice: (message: string, undo?: () => void) => void;
  // A notice asked to open one automation's runs here; `seq` rises with
  // each ask. The page reports when it has taken the ask.
  automationFocus: { automationId: string; seq: number } | null;
  onAutomationFocused: () => void;
}

function NewRecordButton({ onClick }: { onClick: () => void }) {
  return (
    <SecondaryButton
      type="button"
      data-testid="collection-new-record"
      onClick={onClick}
    >
      New record
    </SecondaryButton>
  );
}

export function CollectionPage({
  workspaceId,
  collectionPath,
  activeViewName,
  onActiveViewChange,
  onNewRecord,
  onOpenRecord,
  onOpenFile,
  onOpenScheduleSettings,
  onError,
  onNotice,
  automationFocus,
  onAutomationFocused,
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
  const detailsRequest = useRequestSequence();
  const refreshDetails = useCallback(async () => {
    const request = detailsRequest.next();
    try {
      const result = await bridge().getCollection({
        workspaceId,
        collectionPath,
      });
      if (!detailsRequest.isCurrent(request)) return;
      const versionError = collectionVersionError(result.reasons, `${collectionPath}/collection.yaml`);
      if (versionError) {
        setDetails(null);
        setLoadError(versionError);
        return;
      }
      setDetails({ schema: result.schema });
      setLoadError(null);
    } catch (error) {
      if (!detailsRequest.isCurrent(request)) return;
      setLoadError(withErrorWords("dohc could not load this collection.", error));
    }
  }, [workspaceId, collectionPath]);
  useEffect(() => {
    void refreshDetails();
    return () => {
      // A response landing after unmount must not write state.
      detailsRequest.next();
    };
  }, [refreshDetails]);

  // The store owns query state and guards its own async responses with a
  // request token; the desktop binds its executor to the query bridge call.
  const nextEditId = useRef(0);
  const discardListeners = useRef(new Set<(writeId: number) => void>());
  const subscribeToDiscardedWrites = useCallback((listener: (writeId: number) => void) => {
    discardListeners.current.add(listener);
    return () => { discardListeners.current.delete(listener); };
  }, []);
  const completedEdits = useRef(new Map<string, number>());
  const indexedEdits = useRef(new WeakMap<CollectionRecord, ReadonlyMap<string, number>>());
  const executor = useCallback(
    async (params: CollectionQueryParams) => {
      // Only index commits confirmed before this query belong to its acknowledgement.
      const acknowledged = new Map(completedEdits.current);
      const result = await bridge().queryCollectionRecords({ workspaceId, ...params });
      return {
        ...result,
        records: result.records.map((record) => {
          const indexed = { ...record };
          indexedEdits.current.set(indexed, acknowledged);
          return indexed;
        }),
      };
    },
    [workspaceId],
  );
  const acknowledgedWriteId = useCallback(
    (record: CollectionRecord, field: string) =>
      indexedEdits.current.get(record)?.get(JSON.stringify([record.id, record.path, field])) ?? 0,
    [],
  );
  const store = useMemo(
    () => createCollectionStore({ collectionPath, executor }),
    [collectionPath, executor],
  );
  const state = useCollectionStore(store);
  // The ⚡ on each field an automation sets: one read per Collection, again
  // only when main's automations change.
  const tableFieldMarks = useTableFieldMarks(useCollectionFieldMarks(collectionPath));

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

  // The ⚡ panel and the header's count read the Collection's automations.
  // A notice's ask to open one automation is kept here, so it survives the
  // panel mounting after it.
  const automations = useCollectionAutomations(workspaceId, collectionPath, onError);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [panelFocus, setPanelFocus] = useState<{ automationId: string; seq: number } | null>(null);
  // A button nothing uses opens the builder with its trigger filled in.
  const [panelStart, setPanelStart] = useState<{ automation: Automation; seq: number } | null>(null);
  const panelStarts = useRef(0);
  useEffect(() => {
    if (!automationFocus) return;
    setPanelFocus(automationFocus);
    setAutomationsOpen(true);
    onAutomationFocused();
  }, [automationFocus?.seq]);
  // With the panel closed, only a change to automations.yaml re-reads them;
  // with it open, any change here may be a run, so the last-run marks read
  // again too.
  const automationsOpenRef = useRef(automationsOpen);
  automationsOpenRef.current = automationsOpen;
  const automationsTouched = useRef(false);
  const reloadAutomations = automations.reload;
  // Opening the panel reads the list again: runs and missing fields change
  // without touching automations.yaml.
  useEffect(() => {
    if (automationsOpen) void reloadAutomations();
  }, [automationsOpen]);
  // Closing forgets a notice's ask, so the next open shows the list.
  // The header's button asks the panel to close, so a draft with changes
  // asks first; `seq` rises with each ask.
  const [closeAsk, setCloseAsk] = useState(0);
  const closeAutomations = useCallback(() => {
    setAutomationsOpen(false);
    setPanelFocus(null);
    setPanelStart(null);
  }, []);

  // Invalidation: refresh when a settled batch touches this collection's
  // folder (or arrives without path detail), on the shell's trailing-edge
  // coalescing cadence. The store's token makes the refresh latest-wins.
  // Button fields: what each shows, and presses in flight from this window.
  // Their states follow the Collection's files, automations.yaml included.
  const buttons = useAutomationButtons({ workspaceId, of: { collectionPath }, onError, onNotice });
  useEffect(() => {
    void buttons?.refresh();
  }, [buttons]);
  const refreshCoalescer = useMemo(
    () => createActivityCoalescer(() => {
      void store.refresh();
      void refreshDetails();
      if (automationsOpenRef.current || automationsTouched.current) void reloadAutomations();
      automationsTouched.current = false;
      void buttons?.refresh();
    }),
    [store, refreshDetails, reloadAutomations, buttons],
  );
  // Stable while the store is, so the table keeps each cell's element.
  const renderButton = useCallback(
    (field: FieldDefinition, record: CollectionRecord) =>
      buttons === null ? null : (
        <RecordButton buttons={buttons} field={field.name} recordId={record.id} recordLabel={recordLabel(record)} />
      ),
    [buttons],
  );
  useEffect(() => {
    const prefix = `${collectionPath}/`;
    const automationsPath = `${prefix}${AUTOMATIONS_FILE}`;
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
        if (!event.paths?.length || event.paths.includes(automationsPath)) {
          automationsTouched.current = true;
        }
        refreshCoalescer.schedule();
      },
    );
    return () => {
      refreshCoalescer.cancel();
      unsubscribe();
    };
  }, [refreshCoalescer, workspaceId, collectionPath]);

  // Board and calendar place every record, so they cannot stop at the
  // engine's first page: once a page settles with a cursor, ask for the
  // next until the cursor runs out. One call per settled page — the effect
  // re-runs when the cursor changes, nothing fires after unmount, and the
  // store ignores overlapping loadMore calls. The drain stops at
  // DRAIN_RECORD_LIMIT so a huge collection does not issue every page; the
  // capped view says how many records it shows.
  const drainAllPages =
    activeView?.kind === "board" || activeView?.kind === "calendar";
  useEffect(() => {
    if (
      !drainAllPages ||
      state.status !== "ready" ||
      state.nextCursor === null ||
      state.records.length >= DRAIN_RECORD_LIMIT
    ) {
      return;
    }
    void store.loadMore();
  }, [drainAllPages, state.status, state.nextCursor, state.records.length, store]);
  const drainCapped =
    drainAllPages &&
    state.nextCursor !== null &&
    state.records.length >= DRAIN_RECORD_LIMIT;

  // The table pages on demand instead: TableView reports when the viewport
  // nears the end of the loaded rows.
  const loadNextPage = useCallback(() => void store.loadMore(), [store]);

  // The global host finishes accepted edits after this page unmounts.
  const lineage = useCollectionWriteLineage(workspaceId);
  const enqueueCellChange = useCallback(
    (change: CollectionCellChange, createOption?: string) => {
      const editId = ++nextEditId.current;
      const key = JSON.stringify([change.recordId, change.recordPath, change.field]);
      enqueueCollectionFieldWrite(workspaceId, collectionPath, change, createOption, lineage, () => {
        completedEdits.current.set(key, Math.max(completedEdits.current.get(key) ?? 0, editId));
      }, () => {
        for (const listener of discardListeners.current) listener(editId);
      });
      return editId;
    },
    [workspaceId, collectionPath, lineage],
  );
  // File and version operations disable new edits until their paths settle.
  const writesPaused = useCollectionWritesPaused(workspaceId);
  const onCellChange = writesPaused ? undefined : enqueueCellChange;
  const writeStatus = useCollectionWriteStatus(workspaceId, collectionPath);
  const writeError = writeStatus.error;
  // Settled writes can precede activity events; both share one refresh burst.
  const settledWrites = writeStatus.settled;
  const seenSettledWrites = useRef(settledWrites);
  useEffect(() => {
    if (settledWrites === seenSettledWrites.current) return;
    seenSettledWrites.current = settledWrites;
    refreshCoalescer.schedule();
  }, [settledWrites, refreshCoalescer]);

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
  // user-facing sentence on failure, null on success, so both dialogs
  // share one contract.
  const [fieldsOpen, setFieldsOpen] = useState(false);
  // The Fields dialog shows what each button does; the page follows the
  // store only while it is open, so a press re-renders just its button.
  const buttonStates = useButtonStates(fieldsOpen ? buttons : null);
  const [viewsOpen, setViewsOpen] = useState(false);
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

  // A typed select value not in the options yet: the whole edit enters the
  // global queue synchronously — before any schema IPC — so navigation and
  // lineage gates see it. The queue writes the option to the schema first,
  // then the cell value; a preparation failure retains the edit for retry.
  const createOption = useCallback(
    (create: CollectionOptionCreate) => {
      return enqueueCellChange(
        {
          recordId: create.recordId,
          recordPath: create.recordPath,
          field: create.field,
          value: create.value,
          ...(create.previousValues ? { previousValues: create.previousValues } : {}),
        },
        create.option,
      );
    },
    [enqueueCellChange],
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
          {loadError}
        </span>
        <SecondaryButton
          type="button"
          onClick={() => {
            void refreshDetails();
            void store.refresh();
          }}

        >
          Retry
        </SecondaryButton>
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

  // The ⚡ panel docks at the right of whatever the page shows.
  const automationsPanel = automationsOpen ? (
    <AutomationsPanel
      workspaceId={workspaceId}
      collectionPath={collectionPath}
      automations={automations}
      fields={schema.fields}
      focus={panelFocus}
      start={panelStart}
      onStarted={() => setPanelStart(null)}
      closeAsk={closeAsk}
      onClose={closeAutomations}
      onOpenFile={onOpenFile}
      onOpenScheduleSettings={onOpenScheduleSettings}
      onError={onError}
      onNotice={onNotice}
    />
  ) : null;

  // Automations and Fields set up a Collection, so they stay in the header
  // even before it has records.
  const collectionName = (
    <span className="min-w-0 truncate text-sm font-semibold text-ink">
      {schema.name ?? collectionPath.split("/").at(-1)}
    </span>
  );
  const setupButtons = (
    <>
      <AutomationsButton
        open={automationsOpen}
        count={automationCount(automations.file)}
        onClick={() => (automationsOpen ? setCloseAsk((ask) => ask + 1) : setAutomationsOpen(true))}
      />
      <SecondaryButton
        data-testid="collection-fields-button"
        onClick={() => setFieldsOpen(true)}
      >
        Fields
      </SecondaryButton>
    </>
  );
  const fieldsDialog = fieldsOpen ? (
    <FieldsDialog
      schema={schema}
      relationTargets={relationTargets}
      apply={applySchemaChange}
      buttonStates={buttonStates}
      onChooseButtonAutomation={(field) => {
        setFieldsOpen(false);
        panelStarts.current += 1;
        setPanelStart({ automation: buttonAutomation(field, null, []), seq: panelStarts.current });
        setAutomationsOpen(true);
      }}
      onClose={() => setFieldsOpen(false)}
    />
  ) : null;

  // Settled 2026-08-31, amended for automations on 2026-09-25: a collection
  // with no records shows one line and the New record action, under a
  // header that keeps only what sets the Collection up.
  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
          {collectionName}
          <span className="flex-1" />
          {setupButtons}
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            data-testid="collection-empty"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center"
          >
            <span className="text-sm text-muted">
              No records in this collection yet.
            </span>
            <NewRecordButton onClick={newRecord} />
          </div>
          {automationsPanel}
        </div>
        {fieldsDialog}
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
        {collectionName}
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
        ) : writesPaused ? (
          <span
            data-testid="collection-writes-paused"
            className="truncate text-[11px] text-muted"
          >
            Editing is paused while dohc changes files in this workspace.
          </span>
        ) : writeError ? (
          <span data-testid="collection-write-error" className="truncate text-[11px] text-danger">
            {writeError}
          </span>
        ) : null}
        {setupButtons}
        <SecondaryButton
          data-testid="collection-views-button"
          onClick={() => setViewsOpen(true)}
        >
          Views
        </SecondaryButton>
        <NewRecordButton onClick={newRecord} />
      </div>
      {drainCapped ? (
        <div
          data-testid="collection-drain-cap"
          className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-muted"
        >
          This view shows only the first {state.records.length} records.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {boardReady ? (
          <BoardView
            schema={schema}
            groups={state.groups ?? []}
            groupBy={activeView?.groupBy ?? ""}
            visibleFields={activeView?.visibleFields ?? null}
            onCellChange={onCellChange}
            onOpenRecord={openRecord}
          />
        ) : calendarReady ? (
          <CalendarView
            schema={schema}
            records={state.records}
            dateField={activeView?.dateField ?? ""}
            visibleFields={activeView?.visibleFields ?? null}
            onCellChange={onCellChange}
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
            editingDisabled={writesPaused}
            acknowledgedWriteId={acknowledgedWriteId}
            subscribeToDiscardedWrites={subscribeToDiscardedWrites}
            onCreateOption={createOption}
            onOpenRecord={openRecord}
            relationExecutor={executor}
            fieldMarks={tableFieldMarks}
            renderButton={renderButton}
            onNearEnd={loadNextPage}
          />
        )}
      </div>
      {automationsPanel}
      </div>
      {fieldsDialog}
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
    </div>
  );
}
