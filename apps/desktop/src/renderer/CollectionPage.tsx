import { useRequestSequence } from "./useRequestSequence";
import { collectionVersionError } from "@dohc/workspace-contracts/collection";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LayoutList, PanelsTopLeft, SlidersHorizontal, Zap } from "lucide-react";
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
import { CollectionCustomizeDialog, documentCollectionFiles } from "./collections/CollectionCustomizeDialog";
import { CollectionFrame, type CollectionFrameViews, type NewCollectionView } from "./collections/CollectionFrame";
import { FieldsDialog } from "./collections/FieldsDialog";
import { ViewsDialog } from "./collections/ViewsDialog";
import {
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
  // The shell creates the record file (untitled naming needs the file
  // listing, which the shell owns) and opens it; adoption mints the id.
  // `created` runs once the record exists, before it opens.
  onNewRecord: (
    collectionPath: string,
    created?: (record: { path: string; recordId: string }) => void,
  ) => void;
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

  const newRecord = useCallback(
    () => onNewRecord(collectionPath),
    [onNewRecord, collectionPath],
  );
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
  const openRecord = useCallback(
    (record: CollectionRecord) => onOpenRecord(record.path),
    [onOpenRecord],
  );
  const recordDrafts = [...new Map([...state.records, ...(state.groups?.flatMap(group => group.records) ?? [])]
    .filter(record => record.creationDelivery === "pending" || record.creationDelivery === "offline" || record.creationDelivery === "refused").map(record => [record.path, record])).values()];
  const draftActions = useRequestSequence([workspaceId, collectionPath, readOnly]);
  const draftAccess = useRef({ readOnly, accessEnded, writeRefusal });
  draftAccess.current = { readOnly, accessEnded, writeRefusal };
  const retryDrafts = async () => {
    if (draftAccess.current.readOnly) {
      const message = draftAccess.current.writeRefusal ?? (draftAccess.current.accessEnded ? "Your access to this share ended."
        : "Your access to this share changed. Ask for Edit access, then reopen the share.");
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
  // follows a new, renamed or deleted view there.
  const openViewName = useRef(activeViewName);
  openViewName.current = activeViewName;
  const createView = useCallback(
    async (view: NewCollectionView): Promise<string | null> => {
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
      if (failure === null) onActiveViewChange(view.name);
      return failure;
    },
    [applySchemaChange, onActiveViewChange],
  );
  const renameOpenView = useCallback(
    async (from: string, to: string): Promise<string | null> => {
      const failure = await applySchemaChange((current) => renameView(current, from, to));
      if (failure === null && openViewName.current === from) onActiveViewChange(to);
      return failure;
    },
    [applySchemaChange, onActiveViewChange],
  );
  const removeView = useCallback(
    function remove(name: string) {
      const dialog = currentSchemaDialog.current;
      void applySchemaChange((current) => deleteView(current, name)).then((failure) => {
        if (failure === null) {
          if (openViewName.current === name) onActiveViewChange(null);
          // applySchemaChange reports a failure itself only when a dialog changed.
        } else if (currentSchemaDialog.current === dialog) {
          onError(failure, new Error(failure), () => remove(name));
        }
      });
    },
    [applySchemaChange, onActiveViewChange, onError],
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
        setAutomationsOpen(true);
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

  const toggleAutomations = () => (automationsOpen ? setCloseAsk((ask) => ask + 1) : setAutomationsOpen(true));
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

  return (
    <CollectionFrame
      name={name}
      count={`${loaded}${more ? "+" : ""} ${loaded === 1 && !more ? "record" : "records"}`}
      status={state.status === "error" ? (
        <>
          <span className="truncate text-[12px] text-danger">
            dohc could not read this collection's records. {state.error}
          </span>
          <SecondaryButton size="compact" onClick={() => void store.refresh()}>
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
      newRecord={readOnly ? undefined : { onClick: newRecord }}
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
      panel={automationsPanel}
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
            editingDisabled={readOnly || writesPaused}
            acknowledgedWriteId={acknowledgedWriteId}
            subscribeToDiscardedWrites={subscribeToDiscardedWrites}
            onCreateOption={readOnly ? undefined : createOption}
            onOptionColorChange={readOnly ? undefined : changeOptionColor}
            people={people}
            personLabel={personLabel}
            onOpenLink={openCellLink}
            onOpenRecord={openRecord}
            relationExecutor={executor}
            fieldMarks={tableFieldMarks}
            renderButton={readOnly ? undefined : renderButton}
            onNearEnd={loadNextPage}
            onNewRecord={readOnly ? undefined : newRecord}
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
          onRenamed={(from, to) => {
            if (activeViewName === from) onActiveViewChange(to);
          }}
          onDeleted={(name) => {
            if (activeViewName === name) onActiveViewChange(null);
          }}
        />
      ) : null}
    </CollectionFrame>
  );
}
