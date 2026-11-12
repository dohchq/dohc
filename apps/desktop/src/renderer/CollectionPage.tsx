import { useRequestSequence } from "./useRequestSequence";
import { collectionVersionError } from "@dohc/workspace-contracts/collection";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { History, LayoutList, PanelsTopLeft, SlidersHorizontal, Zap } from "lucide-react";
import {
  BoardView,
  CalendarView,
  createCollectionStore,
  recordLabel,
  RecordProperties,
  TableView,
  useCollectionStore,
  type CollectionCellChange,
  type CollectionOptionCreate,
  type TableAbandonedDraft,
  type TableNewRecord,
} from "@dohc/collection-views";
import type {
  CollectionQueryCursor,
  CollectionQueryParams,
  CollectionQueryResult,
  CollectionRecord,
  CollectionSchema,
  CollectionValue,
  FieldDefinition,
  OptionColor,
  ViewDefinition,
} from "@dohc/workspace-contracts";
import type { WorkspaceActivityEvent } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { createActivityCoalescer } from "./workspaceActivityCoalescer";
import { SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { TextNotSavedError } from "./shell/copyDetails";
import { CollectionCustomizeDialog, documentCollectionFiles } from "./collections/CollectionCustomizeDialog";
import { CollectionFrame, type CollectionFrameViews, type NewCollectionView } from "./collections/CollectionFrame";
import { FieldsDialog } from "./collections/FieldsDialog";
import { ViewsDialog } from "./collections/ViewsDialog";
import {
  collectionWritesPaused,
  enqueueCollectionFieldWrite,
  useCollectionWriteLineage,
  useCollectionWritesPaused,
  useCollectionWriteStatus,
} from "./collections/recordFieldWrites";
import { rewriteCollectionSchema } from "./collections/schemaWrite";
import { addView, deleteView, renameView, setOptionColor } from "./collections/schemaAuthoring";
import { withErrorWords } from "../ipc/errorWords";
import { openLink } from "./linkActivation";
import { useCollectionFieldMarks, useTableFieldMarks } from "./collections/collectionFieldMarks";
import {
  AUTOMATIONS_FILE,
  automationCount,
  automationsFileMade,
  AutomationsPanel,
  useCollectionAutomations,
  type AutomationFocus,
} from "./collections/AutomationsPanel";
import { buttonAutomation } from "./collections/automationDraft";
import type { Automation } from "./collections/automationSentence";
import { RecordButton } from "./collections/RecordButton";
import { CalendarNeedsDateField } from "./collections/CalendarNeedsDateField";
import { useAutomationButtons, useButtonStates } from "./collections/useAutomationButtons";
import { RecordPanel, type RecordPanelCommand } from "./collections/RecordPanel";
import { useRecordPanel, type RecordPanelHost } from "./collections/useRecordPanel";
import type { RecordHistoryTarget } from "./collections/useRecordHistory";

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

// A record open in the panel that is not among the records the page holds is
// looked for by its id, a query at a time, in the Collection's own order: the
// engine reads no record by its id. The search stops at the record, at the
// last record, or once it has read this many. Exported for CollectionPage.recordPanel.test.tsx.
export const FIND_RECORD_PAGE = 500;
export const FIND_RECORD_LIMIT = 5000;
const RECORD_GONE = "This record is no longer in this Collection.";
const RECORD_NOT_FOUND = "dohc could not find this record in the first 5,000 records. Close it, then open it from its view.";
const RECORD_NOT_READ = "dohc could not read this record. Close it, then open it again.";

/** Where a record is in the Collection's own order: the cursor that reads from it on. Undefined for the first record. */
type RecordPlace = CollectionQueryCursor | undefined;
/** What a search for the open record found: the record and its place, or why there is none. */
type FoundRecord = { record: CollectionRecord; place: RecordPlace } | { record: null; problem: string };

/** Answers null once `superseded`, having read no further page. */
async function findRecord(
  read: (params: CollectionQueryParams) => Promise<CollectionQueryResult>,
  collectionPath: string,
  recordId: string,
  // The record's place when it was last found, which one read of one record checks first.
  known: { place: RecordPlace } | null,
  superseded: () => boolean,
): Promise<FoundRecord | null> {
  const page = (cursor: RecordPlace, limit: number) =>
    read({ collectionPath, resolveRelations: true, limit, ...(cursor ? { cursor } : {}) });
  if (known) {
    const record = (await page(known.place, 1)).records[0];
    if (record?.id === recordId) return { record, place: known.place };
  }
  let cursor: RecordPlace;
  for (let seen = 0; seen < FIND_RECORD_LIMIT; seen += FIND_RECORD_PAGE) {
    if (superseded()) return null;
    const result = await page(cursor, FIND_RECORD_PAGE);
    const at = result.records.findIndex((entry) => entry.id === recordId);
    // The cursor a page ending at the record before it would give: the Collection's own order sorts by no field.
    const before = result.records[at - 1];
    if (at >= 0) return { record: result.records[at]!, place: before ? { sortValues: [], recordPath: before.path, recordId: before.id } : cursor };
    if (result.nextCursor === null) return { record: null, problem: RECORD_GONE };
    cursor = result.nextCursor;
  }
  return { record: null, problem: RECORD_NOT_FOUND };
}

/**
 * The field a record's name is a value of, as `recordLabel` reads it: its
 * `title`, then its `name`, where that holds text. Null for a record named
 * by its file.
 */
function labelField(values: ReadonlyArray<{ field: string; value: CollectionValue }>): string | null {
  for (const preferred of ["title", "name"]) {
    const matches = values.filter((entry) => entry.field.toLowerCase() === preferred);
    const entry = matches.find((candidate) => candidate.field === preferred) ?? matches.sort((a, b) => (a.field < b.field ? -1 : 1))[0];
    if (entry && typeof entry.value === "string" && entry.value.trim().length > 0) return entry.field;
  }
  return null;
}

/** How the shell makes a record the page asks for. */
export interface NewRecordOptions {
  /** The record's name, which names its file as a new page's title does. Absent, the file is Untitled. */
  title?: string;
  /** False keeps the record's file out of a tab. */
  open?: boolean;
  /**
   * Receives why the record was not made, and what finishes a creation that
   * stopped part way. True when the page shows it, so the shell reports nothing.
   */
  onFailure?(failure: { reason: string; retry: (() => void) | null }): boolean;
}

/**
 * The text field a Collection's records are named in: `title`, then `name`,
 * by `recordLabel`'s rule for a record's values. Undefined where the
 * Collection has neither.
 */
function nameFieldOf(schema: CollectionSchema): FieldDefinition | undefined {
  for (const preferred of ["title", "name"]) {
    const matches = schema.fields.filter((field) => field.type === "text" && field.name.toLowerCase() === preferred);
    const field = matches.find((candidate) => candidate.name === preferred) ?? matches.sort((a, b) => (a.name < b.name ? -1 : 1))[0];
    if (field) return field;
  }
  return undefined;
}

export interface CollectionPageProps extends RecordPanelHost {
  readOnly?: boolean;
  accessEnded?: boolean;
  writeRefusal?: string;
  workspaceId: string;
  collectionPath: string;
  // Which view is open is per-user local state the shell persists in the
  // workbench UI state, keyed by collection path — closing the tab or
  // restarting the app must not reset it. null means "no stored choice":
  // the page falls back to the schema's first view.
  activeViewName: string | null;
  onActiveViewChange: (viewName: string | null) => void;
  // The shell creates the record file (naming it needs the file listing,
  // which the shell owns) and opens it in a tab unless asked not to;
  // adoption mints the id. `created` runs once the record exists, before it opens.
  onNewRecord: (
    collectionPath: string,
    created?: (record: { path: string; recordId: string }) => void,
    options?: NewRecordOptions,
  ) => void;
  // The md file IS the record. A record opens in the panel beside its view;
  // this opens its file in a tab, as the panel's Open as page does.
  onOpenRecord: (recordPath: string) => void;
  // Draws a record's page body under its fields in the panel, by the
  // record's file. The shell owns the file's editor, so the body is the
  // document a file tab shows. Absent, the panel shows the fields alone.
  renderRecordBody?: (recordPath: string) => ReactNode;
  // Runs `then` once the body's unsaved text is saved, as closing a file
  // tab does: before the record leaves the panel, and before its file opens
  // in a tab. A save that fails keeps the record open, and `then` never runs.
  settleRecordBody?: (then: () => void) => void;
  // Opens a record's History. Absent where a record has none.
  onOpenRecordHistory?: (record: RecordHistoryTarget) => void;
  // Opens any workspace file in a tab, such as automations.yaml.
  onOpenFile: (path: string) => void;
  // Opens the setting where the owner chooses which computer runs schedules.
  onOpenScheduleSettings: () => void;
  // The shell's error hook and success notices: a toast, then a row in
  // Notices. A success notice can carry an Undo.
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onNotice: (message: string, undo?: () => void) => void;
  // A notice asked to open one automation here, at its runs or its switch.
  // The page reports when it has taken the ask.
  automationFocus: AutomationFocus | null;
  onAutomationFocused: () => void;
}

// A url cell's link opens the way a link in a chat or a document does.
const openCellLink = (url: string) => void openLink(url);

export function CollectionPage({
  readOnly = false,
  accessEnded = false,
  writeRefusal,
  workspaceId,
  collectionPath,
  activeViewName,
  onActiveViewChange,
  onNewRecord,
  onOpenRecord,
  renderRecordBody,
  settleRecordBody,
  onOpenRecordHistory,
  onOpenFile,
  onOpenScheduleSettings,
  onError,
  onNotice,
  automationFocus,
  onAutomationFocused,
  initialOpenRecord,
  onOpenRecordChange,
  initialRecordPanelWidth,
  onRecordPanelWidthChange,
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

  // The people a person field can name: the ones main lists for this
  // Collection. A person cell then opens a picker and shows names. Without
  // the list, as on a received share, the cell keeps the typed id.
  const [people, setPeople] = useState<ReadonlyArray<{ id: string; name: string }> | undefined>(undefined);
  const peopleRequests = useRequestSequence([workspaceId, collectionPath]);
  const hasPersonField = details?.schema.fields.some((field) => field.type === "person") ?? false;
  useEffect(() => {
    setPeople(undefined);
    if (!hasPersonField) return;
    const request = peopleRequests.next();
    void bridge()
      .listAutomationPeople({ workspaceId, collectionPath })
      .then((result) => {
        if (!peopleRequests.isCurrent(request) || result.status !== "listed" || result.people.length === 0) return;
        setPeople(result.people.map((person) => ({ id: person.userId, name: person.name })));
      })
      // A failed read leaves the typed id, which still works.
      .catch(() => undefined);
  }, [workspaceId, collectionPath, hasPersonField]);
  const personLabel = useMemo(() => {
    if (!people) return undefined;
    const names = new Map(people.map((person) => [person.id, person.name]));
    return (userId: string) => names.get(userId) ?? null;
  }, [people]);

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
  const [customizing, setCustomizing] = useState(false);
  const [panelFocus, setPanelFocus] = useState<AutomationFocus | null>(null);
  // A button nothing uses opens the builder with its trigger filled in.
  const [panelStart, setPanelStart] = useState<{ automation: Automation; seq: number } | null>(null);
  const panelStarts = useRef(0);
  // Rises each time the ⚡ panel is asked to close, so a draft with changes asks first.
  const [closeAsk, setCloseAsk] = useState(0);
  // What runs once the ⚡ panel has closed at the record panel's asking.
  const afterAutomationsClose = useRef<(() => void) | null>(null);
  // The open record's panel: which record it shows, by its id, where focus goes, and what the shell keeps with the tab.
  const recordPanel = useRecordPanel({
    initialOpenRecord, onOpenRecordChange, initialRecordPanelWidth, onRecordPanelWidthChange,
    settle: settleRecordBody,
    automations: {
      open: automationsOpen,
      // The ⚡ panel may hold a draft, so it is asked to close, and the record opens once it has.
      close: (then) => {
        afterAutomationsClose.current = then;
        setCloseAsk((ask) => ask + 1);
      },
    },
  });
  const openRecordId = recordPanel.openKey;
  // What takes the open record's body off the page waits until what the body holds is saved.
  const afterBodySaved = recordPanel.afterSettled;
  // The ⚡ panel takes the record panel's place.
  const showAutomations = () => afterBodySaved(() => setAutomationsOpen(true));
  useEffect(() => {
    if (!automationFocus) return;
    setPanelFocus(automationFocus);
    showAutomations();
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
  const closeAutomations = useCallback(() => {
    setAutomationsOpen(false);
    setPanelFocus(null);
    setPanelStart(null);
    const then = afterAutomationsClose.current;
    afterAutomationsClose.current = null;
    then?.();
  }, []);

  // Invalidation: refresh when a settled batch touches this collection's
  // folder (or arrives without path detail), on the shell's trailing-edge
  // coalescing cadence. The store's token makes the refresh latest-wins.
  // Button fields: what each shows, and presses in flight from this window.
  // Their states follow the Collection's files, automations.yaml included.
  const buttons = useAutomationButtons({ workspaceId, of: readOnly ? null : { collectionPath }, onError, onNotice });
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
  // A refresh can reject a near-end request while the same rows remain on
  // screen. Retry when that query settles, even without another scroll.
  const loadNextPage = useCallback(() => void store.loadMore(), [store, state.status, state.nextCursor]);

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

  // The page is open. A creation that answers after it closed changes nothing on screen.
  const pageOpen = useRef(true);
  useEffect(() => {
    pageOpen.current = true;
    return () => {
      pageOpen.current = false;
    };
  }, []);
  // What starts the table's new row, while a table shows.
  const startNewRow = useRef<(() => void) | null>(null);
  const newRecord = useCallback(
    () => (startNewRow.current ? startNewRow.current() : onNewRecord(collectionPath)),
    [onNewRecord, collectionPath],
  );
  const rowHost = useRef({ onNewRecord, enqueueCellChange, onError, onNotice, collectionName: collectionPath });
  rowHost.current = { onNewRecord, enqueueCellChange, onError, onNotice, collectionName: details?.schema.name ?? collectionPath.split("/").at(-1) ?? collectionPath };
  /**
   * The table's new row. Saving it creates the record's file, named from
   * the row's title or name, then writes each typed value as an edit of a
   * cell does. One object for the page's life, so the table builds nothing again.
   */
  const tableNewRecord = useMemo((): TableNewRecord => {
    const text = (value: CollectionValue) => (Array.isArray(value) ? value.join(", ") : String(value));
    const save: TableNewRecord["save"] = (values, report) => {
      const now = rowHost.current;
      const entries = Object.entries(values).map(([field, value]) => ({ field, value }));
      const named = labelField(entries);
      const typed = entries.map((entry) => `${entry.field}: ${text(entry.value)}`).join(", ");
      now.onNewRecord(collectionPath, (record) => {
        // The record exists, so what was typed is written whether or not the page is still open.
        for (const { field, value } of entries) now.enqueueCellChange({ recordId: record.recordId, recordPath: record.path, field, value });
        const shown = () => {
          if (!pageOpen.current) return;
          report({ state: "saved" });
          // A record past the rows loaded so far has no row to show it.
          const loaded = store.getState();
          if (!loaded.records.some((entry) => entry.id === record.recordId) && loaded.nextCursor !== null) {
            rowHost.current.onNotice("Created a record. It is past the records loaded here.");
          }
        };
        // The record's own row is on the page before the new row goes. A page that closed reads nothing again.
        if (pageOpen.current) void store.refresh().then(shown, shown);
      }, {
        ...(named === null ? {} : { title: text(values[named] ?? null) }),
        open: false,
        onFailure: (failure) => {
          if (pageOpen.current && report({ state: "refused", reason: failure.reason, ...(failure.retry ? { retry: failure.retry } : {}) })) return true;
          // A record with nothing typed in it has nothing to keep, so the shell reports it as it does any creation.
          if (typed === "") return false;
          // The row went with its table, so what it held goes to a notice, which can make the record again.
          const message = `dohc did not create a record in ${rowHost.current.collectionName}. ${failure.reason} You typed: ${typed}`;
          rowHost.current.onError(message, new TextNotSavedError(message, typed), failure.retry ?? (() => save(values, () => false)));
          return true;
        },
      });
    };
    return {
      bind: (start) => {
        startNewRow.current = start;
        return () => {
          if (startNewRow.current === start) startNewRow.current = null;
        };
      },
      save,
      onValueDropped: (field, value) => {
        const why = dropRefusal.current() ?? "The field changed, or this view no longer shows it.";
        const message = `dohc did not save what you typed in the ${field} field of the new record. ${why} You typed: ${text(value)}`;
        rowHost.current.onError(message, new TextNotSavedError(message, text(value)));
      },
    };
  }, [collectionPath, store]);
  // Why the page may not write now, read when the new row gives a value back.
  const dropRefusal = useRef<() => string | null>(() => null);
  // A board column's New: the record starts with the column's value, written
  // through the same queue as any edit once the record exists.
  const groupBy = activeView?.kind === "board" ? activeView.groupBy : undefined;
  const newRecordInGroup = useCallback(
    (value: CollectionValue) => {
      if (!groupBy || value === null) return onNewRecord(collectionPath);
      onNewRecord(collectionPath, (record) => {
        enqueueCellChange({ recordId: record.recordId, recordPath: record.path, field: groupBy, value });
      });
    },
    [onNewRecord, collectionPath, groupBy, enqueueCellChange],
  );
  // Stable, so opening or closing a record builds no column of the table again.
  const openInPanel = useRef(recordPanel.open);
  openInPanel.current = recordPanel.open;
  const openRecord = useCallback((record: CollectionRecord) => openInPanel.current(record.id), []);

  // The open record, as the page holds it: among the view's records, or as a search by its id found it.
  const [sought, setSought] = useState<({ id: string } & FoundRecord) | null>(null);
  const heldRecord = openRecordId === null ? undefined
    : state.records.find((record) => record.id === openRecordId)
      ?? state.groups?.flatMap((group) => group.records).find((record) => record.id === openRecordId);
  const found = sought !== null && sought.id === openRecordId ? sought : null;
  // The record as last seen, which the panel shows while a refresh that left it out looks for it again.
  const lastRecord = useRef<CollectionRecord | null>(null);
  if (heldRecord ?? found?.record) lastRecord.current = heldRecord ?? found?.record ?? null;
  else if (lastRecord.current?.id !== openRecordId || found !== null) lastRecord.current = null;
  const shownRecord = lastRecord.current;
  const recordProblem = heldRecord === undefined && found !== null && found.record === null ? found.problem : undefined;
  const held = heldRecord !== undefined;
  // Where the open record was last found. It outlives the rows that hold the record, which a refresh drops.
  const foundAt = useRef<{ id: string; place: RecordPlace } | null>(null);
  useEffect(() => {
    // A closed record is looked for again when a person opens it again.
    if (openRecordId === null) return setSought(null);
    if (state.status !== "ready") return;
    // A record the view holds needs no search, and what an earlier search found is older than the view's.
    if (held) return setSought(null);
    // A search that ended without the record is not run again for it.
    if (sought !== null && sought.id === openRecordId && sought.record === null && sought.problem !== RECORD_NOT_READ) return;
    let stale = false;
    findRecord(executor, collectionPath, openRecordId, foundAt.current?.id === openRecordId ? foundAt.current : null, () => stale).then(
      (result) => {
        if (stale || result === null) return;
        foundAt.current = result.record === null ? null : { id: openRecordId, place: result.place };
        setSought({ id: openRecordId, ...result });
      },
      () => {
        // A record the panel already shows keeps its last values: the next refresh looks again.
        if (!stale && lastRecord.current === null) setSought({ id: openRecordId, record: null, problem: RECORD_NOT_READ });
      },
    );
    return () => {
      stale = true;
    };
    // Each refresh of the view's records reads the record again, so a record outside them shows its changes.
  }, [openRecordId, held, state.status, state.records, state.groups, executor, collectionPath]);
  /** Reads the Collection's records again because a person asked, which looks again for a record an earlier search did not find. */
  const readAgain = () => {
    setSought(null);
    void store.refresh();
  };
  const recordDrafts = [...new Map([...state.records, ...(state.groups?.flatMap(group => group.records) ?? [])]
    .filter(record => record.creationDelivery === "pending" || record.creationDelivery === "offline" || record.creationDelivery === "refused").map(record => [record.path, record])).values()];
  const draftActions = useRequestSequence([workspaceId, collectionPath, readOnly]);
  const draftAccess = useRef({ readOnly, accessEnded, writeRefusal });
  draftAccess.current = { readOnly, accessEnded, writeRefusal };
  /** Why this page may not write now, or null where it may. */
  const accessRefusal = () => !draftAccess.current.readOnly && !draftAccess.current.accessEnded ? null
    : draftAccess.current.writeRefusal ?? (draftAccess.current.accessEnded ? "Your access to this share ended."
      : "Your access to this share changed. Ask for Edit access, then reopen the share.");
  dropRefusal.current = accessRefusal;
  // Each record as the page last had it, so text left in a cell whose record a refresh took still has its record's name and file.
  const knownRecords = useRef(new Map<string, CollectionRecord>());
  useEffect(() => {
    for (const record of [...state.records, ...(state.groups?.flatMap((group) => group.records) ?? [])]) knownRecords.current.set(record.id, record);
  }, [state.records, state.groups]);
  const leftWith = useRef({ enqueueCellChange, onError });
  leftWith.current = { enqueueCellChange, onError };
  /**
   * Text still in an editor that went away with no press, as with its tab or its record. It is saved as a press
   * away saves it. What its field cannot take, or this page may not write, is reported with the text and never sent.
   */
  const saveLeftText = useCallback((record: CollectionRecord, field: string, text: string, value: CollectionValue | undefined) => {
    const refusal = accessRefusal()
      ?? (collectionWritesPaused(workspaceId) ? "Editing was paused while dohc changed files in this workspace. Type it again." : null)
      ?? (value === undefined ? `Enter a value ${field} can take.` : null);
    if (refusal === null && value !== undefined) {
      leftWith.current.enqueueCellChange({ recordId: record.id, recordPath: record.path, field, value });
      return;
    }
    // The text comes last, so a long one is all a cut takes from the message. Copy details has all of it.
    const message = `dohc did not save what you typed in the ${field} field of ${recordLabel(record)}. ${refusal} You typed: ${text}`;
    leftWith.current.onError(message, new TextNotSavedError(message, text));
  }, [workspaceId]);
  const saveLeftCell = useCallback((draft: TableAbandonedDraft) => {
    const record = knownRecords.current.get(draft.recordId);
    if (record) saveLeftText(record, draft.field, draft.text, draft.value);
  }, [saveLeftText]);
  const retryDrafts = async () => {
    const message = accessRefusal();
    if (draftAccess.current.readOnly && message !== null) {
      onError(message, new Error(message));
      return;
    }
    const request = draftActions.next();
    try {
      await bridge().pushShareDirectWrites({ workspaceId });
      if (!draftActions.isCurrent(request)) return;
      await store.refresh();
    } catch (error) { if (draftActions.isCurrent(request)) onError("dohc could not send the record drafts.", error, () => void retryDrafts()); }
  };
  const discardDraft = async (record: CollectionRecord) => {
    const request = draftActions.next();
    try {
      const latest = await bridge().queryCollectionRecords({ workspaceId, collectionPath, limit: 1000 });
      if (!draftActions.isCurrent(request)) return;
      const current = [...latest.records, ...(latest.groups?.flatMap(group => group.records) ?? [])].find(row => row.path === record.path);
      if (!current?.creationCanDiscard || current.id !== record.id) {
        await retryDrafts();
        return;
      }
      const draft = await bridge().readWorkspaceText({ workspaceId, relativePath: record.path });
      if (!draftActions.isCurrent(request)) return;
      if (draft.truncated) throw new Error("This record draft is too large to discard with Undo.");
      await bridge().deleteWorkspacePath({ workspaceId, relativePath: record.path });
      if (!draftActions.isCurrent(request)) return;
      await store.refresh();
      if (draftActions.isCurrent(request)) onNotice("Record draft discarded on this device", () => {
        if (!draftActions.isCurrent(request)) return;
        void bridge().createWorkspaceFile({ workspaceId, relativePath: record.path, initialText: draft.text })
          .then(() => { if (draftActions.isCurrent(request)) void store.refresh(); })
          .catch(error => { if (draftActions.isCurrent(request)) onError("dohc could not restore this record draft.", error); });
      });
    } catch (error) { if (draftActions.isCurrent(request)) onError("dohc could not discard this record draft.", error, () => void discardDraft(record)); }
  };

  // Schema authoring: fields and views change by rewriting the schema
  // through the authored write path (collections/schemaWrite). Returns a
  // user-facing sentence on failure, null on success, so both dialogs
  // share one contract.
  // True, or the type of the new field the dialog opens on.
  const [fieldsOpen, setFieldsOpen] = useState<boolean | "date">(false);
  // The Fields dialog shows what each button does; the page follows the
  // store only while it is open, so a press re-renders just its button.
  const buttonStates = useButtonStates(fieldsOpen ? buttons : null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const schemaDialog = useMemo(() => ({}), [fieldsOpen, viewsOpen, readOnly]);
  const currentSchemaDialog = useRef(schemaDialog);
  currentSchemaDialog.current = schemaDialog;
  const schemaWrites = useRequestSequence();
  useEffect(() => {
    if (!readOnly) return;
    setFieldsOpen(false);
    setViewsOpen(false);
  }, [readOnly]);
  const applySchemaChange = useCallback(
    async (
      mutate: (schema: CollectionSchema) => CollectionSchema,
    ): Promise<string | null> => {
      const request = schemaWrites.current();
      const dialog = currentSchemaDialog.current;
      const result = await rewriteCollectionSchema({
        workspaceId,
        collectionPath,
        mutate,
      });
      if (!schemaWrites.isCurrent(request)) return null;
      if (result.status === "written") {
        void refreshDetails();
        void store.refresh();
        return null;
      }
      let failure: string;
      if (result.status === "conflict") {
        // The conflict machinery holds the other write; re-read and retry.
        void refreshDetails();
        failure = "This collection changed while you were editing. Try again.";
      } else {
        failure = result.detail
          ? `dohc could not update this collection. ${result.detail}`
          : "dohc could not update this collection.";
      }
      if (currentSchemaDialog.current !== dialog) onError(failure, new Error(failure));
      return failure;
    },
    [workspaceId, collectionPath, refreshDetails, store, onError, schemaWrites],
  );

  const changeOptionColor = useCallback(
    function change(field: string, option: string, color: OptionColor) {
      const dialog = currentSchemaDialog.current;
      void applySchemaChange((current) => setOptionColor(current, field, option, color)).then((failure) => {
        // applySchemaChange reports a failure itself only when a dialog changed.
        if (failure !== null && currentSchemaDialog.current === dialog) {
          onError(failure, new Error(failure), () => change(field, option, color));
        }
      });
    },
    [applySchemaChange, onError],
  );
  // A board colors the options of the field it groups by.
  const changeGroupColor = useCallback(
    (option: string, color: OptionColor) => {
      if (groupBy) changeOptionColor(groupBy, option, color);
    },
    [changeOptionColor, groupBy],
  );

  // The tab strip's view changes: each is one schema rewrite, as the Views
  // dialog's are. Which view is open stays the shell's state, so the page
  // follows a new, renamed or deleted view there. A write that ends after
  // the page closed changes nothing: applySchemaChange answers null for it too.
  const openViewName = useRef(activeViewName);
  openViewName.current = activeViewName;
  // Current while the page is open: schemaWrites moves on only as the page closes.
  const pageWrites = schemaWrites.current();
  const createView = useCallback(
    async (view: NewCollectionView): Promise<string | null> => {
      const request = schemaWrites.current();
      const failure = await applySchemaChange((current) =>
        addView(current, {
          name: view.name,
          kind: view.kind,
          groupBy: view.kind === "board" ? view.groupBy ?? null : null,
          sort: [],
          visibleFields: null,
          dateField: view.kind === "calendar" ? view.dateField ?? null : null,
        }),
      );
      if (failure === null && schemaWrites.isCurrent(request)) onActiveViewChange(view.name);
      return failure;
    },
    [applySchemaChange, onActiveViewChange, schemaWrites],
  );
  const renameOpenView = useCallback(
    async (from: string, to: string): Promise<string | null> => {
      const request = schemaWrites.current();
      const failure = await applySchemaChange((current) => renameView(current, from, to));
      if (failure === null && schemaWrites.isCurrent(request) && openViewName.current === from) onActiveViewChange(to);
      return failure;
    },
    [applySchemaChange, onActiveViewChange, schemaWrites],
  );
  const removeView = useCallback(
    function remove(name: string) {
      const dialog = currentSchemaDialog.current;
      const request = schemaWrites.current();
      void applySchemaChange((current) => deleteView(current, name)).then((failure) => {
        if (!schemaWrites.isCurrent(request)) return;
        if (failure === null) {
          if (openViewName.current === name) onActiveViewChange(null);
          // applySchemaChange reports a failure itself only when a dialog changed.
        } else if (currentSchemaDialog.current === dialog) {
          onError(failure, new Error(failure), () => remove(name));
        }
      });
    },
    [applySchemaChange, onActiveViewChange, onError, schemaWrites],
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
            readAgain();
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
    return <SkeletonRows inSlot layout="panel" label="Loading collection..." />;
  }

  const schema = details.schema;
  const name = schema.name ?? collectionPath.split("/").at(-1) ?? collectionPath;

  // The ⚡ panel docks at the right of whatever the page shows.
  const automationsPanel = automationsOpen ? (
    <AutomationsPanel
      readOnly={readOnly}
      workspaceId={workspaceId}
      collectionPath={collectionPath}
      automations={automations}
      fields={schema.fields}
      focus={panelFocus}
      start={panelStart}
      onStarted={() => setPanelStart(null)}
      closeAsk={closeAsk}
      onClose={closeAutomations}
      onStayed={() => {
        afterAutomationsClose.current = null;
      }}
      onOpenFile={onOpenFile}
      onOpenScheduleSettings={onOpenScheduleSettings}
      onOpenFields={() => setFieldsOpen(true)}
      onError={onError}
      onNotice={onNotice}
    />
  ) : null;

  const customizeDialog = customizing ? (
    <CollectionCustomizeDialog
      name={name}
      files={documentCollectionFiles(collectionPath, automationsFileMade(automations.file))}
      onOpenFile={onOpenFile}
      onClose={() => setCustomizing(false)}
    />
  ) : null;
  const fieldsDialog = fieldsOpen && !readOnly ? (
    <FieldsDialog
      schema={schema}
      relationTargets={relationTargets}
      apply={applySchemaChange}
      addType={fieldsOpen === "date" ? "date" : undefined}
      buttonStates={buttonStates}
      onChooseButtonAutomation={(field) => {
        setFieldsOpen(false);
        panelStarts.current += 1;
        setPanelStart({ automation: buttonAutomation(field, null, []), seq: panelStarts.current });
        showAutomations();
      }}
      onClose={() => setFieldsOpen(false)}
    />
  ) : null;

  const kind = activeView?.kind ?? "table";
  const boardReady =
    kind === "board" && activeView?.groupBy && state.groups !== null;
  // A calendar uses its date field, or the first one when that is gone, no longer a date, or was never named, so adding a date field shows it.
  const dateFields = schema.fields.filter((field) => field.type === "date");
  const calendarReady = kind === "calendar" && (dateFields.find((field) => field.name === activeView?.dateField) ?? dateFields[0])?.name;

  const toggleAutomations = () => (automationsOpen ? setCloseAsk((ask) => ask + 1) : showAutomations());
  // Every record the page holds, in rows or in a board's columns. More can load while a cursor remains.
  const loaded = new Set([...state.records, ...(state.groups?.flatMap((group) => group.records) ?? [])].map((record) => record.path)).size;
  const more = state.nextCursor !== null;
  // Someone who cannot change the Collection switches views and saves none.
  const frameViews: CollectionFrameViews | undefined = readOnly ? undefined : {
    // A board groups by stored values, and a button stores none.
    groupFields: schema.fields.filter((field) => field.type !== "button").map((field) => ({ id: field.name, name: field.name })),
    dateFields: dateFields.map((field) => ({ id: field.name, name: field.name })),
    onAddDateField: () => setFieldsOpen("date"),
    create: createView,
    rename: renameOpenView,
    remove: removeView,
    // Deleting a view drops its configuration with no reverse path, so the menu asks twice.
    confirmDelete: true,
  };

  // The open record, in the panel: its name as the table calls it, a row for each field of the Collection with
  // the table's own editors, and its page body. The ⚡ panel has the place while it is open.
  const recordPanelNode = (() => {
    if (openRecordId === null || automationsOpen) return null;
    const record = shownRecord;
    // The name opens for typing where it is a text field's value, which the page writes as the table's cell does:
    // the field that names the record, or with no name yet, the Collection's title or name field, so a new
    // record can be named. A record of a Collection with neither is named by its file, which no cell writes.
    const labelled = record === null ? null : labelField(record.values);
    const candidate = record === null ? undefined
      : labelled !== null ? schema.fields.find((field) => field.name === labelled && field.type === "text") : nameFieldOf(schema);
    const stored = candidate && record?.values.find((entry) => entry.field === candidate.name)?.value;
    // A value that is not text stays in its row, where its flag shows.
    const nameField = candidate && (typeof stored === "string" || stored === null || stored === undefined) ? candidate : undefined;
    const storedText = typeof stored === "string" ? stored : "";
    const commands: RecordPanelCommand[] = record !== null && onOpenRecordHistory
      ? [{
          id: "history",
          label: "History",
          icon: <History size={14} strokeWidth={1.9} aria-hidden />,
          onSelect: () => onOpenRecordHistory({ collectionPath, recordId: record.id, recordName: recordLabel(record) }),
        }]
      : [];
    return (
      <RecordPanel
        key={openRecordId}
        panelRef={recordPanel.element}
        collectionName={name}
        name={record === null ? "" : recordLabel(record)}
        nameText={nameField ? storedText : undefined}
        nameField={nameField?.name}
        nameLabel={nameField?.name}
        canRename={nameField !== undefined && onCellChange !== undefined && !readOnly}
        onNameChange={nameField && record ? (value) => {
          enqueueCellChange({ recordId: record.id, recordPath: record.path, field: nameField.name, value: value || null });
        } : undefined}
        // A name the input still shows as it was is no change, as for a press away.
        onNameAbandoned={nameField && record ? (text) => {
          if (text !== storedText) saveLeftText(record, nameField.name, text, text || null);
        } : undefined}
        onOpenAsPage={record === null ? undefined : () => afterBodySaved(() => onOpenRecord(record.path))}
        commands={commands}
        loading={record === null && recordProblem === undefined}
        unavailable={recordProblem}
        width={recordPanel.width}
        onWidthChange={recordPanel.setWidth}
        onClose={() => recordPanel.close("opener")}
        properties={record === null ? undefined : (
          <RecordProperties
            schema={schema}
            record={record}
            visibleFields={null}
            omitFields={nameField ? [nameField.name] : undefined}
            onCellChange={readOnly ? undefined : enqueueCellChange}
            onDraftAbandoned={(draft) => saveLeftText(record, draft.field, draft.text, draft.value)}
            editingDisabled={readOnly || writesPaused}
            acknowledgedWriteId={acknowledgedWriteId}
            subscribeToDiscardedWrites={subscribeToDiscardedWrites}
            onCreateOption={readOnly ? undefined : createOption}
            onOptionColorChange={readOnly ? undefined : changeOptionColor}
            people={people}
            personLabel={personLabel}
            onOpenLink={openCellLink}
            relationExecutor={executor}
            fieldMarks={tableFieldMarks}
            renderButton={readOnly ? undefined : renderButton}
          />
        )}
        body={record === null ? undefined : renderRecordBody?.(record.path)}
      />
    );
  })();

  return (
    <CollectionFrame
      name={name}
      // An editor, a picker and a menu each take their own Escape. The next one closes the open record.
      onKeyDown={recordPanel.onPageKeyDown}
      count={`${loaded}${more ? "+" : ""} ${loaded === 1 && !more ? "record" : "records"}`}
      status={state.status === "error" ? (
        <>
          <span className="truncate text-[12px] text-danger">
            dohc could not read this collection's records. {state.error}
          </span>
          <SecondaryButton size="compact" onClick={readAgain}>
            Retry
          </SecondaryButton>
        </>
      ) : writesPaused ? (
        <span
          data-testid="collection-writes-paused"
          className="truncate text-[12px] text-muted"
        >
          Editing is paused while dohc changes files in this workspace.
        </span>
      ) : writeError ? (
        <span data-testid="collection-write-error" className="truncate text-[12px] text-danger">
          {writeError}
        </span>
      ) : null}
      // A Collection with no saved view shows its default table as the one tab.
      tabs={views.length > 0 ? views.map((view) => ({ id: view.name, name: view.name, kind: view.kind, saved: true })) : [{ id: "", name: "Table", kind: "table" }]}
      activeTabId={activeView?.name ?? ""}
      onSelectTab={(id) => { if (id !== "") onActiveViewChange(id); }}
      views={frameViews}
      automations={{ open: automationsOpen, count: automationCount(automations.file), onToggle: toggleAutomations }}
      newRecord={readOnly ? undefined : { onClick: newRecord, disabled: writesPaused }}
      menuLabel="Collection actions"
      menu={[
        { label: "View", commands: [
          !readOnly && { id: "fields", label: "Fields", icon: <LayoutList size={14} strokeWidth={1.9} aria-hidden />, testId: "collection-fields-button", onSelect: () => setFieldsOpen(true) },
          !readOnly && { id: "views", label: "Views", icon: <PanelsTopLeft size={14} strokeWidth={1.9} aria-hidden />, testId: "collection-views-button", onSelect: () => setViewsOpen(true) },
        ] },
        { label: "Collection", commands: [
          { id: "automations", label: "Automations", icon: <Zap size={14} strokeWidth={1.9} aria-hidden />, count: automationCount(automations.file), onSelect: toggleAutomations },
          { id: "customize", label: "Customize…", icon: <SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden />, onSelect: () => setCustomizing(true) },
        ] },
      ]}
      panel={recordPanelNode ?? automationsPanel}
    >
      {drainCapped ? (
        <div
          data-testid="collection-drain-cap"
          className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-muted"
        >
          This view shows only the first {state.records.length} records.
        </div>
      ) : null}
      {recordDrafts.length > 0 ? <div className="shrink-0 border-b border-line px-3 py-2" data-testid="collection-record-drafts">
        {recordDrafts.map(record => <div key={record.path} className="flex items-center gap-2 text-[12px] text-muted">
          <button type="button" className="truncate text-ink hover:underline" onClick={() => onOpenRecord(record.path)}>{recordLabel(record)}</button>
          <span>{accessEnded ? "Access ended. This draft cannot be sent. It is kept on this computer." : readOnly ? "This draft cannot be sent with the current share access. It is kept on this computer." : record.creationDelivery === "offline" ? "Saved on this computer. This computer is offline" : record.creationDelivery === "pending" ? "Saved on this computer. Waiting to send" : record.creationRefusal ?? "The sync relay did not accept this draft"}</span>
          {!readOnly ? <SecondaryButton onClick={() => record.creationDelivery === "refused" ? onNewRecord(collectionPath) : void retryDrafts()}>Try again</SecondaryButton> : null}
          {record.creationCanDiscard === true && !readOnly ? <SecondaryButton onClick={() => void discardDraft(record)}>Discard draft</SecondaryButton> : null}
        </div>)}
      </div> : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {boardReady ? (
          <BoardView
            schema={schema}
            groups={state.groups ?? []}
            groupBy={activeView?.groupBy ?? ""}
            visibleFields={activeView?.visibleFields ?? null}
            onCellChange={readOnly ? undefined : onCellChange}
            onOpenRecord={openRecord}
            openRecordId={openRecordId}
            onNewRecord={readOnly || writesPaused ? undefined : newRecordInGroup}
            onOptionColorChange={readOnly ? undefined : changeGroupColor}
            personLabel={personLabel}
          />
        ) : calendarReady ? (
          <CalendarView
            schema={schema}
            records={state.records}
            dateField={calendarReady}
            visibleFields={activeView?.visibleFields ?? null}
            onCellChange={readOnly ? undefined : onCellChange}
            onOpenRecord={openRecord}
            openRecordId={openRecordId}
          />
        ) : kind === "calendar" ? (
          <CalendarNeedsDateField onAddDateField={readOnly ? undefined : () => setFieldsOpen("date")} />
        ) : (
          <TableView
            schema={schema}
            records={state.records}
            sort={state.query.sort ?? []}
            visibleFields={activeView?.visibleFields ?? null}
            onSortChange={(sort) => void store.setQuery({ sort })}
            onCellChange={readOnly ? undefined : enqueueCellChange}
            onDraftAbandoned={saveLeftCell}
            editingDisabled={readOnly || writesPaused}
            acknowledgedWriteId={acknowledgedWriteId}
            subscribeToDiscardedWrites={subscribeToDiscardedWrites}
            onCreateOption={readOnly ? undefined : createOption}
            onOptionColorChange={readOnly ? undefined : changeOptionColor}
            people={people}
            personLabel={personLabel}
            onOpenLink={openCellLink}
            onOpenRecord={openRecord}
            openRecordId={openRecordId}
            relationExecutor={executor}
            fieldMarks={tableFieldMarks}
            renderButton={readOnly ? undefined : renderButton}
            onNearEnd={loadNextPage}
            newRecord={readOnly ? undefined : tableNewRecord}
          />
        )}
      </div>
      {fieldsDialog}
      {customizeDialog}
      {viewsOpen && !readOnly ? (
        <ViewsDialog
          schema={schema}
          apply={applySchemaChange}
          onClose={() => setViewsOpen(false)}
          // A write that ends after the page closed answers as a success, and changes nothing in the shell.
          onRenamed={(from, to) => {
            if (schemaWrites.isCurrent(pageWrites) && openViewName.current === from) onActiveViewChange(to);
          }}
          onDeleted={(name) => {
            if (schemaWrites.isCurrent(pageWrites) && openViewName.current === name) onActiveViewChange(null);
          }}
        />
      ) : null}
    </CollectionFrame>
  );
}
