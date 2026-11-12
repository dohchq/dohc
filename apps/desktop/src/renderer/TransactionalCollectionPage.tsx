import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, Archive, ChevronLeft, ChevronRight, Clock, Download, Eraser, FileCode, FileInput, FileSpreadsheet, History, Inbox, LayoutList, PanelsTopLeft, RefreshCw, Shield, SlidersHorizontal, Trash2, Undo2, Zap } from "lucide-react";
import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { DatasetCopyStatus } from "@dohc/cli/dataset";
// The table alone: the package's index also loads the board and the calendar, which this page loads only for those views.
import { DISCARD_HINT, TableView, type CollectionCellChange, type TableAbandonedDraft, type TableFieldMark, type TableHostCell, type TableNewRecord, type TableNewRecordStatus } from "@dohc/collection-views/table";
import { CellStatusNote, RecordProperties } from "@dohc/collection-views/record";
import type { CollectionQuerySort, CollectionRecord, CollectionValue, FieldDefinition } from "@dohc/workspace-contracts";
import type { CollectionTableView } from "./collectionTableViews";
import { readCollectionReopenWait } from "../ipc/errorWords";
import { EmptyState, FieldError, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { CopyButton } from "./ui/CopyButton";
import { SkeletonRows } from "./ui/SkeletonRows";
import { TextNotSavedError } from "./shell/copyDetails";
import { AutomationFieldIcon, automationFieldMarkLabel, type FieldMarks } from "./collections/collectionFieldMarks";
import { inputClass } from "./collections/FieldForm";
import { CalendarNeedsDateField } from "./collections/CalendarNeedsDateField";
import { CollectionFrame, type CollectionFrameTab, type CollectionFrameViewField, type CollectionFrameViews, type NewCollectionView } from "./collections/CollectionFrame";
import { RecordPanel, type RecordPanelCommand } from "./collections/RecordPanel";
import { useRecordPanel, type RecordPanelHost } from "./collections/useRecordPanel";
import { invalidField } from "./CollectionResourceInputs";
import { ResourceCell, ResourceCellEditor } from "./TransactionalResourceCells";
import type { CollectionResources, CollectionResourceScope } from "./transactionalCollectionResources";
import {
  cannotTake, display, emptyValue, fieldShape, initialValue, inputProblem, isEmptyValue, isGeneratedRecordIdField, object, parsePage, supportsInput, supportsSort,
  type TransactionalCursor, type TransactionalDatasetDescription, type TransactionalField, type TransactionalPage, type TransactionalRow,
} from "./transactionalCollectionModel";
import { buttonColumn, buttonField, recordName, tableRecords, tableSchema, visualRecord, visualSchema } from "./transactionalVisualQueries";
import { resetWriteQueuesForTests, RULES_DISALLOW, writeQueueFor, type QueuedWrite, type Typed, type WriteAttention } from "./transactionalWriteQueue";

export type { TransactionalDatasetDescription, TransactionalRow } from "./transactionalCollectionModel";
const TransactionalCollectionViews = lazy(() => import("./TransactionalCollectionViews").then(module => ({default: module.TransactionalCollectionViews})));
export interface TransactionalInvoke {
  workspaceId: string;
  datasetId: string;
  revision: number;
  revisionSha256: string;
  operationId: string;
  input: AppBackendJson;
  idempotencyKey: string;
}
/** The table's Button fields, by name, and the button each record shows for one. */
export interface TransactionalButtons {
  fields: readonly string[];
  render(field: string, row: TransactionalRow): ReactNode;
}
export interface TransactionalCollectionPageProps extends CollectionResources, RecordPanelHost {
  buttons?: TransactionalButtons;
  /**
   * The ⚡ panel's button: whether the panel is open, how many automations the table has, and what a press does.
   * `close` asks the open panel to close, then runs `then`. A person who keeps a draft there keeps the panel, and `then` never runs.
   */
  automations?: { open: boolean; count: number; onToggle(): void; close(then: () => void): void };
  /** The ⚡ panel, docked at the right of the view. An open record takes its place: one side panel shows at a time. */
  panel?: ReactNode;
  /** The fields switched-on automations set, by name, with those automations' names. */
  fieldMarks?: FieldMarks;
  activeView?: CollectionTableView | null;
  /** What someone who can save views does with them. Without it, the tabs change the layout on this computer and save nothing. */
  views?: TransactionalViewControls;
  copy?: DatasetCopyStatus;
  onRefresh?(): void;
  recordsVersion?: number;
  /** Rises when records changed outside this page, as an automation changes them; the page reads them again in place. */
  recordsChanged?: number;
  workspaceId: string;
  dataset: TransactionalDatasetDescription;
  tableId: string;
  invoke(request: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
  /** `identity` names one row in Notices, which a newer report with it replaces. */
  onError(fallback: string, error: unknown, retry: (() => void) | null, identity?: string): void;
  /** The records loaded, so the row their last failed load left in Notices goes. */
  onSettled?(identity: string): void;
  /** Something finished that the page does not show, as a record made on another page of records. */
  onNotice?(message: string): void;
  /** Shell-owned confirmation states the real recovery path before deletion. */
  confirmDelete?(row: TransactionalRow): Promise<boolean>;
  onCustomAction?(operationId: string): void;
  onCreateForm?(): void;
  onTransferCsv?(): void;
  onHistory?(): void;
  onPendingResponses?(): void;
  onReviewSchema?(): void;
  /** Opens the fields dialog on a new Date field, for a calendar that has none. */
  onAddDateField?(): void;
  onCustomize?(): void;
  /** Opens the file that describes the Collection. */
  onOpenSource?(): void;
  onManageAccess?(): void;
  onExportRecovery?(): void;
  onArchive?(): void;
}
/** A table's saved views, as the tabs show and change them. */
export interface TransactionalViewControls {
  list: readonly CollectionTableView[];
  /** The views file is being read or written. */
  busy: boolean;
  /** Opens a saved view, or All records for null. */
  select(viewId: string | null): void;
  /** Each answers what went wrong as a sentence, or null. */
  create(view: NewCollectionView): Promise<string | null>;
  rename(viewId: string, name: string): Promise<string | null>;
  remove(viewId: string): void;
  /** Saves the field a board groups by, or the date field a calendar uses. */
  setField(viewId: string, field: { groupBy: string } | { dateField: string }): void;
  /** Opens the editor for a view's search, sort and filters. */
  edit(viewId: string): void;
  /** Opens the list of views. */
  manage(): void;
}
const ALL_RECORDS = "all-records";
/** The tabs of someone who cannot save views: one per layout. A board shows only when a field can group it. */
const LAYOUT_TABS: readonly CollectionFrameTab[] = [{ id: "table", name: "Table", kind: "table" }, { id: "board", name: "Board", kind: "board" }, { id: "calendar", name: "Calendar", kind: "calendar" }];
const NEW_RECORD_OPEN = "Create or cancel the new record first.";
const RECORDS_LOADING = "Wait for the records to load.";
const FILE_UPLOADING = "Wait for the file to upload.";
const RECORDS_FAILED = "dohc could not load the records. Refresh first.";
type Query = { after: TransactionalCursor | null; search: string; filters?: CollectionTableView["filters"]; sort?: { fieldId: string; direction: "asc" | "desc" } };
/** A new record open in the panel, before it exists. A record's fields change in its cells and in its panel. */
type Editor = { operation: DatasetOperation };
/** The key of the record the panel shows before it exists. A record's key is its id as JSON, which this is not. */
const NEW_RECORD = "new-record";
/** The last confirmed edit that can be reversed: its record at the version its receipt reported, and the values it replaced. */
type Undo = { operation: DatasetOperation; id: string | number; version: number; values: Record<string, AppBackendJson> };
/** A field of the new record in the panel: its definition now, or the one its value was typed under once it is gone, and whether its value no longer fits. */
type FormField = { field: TransactionalField; value: AppBackendJson; changed: boolean };
const VALUE_CHANGED = "This field changed, so this value can't be saved. Copy it if you need it, then clear it.";
const CHANGE_GONE = "The Collection's rules no longer allow this change. Copy what you need, then choose Cancel.";
const SAVE_OFFLINE = "You can save this once the Collection is back online.";
const EDIT_LEFT_OPEN = "This edit was still open, so dohc did not save it.";

function undoFromReceipt(write: QueuedWrite, operation: DatasetOperation | undefined, raw: AppBackendJson): Undo | null {
  if (!operation || operation.kind !== "edit" || !operation.reversible || write.kind !== "edit" || write.undo || !write.record) return null;
  let result: Record<string, AppBackendJson>;
  try { result = object(parseAppBackendJson(raw)); } catch { return null; }
  const priorRaw = result.priorValues;
  if (priorRaw === undefined) return null;
  try {
    const prior = object(priorRaw);
    const changedFields = Object.keys(write.values).sort();
    if (typeof result.version !== "number" || !Number.isSafeInteger(result.version) || result.version < 1 || JSON.stringify(result.id) !== write.record.key ||
      JSON.stringify(Object.keys(prior).sort()) !== JSON.stringify(changedFields) || Object.keys(prior).some(field => !operation.fieldIds.includes(field))) return null;
    return { operation, id: write.record.id, version: result.version, values: prior };
  } catch { return null; }
}

/** The record a create's receipt names, by its key, or null where it names none. */
function receiptKey(raw: AppBackendJson): string | null {
  try {
    const { id } = object(parseAppBackendJson(raw));
    return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;
  } catch { return null; }
}

/** A value dohc can't save: read-only, beside a copy of it and the one control that clears it. */
function ChangedValue({ name, value, disabled, describedBy, onClear }: { name: string; value: AppBackendJson; disabled: boolean; describedBy?: string; onClear(): void }) {
  return <span className="flex min-w-0 items-center gap-1">
    <input aria-label={name} {...invalidField(describedBy)} readOnly value={display(value)} className={inputClass} />
    <CopyButton iconOnly pinName label="Copy value" getText={() => display(value)} />
    <IconButton title="Clear value" aria-label="Clear value" disabled={disabled} onClick={onClear}><Eraser size={15} strokeWidth={1.9} aria-hidden /></IconButton>
  </span>;
}

/** A value from the table as the Collection's operations take it, or undefined for a kind they can't take. */
function jsonValue(value: CollectionValue): AppBackendJson | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const items: AppBackendJson[] = [];
  for (const entry of value) { const item = jsonValue(entry); if (item === undefined) return undefined; items.push(item); }
  return items;
}
/** Whether a cell already holds a value. Nothing typed is the same nothing, however the field stores it. */
const sameValue = (a: AppBackendJson, b: AppBackendJson) => JSON.stringify(a) === JSON.stringify(b) || (isEmptyValue(a) && isEmptyValue(b));

// The page draws again whenever a change is queued or confirmed. The table's props stay the same
// through that, so the table does not: each cell reads its own change from the queue.
const DataTable = memo(TableView);
const NO_BUTTONS: readonly string[] = [];

function unconfirmedWords(write: QueuedWrite): string {
  if (write.kind === "create") return "dohc could not confirm the new record.";
  return write.kind === "delete" ? `dohc could not confirm the deletion of record ${String(write.record?.id)}.` : `dohc could not confirm a change to record ${String(write.record?.id)}.`;
}
/** A change that waits, in the words its cell would show: "Waiting for…" becomes "… is waiting for…". */
function waitingWords(write: QueuedWrite, reason: string): string {
  const subject = write.kind === "create" ? "A new record" : write.kind === "delete" ? `The deletion of record ${String(write.record?.id)}` : `A change to record ${String(write.record?.id)}`;
  return `${subject} is ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;
}
/** A new record's values on one line, for its copy. */
const recordText = (values: Readonly<Record<string, Typed>>) => Object.values(values).filter(typed => !isEmptyValue(typed.value)).map(typed => `${typed.under.name}: ${display(typed.value)}`).join(", ");
/**
 * The changes that need the person and that no cell on screen shows: a
 * change dohc could not confirm, with Try again and Discard, a change that
 * waits, a value or a new record dohc did not save, with a copy of it
 * and the control that clears it, and a deletion that did not happen, with
 * why and Dismiss.
 */
function UnshownChanges({ items, onRetry, onDiscard, onClear, onClearRecord, onDismissDeletion }: { items: readonly WriteAttention[]; onRetry(id: number): void; onDiscard(id: number): void; onClear(recordKey: string, fieldId: string): void; onClearRecord(id: number): void; onDismissDeletion(id: number): void }) {
  const ids = useId();
  return <div role="group" aria-label="Changes dohc did not confirm" className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3 text-[12px] text-muted">
    {items.map((item, index) => item.kind === "unconfirmed"
      ? <div key={`change:${item.write.id}`} className="flex flex-wrap items-center gap-2"><span>{unconfirmedWords(item.write)}</span>
        <SecondaryButton size="row" onClick={() => onRetry(item.write.id)}>Try again</SecondaryButton><SecondaryButton size="row" title={DISCARD_HINT} onClick={() => onDiscard(item.write.id)}>Discard</SecondaryButton></div>
      : item.kind === "waiting" ? <span key={`waiting:${item.write.id}`}>{waitingWords(item.write, item.reason)}</span>
      : item.kind === "deletion" ? <div key={`deletion:${item.id}`} className="flex flex-wrap items-center gap-2"><span>dohc did not delete {item.name}. {item.reason}</span>
        <SecondaryButton size="row" onClick={() => onDismissDeletion(item.id)}>Dismiss</SecondaryButton></div>
      : item.kind === "held" ? <div key={`value:${item.recordKey}:${item.fieldId}`} className="flex flex-col gap-1">
        <span>{item.fieldName} of record {String(item.recordId)}</span>
        <ChangedValue name={item.fieldName} value={item.value} disabled={false} describedBy={`${ids}-${index}`} onClear={() => onClear(item.recordKey, item.fieldId)} />
        <FieldError id={`${ids}-${index}`}>{item.reason}</FieldError>
      </div>
      : <div key={`record:${item.id}`} className="flex flex-col gap-1">
        <span>New record</span>
        <ChangedValue name="New record" value={recordText(item.values)} disabled={false} describedBy={`${ids}-${index}`} onClear={() => onClearRecord(item.id)} />
        <FieldError id={`${ids}-${index}`}>{item.reason}</FieldError>
      </div>)}
  </div>;
}

/** Whether a field's values, read or typed under the `before` fields, may not show under the `now` ones. */
function staleUnder(before: readonly TransactionalField[], now: readonly TransactionalField[]): (fieldId: string) => boolean {
  const old = new Map(before.map(field => [field.fieldId, field])), current = new Map(now.map(field => [field.fieldId, field]));
  return fieldId => { const a = old.get(fieldId), b = current.get(fieldId); return !a || !b || fieldShape(a) !== fieldShape(b); };
}
/** The row without the values `stale` names, or the same row when it has none. */
function withoutStale(row: TransactionalRow, stale: (fieldId: string) => boolean): TransactionalRow {
  return Object.keys(row.values).some(stale) ? { ...row, values: Object.fromEntries(Object.entries(row.values).filter(([fieldId]) => !stale(fieldId))) } : row;
}
type KeptEdit = { editor: Editor; draft: Record<string, Typed> };
// A new record in the panel, with changes, that a page held when it closed without asking, as when another file
// opens in its tab group, by workspace, Collection and table. The page opens it in the panel again.
const keptEdits = new Map<string, KeptEdit>();
/** Tests start without edits and changes an earlier test's page kept. */
export function resetKeptCollectionEditsForTests(): void {
  keptEdits.clear();
  resetWriteQueuesForTests();
}

/** Keep view state across refreshes, but never across Collection identities. */
export function TransactionalCollectionPage(props: TransactionalCollectionPageProps) {
  const scope = JSON.stringify([props.workspaceId, props.dataset.datasetId, props.tableId]);
  return <ScopedCollectionPage key={scope} {...props} />;
}
/** What the table's callbacks read when they run. They keep one identity, so the table's columns are built once. */
interface Live {
  /** The page's records and the open record, by key. */
  rows: ReadonlyMap<string, TransactionalRow>;
  /** Opens a record in the panel. */
  openRecord(row: TransactionalRow): void;
  fields: TransactionalField[];
  /** The fields a cell can change now, by id. */
  editable: ReadonlySet<string>;
  editOperation(fieldId: string): DatasetOperation | undefined;
  /** A load or a new record open in the panel holds the page's own controls. */
  held: boolean;
  query: Query;
  load(next: Query, history?: Array<TransactionalCursor | null>): Promise<void>;
  openCreate(opener: HTMLElement | null): void;
  /** The fields the table's new row takes a value in, by id. */
  creatable: ReadonlySet<string>;
  /** Gives a field of the new record in the panel a value. */
  changeDraft(fieldId: string, value: AppBackendJson): void;
  /** What people call the table. */
  tableName: string;
  /** A file of the new record in the panel started or stopped uploading. */
  uploading(fieldId: string, busy: boolean): void;
  /** Says a record the table's new row made has no row on screen. */
  outOfView(): void;
  scope: CollectionResourceScope;
  offline: boolean;
  read: DatasetOperation;
  resources: CollectionResources;
  onError: TransactionalCollectionPageProps["onError"];
}
function ScopedCollectionPage(props: TransactionalCollectionPageProps) {
  const { workspaceId, dataset, tableId, invoke, onError, confirmDelete, onCustomAction } = props;
  const offline = props.copy?.offline ?? false;
  const table = dataset.tables.find(table => table.tableId === tableId);
  const operations = dataset.operations.filter(operation => operation.tableId === tableId && (!offline || operation.readOnly));
  const read = operations.find(operation => operation.kind === "read" && operation.readOnly);
  const create = operations.find(operation => operation.kind === "create" && !operation.readOnly);
  const remove = operations.find(operation => operation.kind === "delete" && !operation.readOnly);
  const fields = table?.fields.filter(field => read?.fieldIds.includes(field.fieldId) &&
    !isGeneratedRecordIdField(field)) ?? [];
  const createFields = table?.fields.filter(field => create?.fieldIds.includes(field.fieldId)) ?? [];
  const canInput = (field: TransactionalField) => supportsInput(field) || (field.type === "attachment" && !!props.uploadFile) || (field.type === "relation" && !!field.relation && !!props.resolveRelation);
  const canCreate = create && createFields.every(canInput);
  const scope: CollectionResourceScope = { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256 };
  // What a change to a field runs: its approved edit operation now. An offline copy has none, and neither
  // does a field the caller may read and not change, whoever owns the Collection.
  const editOperation = (fieldId: string) => operations.find(operation => operation.kind === "edit" && !operation.readOnly && operation.fieldIds.includes(fieldId));
  const [localView, setLocalView] = useState<CollectionTableView | null>(null);
  const selectedView = localView ?? props.activeView;
  useLayoutEffect(() => { setLocalView(null); }, [props.activeView]);
  const [page, setPage] = useState<TransactionalPage | null>(null);
  const [busy, setBusy] = useState(false);
  // The last read of records that failed, until a read succeeds: its words, the toast's retry, and the wait a reopening Collection set.
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [visualBusy, setVisualBusy] = useState(false), [visualRefresh, setVisualRefresh] = useState(0), [visualChanged, setVisualChanged] = useState(0);
  // Rises when a field change leaves a board or calendar holding groups, months or values of the old fields, so it opens afresh.
  const [visualEpoch, setVisualEpoch] = useState(0);
  const visual = selectedView?.kind === "board" || selectedView?.kind === "calendar";
  // A calendar uses its date field, or the first one when that is gone or was never chosen, so adding a date field shows it.
  const dateFields = fields.filter(field => field.type === "date");
  const shownView = selectedView?.kind === "calendar" && !dateFields.some(field => field.fieldId === selectedView.dateField) ? { ...selectedView, dateField: dateFields[0]?.fieldId } : selectedView;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<Query>({ after: null, search: "" });
  const [previous, setPrevious] = useState<Array<TransactionalCursor | null>>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  // The open record as last read: from the page, a board or calendar, or by its key. Null until a read shows it.
  const [details, setDetails] = useState<TransactionalRow | null>(null);
  const detailsRef = useRef(details); detailsRef.current = details;
  // What the panel says instead of the record's values, by the record's key, once a read could not find it.
  const [detailsUnavailable, setDetailsUnavailable] = useState<{ id: string; text: string } | null>(null);
  // The by-key read of an open record a read in place left out, while it runs.
  const openRecordRead = useRef<AbortController | null>(null);
  // The panel of a new record, before the record exists.
  const draftPanel = useRef<HTMLElement | null>(null);
  // What the person gave the new record in the panel, by field id. A field they have not touched shows a new
  // record's default, under the field's definition now.
  const [draft, setDraft] = useState<Record<string, Typed>>({});
  const draftNow = useRef(draft); draftNow.current = draft;
  // What is wrong with each field the person tried to save, by field id.
  const [invalid, setInvalid] = useState<Readonly<Record<string, string>>>({});
  const errorIds = useId(), focusInvalid = useRef(false);
  // The changes made to this table that its host has not confirmed. The queue is the table's one, by workspace,
  // Collection and table: every page of the table shares it, and an answer for another table reaches another queue.
  const queue = useState(() => writeQueueFor(JSON.stringify([workspaceId, dataset.datasetId, tableId])))[0];
  // This page's view of it, with the confirmed values this page's own records do not show yet.
  const view = useState(() => queue.page())[0];
  useSyncExternalStore(queue.subscribe, queue.version);
  // The change the panel's new record sent, while the panel waits for its answer.
  const [awaiting, setAwaiting] = useState<number | null>(null), awaitingRef = useRef<number | null>(null);
  // Why the Collection did not take the panel's new record.
  const [formRefusal, setFormRefusal] = useState<string | null>(null);
  // The table's new row, while its save is with the queue: the change, and what tells the row how it ended.
  const rowSave = useRef<{ id: number; report(status: TableNewRecordStatus): boolean } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  // A file of the new record in the panel is uploading, by field. Until it ends, a create would go without the
  // file, so the page's controls and the panel's buttons wait, and reads that would redraw the page are put off.
  const [resourceBusy, setResourceBusy] = useState(false);
  const pendingResources = useRef(new Set<string>());
  function uploading(fieldId: string, busy: boolean): void {
    if (busy) pendingResources.current.add(fieldId); else pendingResources.current.delete(fieldId);
    if (alive.current) setResourceBusy(pendingResources.current.size > 0);
  }
  // Text an editor of the new record held when it went with the page, by field, which the kept record takes.
  const leftInEditors = useRef<Record<string, Typed>>({});
  const alive = useRef(true), sequence = useRef(0), readActive = useRef<AbortController | null>(null);
  // A full read of records holds the page's own controls. A change never does.
  const locked = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const currentQuery = useRef(query); currentQuery.current = query;
  const loadedVersion = useRef(props.recordsVersion), changedVersion = useRef(props.recordsChanged);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; readActive.current?.abort(); openRecordRead.current?.abort(); }; }, []);
  // Whether a new record is open in the panel. A change to the fields keeps it, and its focus.
  const opened = editor && editor.operation.operationId;
  useLayoutEffect(() => {
    if (!editor) return;
    // Focus goes to the new record's first field, or to its panel.
    const first = draftPanel.current?.querySelector<HTMLElement>("[data-property-value] button:not(:disabled), [data-property-value] input:not(:disabled), [data-property-value] [tabindex='0']");
    (first ?? draftPanel.current)?.focus({ preventScroll: true });
  }, [opened]);

  function request(operation: DatasetOperation, input: AppBackendJson, key: string): TransactionalInvoke {
    return { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, operationId: operation.operationId, input, idempotencyKey: key };
  }
  function pageInput(next: Query): AppBackendJson {
    const input: Record<string, AppBackendJson> = { limit: 50 };
    if (next.after) input.after = { id: next.after.id, value: next.after.value };
    if (next.search) input.search = next.search;
    if (next.filters?.length) input.filters = next.filters;
    if (next.sort) input.sort = { ...next.sort };
    return input;
  }
  // One row in Notices for this table's failed loads: a newer failure replaces it, and a load that succeeds removes it.
  const loadIdentity = `collection-load:${dataset.datasetId}:${tableId}`;
  /** A read of records failed: the page says so in place, and Notices keeps one row for it. */
  function failLoad(words: string, cause: unknown, retry: () => void): void {
    const wait = readCollectionReopenWait(cause);
    setFailure({ words: wait?.words ?? words, retry, wait: wait && { ms: wait.waitMs, ended: false } });
    onError(words, cause, retry, loadIdentity);
  }
  /** A read of records succeeded, in a page, a view, or in place, so nothing about a failed one stays. */
  function settle(): void {
    setFailure(null);
    props.onSettled?.(loadIdentity);
  }
  async function load(next: Query, history = previous): Promise<void> {
    if (!read || !alive.current) return;
    readActive.current?.abort();
    if (visual) {
      // A table read still in flight is stale now: it must not settle, or end a load, on the view's behalf.
      readActive.current = null; sequence.current++; openRecordRead.current?.abort();
      locked.current = false; setBusy(false);
      // The view reads again, and the open record shows what that read finds of it.
      setQuery(next); setVisualRefresh(value => value + 1); return;
    }
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current, shows = view.readStarted();
    locked.current = true; setBusy(true);
    let shown: readonly TransactionalRow[] | null = null;
    try {
      const response = await invoke(request(read, pageInput(next), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded); setQuery(next); setPrevious(history);
      settle();
      showRead(shows, loaded.rows);
      shown = loaded.rows;
    } catch (cause) {
      if (alive.current && sequence.current === mine && !abort.signal.aborted) {
        setPage(null); setDetails(null);
        failLoad(`dohc could not load ${table?.name ?? "this collection"}.`, cause, () => { if (alive.current) void load(next, history); });
      }
    } finally {
      if (alive.current && sequence.current === mine) { locked.current = false; setBusy(false); }
    }
    // The open record stays open on another page of records, a search or a sort. The read no longer holds
    // the page, so a record it left out is read by its key.
    if (shown) showOpenRecord(shown);
  }
  // The words state the wait when it began, so once it ends the page says so.
  useEffect(() => {
    if (!failure?.wait || failure.wait.ended) return;
    const timer = setTimeout(() => setFailure(current => current === failure ? { ...failure, wait: { ms: failure.wait!.ms, ended: true } } : current), failure.wait.ms);
    return () => clearTimeout(timer);
  }, [failure]);
  // The queue reads the page's rules and handlers when it sends and when an answer comes, so each commit gives
  // it the current ones. It is given them before the page opens it, and before the rules change under it below.
  // The queue keeps the rules of the newest revision a page of the table has given, and checks this page's changes against those.
  useLayoutEffect(() => {
    view.sync({ workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, tableName: table?.name ?? "this Collection",
      fields: table?.fields ?? [], primaryKeyFieldId: table?.primaryKeyFieldId, operations, offline, invoke, onError, onSettled: props.onSettled,
      confirmed, dropped, unconfirmed, read: readForQueue, describe: () => props.onRefresh?.() });
  });
  // A page that closes leaves the queue to go on without it: it sends what is unsent, and what it could not
  // confirm is on its cells when a page of the table opens again.
  useLayoutEffect(() => view.open(), [view]);
  const contractKey = JSON.stringify([dataset.revision, dataset.revisionSha256, dataset.operations, props.copy?.offline ?? false]);
  const priorContract = useRef(contractKey);
  // The fields the shown records, Undo and a board or calendar were read under.
  const priorFields = useRef(table?.fields ?? []);
  const activeViewKey = JSON.stringify(selectedView ?? null);
  // A change to the fields or rules keeps the page as it is: its records, search, page, open record, new record
  // and Undo. What the change leaves stale goes, and the same records are read again in place.
  useLayoutEffect(() => {
    if (priorContract.current === contractKey) return;
    priorContract.current = contractKey;
    const before = new Map(priorFields.current.map(field => [field.fieldId, field]));
    const now = new Map((table?.fields ?? []).map(field => [field.fieldId, field]));
    const stale = staleUnder(priorFields.current, table?.fields ?? []);
    priorFields.current = table?.fields ?? [];
    sequence.current++; readActive.current?.abort(); openRecordRead.current?.abort();
    // A request sent under the old rules can't be confirmed now. Its change goes, and what the person gave stays on its cell.
    queue.rulesChanged();
    // The read stopped above can't end its own load now.
    locked.current = false; setBusy(false);
    // A value read under a field's old definition must not show under its new one, so it goes until the read below fills it in.
    const strip = (row: TransactionalRow) => withoutStale(row, stale);
    setPage(current => current && { ...current, rows: current.rows.map(strip) });
    setDetails(current => current && strip(current));
    // Undo sends its prior values with its operation, so it stays only while both still apply.
    setUndo(current => {
      const operation = current && dataset.operations.find(entry => entry.operationId === current.operation.operationId);
      if (!current || !operation) return null;
      return Object.entries(current.values).every(([fieldId, value]) => { const old = before.get(fieldId); return old !== undefined && operation.fieldIds.includes(fieldId) && !cannotTake(old, now.get(fieldId), value); }) ? { ...current, operation } : null;
    });
    if (visual) {
      const used = [shownView?.kind === "board" ? shownView.groupBy : shownView?.dateField, query.sort?.fieldId, ...(query.filters ?? []).map(filter => filter.fieldId)];
      if (used.some(fieldId => fieldId !== undefined && stale(fieldId)) || fields.some(field => before.has(field.fieldId) && stale(field.fieldId))) setVisualEpoch(value => value + 1);
      else setVisualChanged(value => value + 1);
      return;
    }
    // A page's cursor is a value of its sort field, so a change to that field starts again from the first page.
    let next = currentQuery.current;
    if (next.after && next.sort && stale(next.sort.fieldId)) { next = { ...next, after: null }; currentQuery.current = next; setQuery(next); setPrevious([]); }
    if (page === null) void load(next, []);
    else void reread(`dohc could not load ${table?.name ?? "this collection"}.`);
  }, [contractKey]);
  // A new record in the panel, with changes, when the page closes opens again once the page shows its records.
  const keptKey = JSON.stringify([workspaceId, dataset.datasetId, tableId]);
  const restoring = useRef(keptEdits.get(keptKey) ?? null);
  // The panel's new record's operation, by id in the rules now. Gone, the panel keeps what was typed but can't save it.
  const formOperation = editor && operations.find(operation => operation.operationId === editor.operation.operationId) || null;
  // A field the person has not touched shows a new record's default.
  const untouched = initialValue;
  const form: FormField[] = !editor || !table ? [] : (() => {
    const allowed = (formOperation ?? editor.operation).fieldIds;
    const current = (fieldId: string) => allowed.includes(fieldId) ? table.fields.find(field => field.fieldId === fieldId) : undefined;
    const ids = table.fields.filter(field => allowed.includes(field.fieldId)).map(field => field.fieldId);
    // A value typed into a field the rules then dropped stays in the panel until the person clears it.
    ids.push(...Object.keys(draft).filter(fieldId => !ids.includes(fieldId)));
    return ids.flatMap(fieldId => {
      const field = current(fieldId), typed = draft[fieldId];
      if (!typed) return field ? [{ field, value: untouched(field), changed: false }] : [];
      const changed = cannotTake(typed.under, field, typed.value);
      // A value emptied under a field's old definition is empty in the new one's own way, such as null for a number.
      const value = field && !changed && isEmptyValue(typed.value) && fieldShape(field) !== fieldShape(typed.under) ? emptyValue(field) : typed.value;
      return field || changed ? [{ field: field ?? typed.under, value, changed }] : [];
    });
  })();
  const typed = form.some(({ field, value, changed }) => draft[field.fieldId] !== undefined && (changed || JSON.stringify(value) !== JSON.stringify(untouched(field))));
  const keeping = useRef<KeptEdit | null>(null);
  keeping.current = editor && typed ? { editor, draft } : null;
  useEffect(() => {
    keptEdits.delete(keptKey);
    // A new record whose change is with the queue is not kept: the queue has the change, and reports how it ended.
    // One not opened again yet, because the page closed before its records showed, stays kept.
    return () => {
      const kept = keeping.current ?? restoring.current;
      // Text an editor gave up before this ran is part of what is kept. Text given up after it is added to what was kept, below.
      if (kept && awaitingRef.current === null) keptEdits.set(keptKey, { editor: kept.editor, draft: { ...kept.draft, ...leftInEditors.current } });
    };
  }, [keptKey]);
  useLayoutEffect(() => {
    const kept = restoring.current;
    if (!kept || (visual ? visualRefresh === 0 || visualBusy : page === null)) return;
    restoring.current = null;
    // Fields that changed while the page was closed flag their values, as for a change while it is open.
    setDraft(kept.draft); setInvalid({}); setEditor(kept.editor);
  }, [page, visual, visualRefresh, visualBusy]);
  useEffect(() => {
    const view = selectedView;
    setPage(null);
    setSearch(view?.search ?? "");
    void load({ after: null, search: view?.search ?? "", filters: view?.filters, sort: view?.sort ?? undefined }, []);
  }, [activeViewKey]);
  useEffect(() => {
    if (loadedVersion.current === props.recordsVersion || busy || editor || resourceBusy) return;
    loadedVersion.current = props.recordsVersion;
    void load(currentQuery.current);
  }, [props.recordsVersion, editor, resourceBusy, busy]);
  /**
   * Reads the shown page again in place: no loading line, nothing disabled,
   * and an open record stays open, with its new values. A later read
   * supersedes it, and one that fails keeps what the page shows, which
   * Refresh reads again. It never starts while a full read holds the page,
   * since superseding that one would leave the page busy.
   *
   * After a change to the fields, or to records by this page, the page's
   * last read is stale, so a failure is reported in `failure`'s words, as a
   * load's is.
   */
  async function reread(failure?: string): Promise<void> {
    if (!read || !alive.current || locked.current) return;
    readActive.current?.abort();
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current, next = currentQuery.current, shows = view.readStarted();
    try {
      const response = await invoke(request(read, pageInput(next), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded);
      settle();
      showOpenRecord(loaded.rows);
      showRead(shows, loaded.rows);
    } catch (cause) {
      // Otherwise nothing to say: the change happened elsewhere, and the page still shows its last read.
      if (failure === undefined || !alive.current || sequence.current !== mine || abort.signal.aborted) return;
      setPage(null); setDetails(null);
      failLoad(failure, cause, () => { if (alive.current) void load(next, []); });
    }
  }
  /**
   * The open record shows what a read found of it. One the read left out, as
   * a Calendar record moved to another month or a record on another page, is
   * read by its key, and one that is gone says so instead of showing its old
   * values.
   */
  function showOpenRecord(rows: readonly TransactionalRow[]): void {
    const key = openKeyRef.current;
    if (key === null) return;
    // This read is newer than a by-key read still in flight, which then changes nothing.
    openRecordRead.current?.abort();
    const found = rows.find(row => JSON.stringify(row.id) === key);
    if (!found) { void readOpenRecord(key); return; }
    setDetails(found); setDetailsUnavailable(null);
  }
  /**
   * Tells the queue the page shows a read's records, which ends the time of confirmed values on their
   * cells. An open record the read left out has no row to show them, so it takes them first, with the
   * version its receipt gave. `shows`: what the queue gave when the read started.
   */
  function showRead(shows: number, rows: readonly TransactionalRow[]): void {
    const key = openKeyRef.current;
    if (key !== null && !rows.some(row => JSON.stringify(row.id) === key)) {
      const { values, version } = view.confirmed(shows, key);
      if (version !== undefined || Object.keys(values).length > 0) {
        setDetails(last => last && JSON.stringify(last.id) === key ? { ...last, version: version ?? last.version, values: { ...last.values, ...values } } : last);
      }
    }
    view.readShown(shows, rows);
  }
  async function readOpenRecord(key: string): Promise<void> {
    if (!read || !alive.current || locked.current) return;
    const fieldId = table?.primaryKeyFieldId;
    // A key the host kept is foreign text until it reads as a record's id.
    let id: unknown;
    try { id = JSON.parse(key); } catch { id = undefined; }
    if (typeof id !== "string" && typeof id !== "number") { setDetailsUnavailable({ id: key, text: "This record is no longer in this Collection." }); return; }
    if (fieldId === undefined || !read.fieldIds.includes(fieldId)) {
      setDetailsUnavailable({ id: key, text: "This record is no longer in this view. Close it, then search for it." });
      return;
    }
    // Its own controller, so a newer read in place can stop it; the sequence, so any newer read makes it stale.
    const abort = new AbortController(); openRecordRead.current = abort;
    const mine = ++sequence.current;
    // The answer is for this page's table, by the page's own life, for this read, and for the record still open.
    const current = () => alive.current && sequence.current === mine && !abort.signal.aborted && openKeyRef.current === key;
    try {
      const response = await invoke(request(read, { limit: 1, filters: [{ fieldId, value: id }] }, crypto.randomUUID()), abort.signal);
      if (!current()) return;
      const found = parsePage(response.result, read.fieldIds).rows.find(row => JSON.stringify(row.id) === key);
      if (!found) { setDetailsUnavailable({ id: key, text: "This record is no longer in this Collection." }); return; }
      setDetails(found); setDetailsUnavailable(null);
    } catch {
      // A record the panel already shows keeps its last values, with those the Collection confirmed since:
      // the next change or Refresh reads again. One it has nothing to show of says so.
      if (current() && detailsRef.current === null) setDetailsUnavailable({ id: key, text: "dohc could not read this record. Close it, then open it again." });
    }
  }
  // The open record's panel: which record it shows, by its key, where focus goes, and what the host keeps with the tab.
  const recordPanel = useRecordPanel({
    initialOpenRecord: props.initialOpenRecord, onOpenRecordChange: props.onOpenRecordChange,
    initialRecordPanelWidth: props.initialRecordPanelWidth, onRecordPanelWidthChange: props.onRecordPanelWidthChange,
    automations: props.automations,
    onClose: () => { openRecordRead.current?.abort(); setDetails(null); setDetailsUnavailable(null); },
  });
  const { openKey, openKeyRef, automationsOpen } = recordPanel, closePanel = recordPanel.close;
  function openPanel(row: TransactionalRow): void {
    recordPanel.open(JSON.stringify(row.id), changed => {
      setDetails(row); setDetailsUnavailable(null);
      // A by-key read of the record this one replaces changes nothing now.
      if (changed) openRecordRead.current?.abort();
    });
  }
  // What changed elsewhere waits for a full read in flight to end, then shows in place. The lock is
  // read now, not from this render, since a read the effect above started in this same commit has taken it.
  useEffect(() => {
    if (changedVersion.current === props.recordsChanged || busy || visualBusy || resourceBusy || locked.current) return;
    changedVersion.current = props.recordsChanged;
    if (visual) setVisualChanged(value => value + 1);
    else void reread();
  }, [props.recordsChanged, busy, visualBusy, resourceBusy]);
  // A read the queue asked for while another read held the page, which runs once that one ends.
  const readWanted = useRef(false);
  /** The queue's changes are confirmed or refused, so the page reads its records again in place, with nothing disabled. */
  function readForQueue(): void {
    if (!alive.current) return;
    if (locked.current || visualBusy) { readWanted.current = true; return; }
    readWanted.current = false;
    if (visual) setVisualChanged(value => value + 1);
    else void reread(`dohc could not load ${table?.name ?? "this collection"}.`);
  }
  useEffect(() => { if (readWanted.current && !busy && !visualBusy) readForQueue(); }, [busy, visualBusy]);
  // The reads a board or calendar made since it last showed records. The earliest tells the queue which changes they show.
  const visualRead = useRef(Number.POSITIVE_INFINITY);

  function closeEditor(): void {
    setEditor(null); setInvalid({}); setFormRefusal(null); awaitingRef.current = null; setAwaiting(null);
    // An upload of the record that is gone holds nothing more.
    pendingResources.current.clear(); setResourceBusy(false);
  }
  // The record in the panel, as the page last had it, for text an editor gives up once the page has closed.
  const openDraft = useRef<Editor | null>(null);
  openDraft.current = editor;
  /**
   * Text still in an editor of the new record when the editor went, neither saved nor cancelled. While the page
   * is open it goes into the record as a value. Once the page has closed, as with its tab or its workspace, it
   * goes into the record the page keeps. Text its field cannot take is kept as the text, with its field, which
   * Create record then points at.
   */
  function keepDraftText(left: TableAbandonedDraft): void {
    const field = table?.fields.find(entry => entry.fieldId === left.field);
    if (!field) return;
    const value = left.value === undefined ? left.text : jsonValue(left.value) ?? left.text;
    if (alive.current) { changeDraft(field.fieldId, value); return; }
    const record = openDraft.current;
    if (!record || awaitingRef.current !== null) return;
    leftInEditors.current = { ...leftInEditors.current, [field.fieldId]: { value, under: field } };
    const kept = keptEdits.get(keptKey) ?? { editor: record, draft: draftNow.current };
    keptEdits.set(keptKey, { editor: kept.editor, draft: { ...kept.draft, ...leftInEditors.current } });
  }
  /** Gives a field of the panel's new record a value, which takes back what was wrong with the one before. */
  function changeDraft(fieldId: string, value: AppBackendJson): void {
    const field = table?.fields.find(entry => entry.fieldId === fieldId);
    if (!field) return;
    setDraft(current => ({ ...current, [fieldId]: { value, under: field } }));
    setInvalid(current => current[fieldId] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([id]) => id !== fieldId)));
  }
  function clearValue(fieldId: string): void {
    // The control that cleared the value goes with it, so the panel takes focus.
    draftPanel.current?.focus({ preventScroll: true });
    setDraft(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== fieldId)));
    setInvalid(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== fieldId)));
  }
  /** The host confirmed a change. The table shows it once a read does. */
  function confirmed(write: QueuedWrite, receipt: AppBackendJson): void {
    // Undo holds only under the rules its edit ran under.
    const current = write.request?.revision === dataset.revision && write.request.revisionSha256 === dataset.revisionSha256;
    setUndo(current ? undoFromReceipt(write, operations.find(operation => operation.operationId === write.operationId), receipt) : null);
    if (awaitingRef.current === write.id) closeEditor();
    const row = rowSave.current;
    if (row?.id !== write.id) return;
    rowSave.current = null;
    // The record exists and nothing of it is left to do, so the row goes. The page reads its records next, and
    // the table then says whether a row on screen shows the record.
    const key = receiptKey(receipt);
    row.report({ state: "saved", ...(key === null ? {} : { recordId: key }) });
  }
  /** A change went unsaved. The row or the panel that sent it stays, with what was typed, and says why. */
  function dropped(write: QueuedWrite, reason: string, refused: boolean): boolean {
    const row = rowSave.current;
    if (row?.id === write.id) {
      rowSave.current = null;
      // Only a create the Collection did not run comes back to the row for typing: one it refused, or one never
      // sent. Its request was out, whoever asked for the try, and it did not run. A row that went with its
      // table leaves the new record to the page's list.
      if (refused || !write.request) { row.report({ state: "pending" }); return row.report({ state: "refused", reason }); }
      // A create that was sent and not refused may have run, so the row never takes typing or sends again. It
      // goes, and the queue keeps what it held in the page's list, as for any change that may have run.
      row.report({ state: "dropped" });
      return false;
    }
    if (awaitingRef.current !== write.id) {
      // A new record the Collection refused, with no row or panel left to show it, opens in the panel with what was typed and why, while the panel holds no other.
      if (!refused || write.kind !== "create" || editor !== null || !create || !canCreate) return false;
      trigger.current = null; setDraft({ ...write.values }); setInvalid({}); setFormRefusal(reason); setEditor({ operation: create });
      return true;
    }
    awaitingRef.current = null; setAwaiting(null);
    setFormRefusal(reason);
    return true;
  }
  /**
   * dohc could not confirm a change. A row that sent it says so, with the queue's own Try again and Discard,
   * and takes no typing: the change may have saved. A panel that sent it closes, and the page lists the change.
   */
  function unconfirmed(write: QueuedWrite): void {
    if (awaitingRef.current === write.id) closeEditor();
    const row = rowSave.current;
    if (row?.id !== write.id) return;
    const doubt: TableNewRecordStatus = { state: "unconfirmed", reason: unconfirmedWords(write),
      // Try again sends the same request, with the same key. An offline copy sends nothing, so the row is in doubt still.
      retry: () => { queue.retry(write.id); if (queue.find(write.id)?.state === "unconfirmed") row.report(doubt); },
      // The change may have saved, so the queue keeps what it held, and the page lists it.
      discard: () => { rowSave.current = null; queue.discard(write.id); },
      // The row went with its table. The queue still has the change, and the page's list shows it.
      released: () => { if (rowSave.current?.id === write.id) rowSave.current = null; } };
    if (!row.report(doubt)) rowSave.current = null;
  }
  /**
   * Saves the table's new row: one create with every value typed in it, and
   * a new record's default in each field left alone. A value that stops the
   * save goes back to its cell, and nothing is sent.
   */
  const saveRow = useRef<TableNewRecord["save"]>(() => undefined);
  saveRow.current = (values, report) => {
    const refuse = (reason: string) => {
      if (report({ state: "refused", reason })) return;
      // The row went with its table, so a notice keeps what it held.
      const typed = Object.entries(values).map(([fieldId, value]) => `${knownFields.current.get(fieldId)?.name ?? fieldId}: ${display(jsonValue(value))}`).join(", ");
      const message = `dohc did not create a record in ${table?.name ?? "this Collection"}. ${reason} You typed: ${typed}`;
      onError(message, new TextNotSavedError(message, typed), null);
    };
    if (!create || !table) return refuse(RULES_DISALLOW);
    // A value in a field the create does not take is never sent. It goes to a notice, so it is not dropped in silence.
    const stray = Object.entries(values).filter(([fieldId, value]) => !create.fieldIds.includes(fieldId) && !isEmptyValue(jsonValue(value) ?? null));
    if (stray.length > 0) {
      const kept = stray.map(([fieldId, value]) => `${knownFields.current.get(fieldId)?.name ?? fieldId}: ${display(jsonValue(value))}`).join(", ");
      const message = `dohc did not save part of the new record, because a new record in ${table.name} no longer takes it. You typed: ${kept}`;
      onError(message, new TextNotSavedError(message, kept), null);
    }
    const typed: Record<string, Typed> = {};
    for (const field of createFields) {
      // The row's cells show each field's default, so what they hold is what is sent: a default left alone, and an
      // explicit empty value where the person cleared one. A field the row does not show takes its default.
      const given = Object.hasOwn(values, field.fieldId) ? jsonValue(values[field.fieldId] ?? null) : initialValue(field);
      const problem = given === undefined ? `Enter a value ${field.name} can take.` : inputProblem(field, given);
      if (given === undefined || problem !== null) {
        if (!report({ state: "invalid", field: field.fieldId, reason: problem ?? "" })) refuse(problem ?? "");
        return;
      }
      typed[field.fieldId] = { value: given, under: field };
    }
    // The row waits from before the change is queued, since the queue can answer as it takes the change.
    rowSave.current = { id: queue.nextWrite, report };
    queue.enqueue({ kind: "create", record: null, operationId: create.operationId, values: typed, label: "Created a record" }, view);
  };
  function submitEditor(): void {
    // The panel's own change is with the host until it answers.
    if (!editor || awaitingRef.current !== null) return;
    if (!formOperation) return;
    // An editor that holds a value it has not saved keeps the panel and takes focus, as in the table.
    const unsaved = draftPanel.current?.querySelector<HTMLElement>("[data-cell-editor] [data-unsaved]");
    if (unsaved) return unsaved.focus();
    // A value its field can no longer take is never sent: Create record points at the first one instead.
    if (form.some(entry => entry.changed)) { focusInvalid.current = true; setInvalid(current => ({ ...current })); return; }
    const problems = form.flatMap(({ field, value }) => { const problem = inputProblem(field, value); return problem ? [[field.fieldId, problem] as const] : []; });
    if (problems.length > 0) { focusInvalid.current = true; setInvalid(Object.fromEntries(problems)); return; }
    setFormRefusal(null);
    const values: Record<string, Typed> = Object.fromEntries(form.map(({ field, value }) => [field.fieldId, { value, under: field }]));
    // The panel waits from before the change is queued, since the queue can answer as it takes the change.
    awaitingRef.current = queue.nextWrite; setAwaiting(queue.nextWrite);
    queue.enqueue({ kind: "create", record: null, operationId: formOperation.operationId, values, label: "Created a record" }, view);
  }
  // One confirmation at a time: a second press while the shell asks does nothing.
  const asking = useRef(false);
  async function deleteRecord(row: TransactionalRow): Promise<void> {
    if (!remove || !confirmDelete || asking.current) return;
    asking.current = true;
    try {
      const confirmed = await confirmDelete(row);
      if (!alive.current || !confirmed) return;
      // The record's row goes with it, so focus goes to the table.
      if (openKeyRef.current === JSON.stringify(row.id)) closePanel("table");
      // The deletion follows the record's changes still queued, at the version they leave it.
      queue.enqueue({ kind: "delete", record: row, name: recordName(row, fields), operationId: remove.operationId, label: "Deleted the record" }, view);
    } catch (cause) { if (alive.current) onError("dohc could not confirm deletion.", cause, null); }
    finally { asking.current = false; }
  }
  function undoLast(): void {
    if (!undo || !table) return;
    const values: Record<string, Typed> = {};
    for (const [fieldId, value] of Object.entries(undo.values)) { const field = table.fields.find(entry => entry.fieldId === fieldId); if (field) values[fieldId] = { value, under: field }; }
    queue.enqueue({ kind: "edit", undo: true, record: { id: undo.id, version: undo.version }, operationId: undo.operation.operationId, values, label: "Reversed the last edit" }, view);
  }
  // The panel's new record's change, while its host has not answered.
  const sent = awaiting === null ? undefined : queue.find(awaiting);
  // A full read, a view opening, or an upload holds the page's own controls. A change waiting to be confirmed never does.
  const disabled = busy || visualBusy || resourceBusy;
  // The new record's fields wait for a read, and while its change is with the host. An upload does not hold them,
  // so the file's own editor can still stop it.
  const draftLocked = busy || visualBusy || sent !== undefined;
  // Its buttons wait for an upload too: Create record would go without the file, and Cancel would drop it.
  const formDisabled = draftLocked || resourceBusy;
  // Records that could not load take no changes until a read shows them; Search and Refresh still read again.
  const writeDisabled = disabled || failure !== null;
  // A new record that leaves the panel returns focus to its opener once that is enabled again, unless the person has moved on.
  const returningFocus = useRef(false);
  useLayoutEffect(() => {
    if (editor) { returningFocus.current = true; return; }
    if (!returningFocus.current) return;
    const target = trigger.current?.isConnected ? trigger.current : null;
    if (target?.matches(":disabled")) return;
    returningFocus.current = false;
    if (document.activeElement === null || document.activeElement === document.body) target?.focus();
  }, [editor, writeDisabled]);
  // Pressing Create record with a wrong field moves focus to the first one.
  useLayoutEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    draftPanel.current?.querySelector<HTMLElement>('[data-invalid] [data-property-value] button, [data-invalid] [data-property-value] input, [aria-invalid="true"]')?.focus();
  }, [invalid]);

  // The table. Its schema and records key fields by id, and each record's row stays here, by the record's id,
  // so a version or a value as read never enters the shared table. Everything the table gets keeps its
  // identity until the fields, the rules or the records change, so a queued change builds no column again.
  const buttonNames = props.buttons?.fields ?? NO_BUTTONS;
  const fieldKey = JSON.stringify(fields), buttonKey = JSON.stringify(buttonNames);
  const schema = useMemo(() => tableSchema(fields, buttonNames), [fieldKey, buttonKey]);
  const { records, rows } = useMemo(() => tableRecords(page?.rows ?? [], fields), [page, fieldKey]);
  const editableIds = fields.filter(field => editOperation(field.fieldId) !== undefined && canInput(field)).map(field => field.fieldId);
  const editableKey = JSON.stringify(editableIds);
  const live = useRef<Live | null>(null);
  const names = useMemo(() => {
    const labels = new Map<string, string>([...fields.map(field => [field.fieldId, field.name] as const), ...buttonNames.map(name => [buttonColumn(name), name] as const)]);
    const sortable = new Set(fields.filter(supportsSort).map(field => field.fieldId));
    return { fieldLabel: (key: string) => labels.get(key) ?? key, canSortField: (field: FieldDefinition) => sortable.has(field.name) };
  }, [fieldKey, buttonKey]);
  // The page asks again when it sends, since the rules can change while an editor is open.
  const canEditCell = useMemo(() => {
    const editable = new Set(editableIds);
    return (_record: CollectionRecord, field: FieldDefinition) => editable.has(field.name);
  }, [editableKey]);
  const tableMarks = useMemo(() => new Map(fields.flatMap((field): Array<[string, TableFieldMark]> => {
    const automations = props.fieldMarks?.get(field.name);
    return automations ? [[field.fieldId, { icon: <AutomationFieldIcon />, label: automationFieldMarkLabel(automations) }]] : [];
  })), [props.fieldMarks, fieldKey]);
  const sort = useMemo((): CollectionQuerySort[] => query.sort ? [{ field: query.sort.fieldId, direction: query.sort.direction }] : [], [query.sort?.fieldId, query.sort?.direction]);
  /**
   * A change to one cell, from the table's editors or the page's own. The
   * table asked before it opened the editor, so the page asks again here.
   * What it can't send stays on the cell with why.
   */
  const commitCell = useCallback((recordKey: string, fieldId: string, value: AppBackendJson | undefined): number => {
    const now = live.current, row = now?.rows.get(recordKey), field = now?.fields.find(entry => entry.fieldId === fieldId);
    // A record that does not exist yet keeps the value, which its create sends.
    if (now && recordKey === NEW_RECORD) { now.changeDraft(fieldId, value ?? null); return queue.skip(); }
    if (!now || !row || !field) return queue.skip();
    const shown = view.statuses.get(recordKey, fieldId), refused = shown?.state === "refused";
    const current = shown && !refused ? shown.value as AppBackendJson : row.values[fieldId] ?? null;
    // The same value saves nothing, and takes back a value dohc did not save.
    if (value !== undefined && sameValue(value, current)) { if (refused) queue.dismiss(recordKey, fieldId); return queue.skip(); }
    const operation = now.editOperation(fieldId);
    if (!operation || !now.editable.has(fieldId)) return queue.hold(row, field, value ?? null, RULES_DISALLOW);
    if (value === undefined) return queue.hold(row, field, null, `Enter a value ${field.name} can take.`);
    const problem = inputProblem(field, value);
    if (problem !== null) return queue.hold(row, field, value, problem);
    return queue.enqueue({ kind: "edit", record: row, operationId: operation.operationId, values: { [fieldId]: { value, under: field } }, label: "Saved the edit" }, view);
  }, [queue, view]);
  const changeCell = useCallback((change: CollectionCellChange) => commitCell(change.recordId, change.field, jsonValue(change.value)), [commitCell]);
  // Each field's definition as the page last had it, so text typed under a field that is gone keeps its name.
  const knownFields = useRef(new Map<string, TransactionalField>());
  for (const field of table?.fields ?? []) knownFields.current.set(field.fieldId, field);
  /**
   * Text typed in a cell whose editor went with its record, its field, or the
   * page, before it was saved. It stays on its cell, or in the page's list
   * once the cell is gone, and is never sent until the person saves it.
   */
  const keepDraft = useCallback((draft: TableAbandonedDraft) => {
    const field = knownFields.current.get(draft.field), row = live.current?.rows.get(draft.recordId);
    if (!field) return;
    const shown = view.statuses.get(draft.recordId, draft.field);
    // Text the cell shows already is no change to keep.
    if (row && draft.text === display(shown ? shown.value as AppBackendJson : row.values[draft.field])) return;
    queue.hold({ id: JSON.parse(draft.recordId) as string | number }, field, draft.text, EDIT_LEFT_OPEN);
  }, [queue, view]);
  const sortTable = useCallback((next: CollectionQuerySort[]) => {
    const now = live.current, by = next[0];
    if (!now || now.held) return;
    void now.load({ ...now.query, after: null, sort: by ? { fieldId: by.field, direction: by.direction } : undefined }, []);
  }, []);
  const openRecord = useCallback((record: CollectionRecord) => {
    const now = live.current, row = now?.rows.get(record.id);
    if (now && row && !now.held) now.openRecord(row);
  }, []);
  const newRecord = useCallback(() => {
    const now = live.current;
    if (now && !now.held) now.openCreate(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, []);
  // The table's new row, where every field the create operation needs can be typed in a cell: a required field
  // the table does not show, or one with no cell editor, takes the new record to the panel instead.
  const shownIds = new Set(fields.map(field => field.fieldId));
  const rowTakes = (field: TransactionalField) => shownIds.has(field.fieldId) && supportsInput(field);
  const needsPanel = createFields.some(field => field.required && isEmptyValue(initialValue(field)) && !rowTakes(field));
  const creatableIds = createFields.filter(rowTakes).map(field => field.fieldId);
  // What a new record starts with in the fields the row shows, which the row's cells show too.
  const rowDefaults = Object.fromEntries(createFields.filter(field => rowTakes(field) && field.default !== undefined && field.default !== null).map(field => [field.fieldId, field.default as CollectionValue]));
  const creatableKey = JSON.stringify([creatableIds, rowDefaults]);
  // What starts the table's new row, while a table shows.
  const startRow = useRef<(() => void) | null>(null);
  // Built again only when the fields a new record takes change, so a queued change builds nothing in the table.
  const tableNewRecord = useMemo((): TableNewRecord => {
    const takes = new Set(creatableIds);
    return {
      canEdit: field => takes.has(field.name),
      defaults: rowDefaults,
      onOutOfView: () => live.current?.outOfView(),
      bind: start => { startRow.current = start; return () => { if (startRow.current === start) startRow.current = null; }; },
      save: (values, report) => saveRow.current(values, report),
      // What the row held and did not save is kept in a notice, with all of it in its details. Nothing is created.
      onUnsaved: row => {
        const named = (fieldId: string) => knownFields.current.get(fieldId)?.name ?? "removed";
        const typed = [...Object.entries(row.values).map(([fieldId, value]) => `${named(fieldId)}: ${display(jsonValue(value))}`), ...(row.text ? [`${named(row.text.field)}: ${row.text.text}`] : [])].join(", ");
        const field = named(Object.keys(row.values)[0] ?? "");
        const message = row.why === "field"
          ? `dohc did not save what you typed in the ${field} field of the new record. The field changed, or a new record no longer takes it. You typed: ${typed}`
          : `dohc did not create a record in ${live.current?.tableName ?? "this Collection"}. Enter a value ${named(row.text?.field ?? "")} can take. You typed: ${typed}`;
        live.current?.onError(message, new TextNotSavedError(message, typed), null);
        return row.why === "field" ? `${field} changed, or a new record no longer takes it, so its value left this row. A notice has what you typed.` : undefined;
      },
    };
  }, [creatableKey]);
  const nameRecord = useCallback((record: CollectionRecord) => {
    const now = live.current, row = now?.rows.get(record.id);
    return now && row ? recordName(row, now.fields) : `record ${record.path}`;
  }, []);
  const buttons = props.buttons;
  const renderButton = useMemo(() => buttons && ((field: FieldDefinition, record: CollectionRecord) => {
    const row = live.current?.rows.get(record.id);
    return row ? buttons.render(buttonField(field.name), row) : null;
  }), [buttons]);
  // A file or a relation is not a kind of value the table knows, so the page draws its cell and its editor.
  // Neither ever opens the table's text editor.
  const resourceKey = JSON.stringify([editableKey, offline, props.uploadFile !== undefined, props.readFile !== undefined, props.resolveRelation !== undefined, read?.operationId, dataset.revision, dataset.revisionSha256]);
  const resourceCells = (of: readonly TransactionalField[]) => new Map(of.filter(field => field.type === "attachment" || field.type === "relation").map((field): [string, TableHostCell] => [field.fieldId, {
    cell: (record, tabStop) => {
      const now = live.current;
      if (!now) return null;
      // A record that does not exist yet has no file to download, and takes a value in each field its create does.
      const unmade = record.id === NEW_RECORD;
      const status = view.statuses.get(record.id, field.fieldId);
      const value = status ? status.value as AppBackendJson : now.rows.get(record.id)?.values[field.fieldId];
      const readFile = now.resources.readFile;
      return <ResourceCell scope={now.scope} field={field} value={value} unconfirmed={status !== undefined || unmade} editable={unmade || now.editable.has(field.fieldId)} offline={now.offline} tabStop={tabStop} onError={now.onError}
        download={readFile && typeof value === "string" ? (request, signal) => readFile({ ...request, read: { operationId: now.read.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value }] } } }, signal) : undefined} />;
    },
    editor: canInput(field) ? (record, close) => {
      const now = live.current;
      if (!now) return null;
      const status = view.statuses.get(record.id, field.fieldId);
      const initial = status ? status.value as AppBackendJson : now.rows.get(record.id)?.values[field.fieldId] ?? emptyValue(field);
      // A new definition, such as another related table, gets a new editor with nothing it found under the old one.
      return <ResourceCellEditor key={fieldShape(field)} scope={now.scope} field={field} initial={initial} upload={now.resources.uploadFile} resolve={now.resources.resolveRelation} onError={now.onError}
        onBusy={record.id === NEW_RECORD ? busy => live.current?.uploading(field.fieldId, busy) : undefined}
        onSave={value => { commitCell(record.id, field.fieldId, value); }} onClose={close} />;
    } : undefined,
  }]));
  const hostCells = useMemo(() => resourceCells(fields), [fieldKey, resourceKey]);
  const createKey = JSON.stringify(createFields);
  const draftHostCells = useMemo(() => resourceCells(createFields), [createKey, resourceKey]);
  // The panel shows the open record's fields as the table shows them, by the same schema, without the Button columns:
  // the record's buttons stand in one row above its fields. The record's name is the panel's heading, not a row.
  const panelSchema = useMemo(() => visualSchema(fields), [fieldKey]);
  const panelRecord = useMemo(() => details && visualRecord(details, fields), [details, fieldKey]);
  const nameFieldId = fields.find(field => field.type === "text")?.fieldId;
  const nameOmitted = useMemo(() => nameFieldId === undefined ? [] : [nameFieldId], [nameFieldId]);

  if (!table || !read) return <section aria-label="Collection" className="p-4 text-sm text-muted">This collection is unavailable. Ask its owner for access.</section>;
  // Why the panel's new record can't be made, or why its buttons wait, over them.
  const formBlocked = editor && !formOperation ? offline ? SAVE_OFFLINE : CHANGE_GONE : null;
  const formProblem = formBlocked === SAVE_OFFLINE ? null : formBlocked ?? formRefusal;
  const formNote = formProblem !== null ? <FieldError id={`${errorIds}-form`}>{formProblem}</FieldError>
    : formBlocked !== null ? <p className="m-0 text-[12px] text-muted">{formBlocked}</p>
    : resourceBusy ? <p role="status" className="m-0 text-[12px] text-muted">{FILE_UPLOADING}</p> : null;
  /** Opens a new record in the panel, in place of the record or the automations it shows. `filled`: values it starts with, as a board column's. */
  const openCreate = (opener: HTMLElement | null, filled: Record<string, Typed> = {}) => {
    if (!create) return;
    const show = () => { trigger.current = opener; setDraft(filled); setInvalid({}); setFormRefusal(null); setEditor({ operation: create }); };
    if (openKeyRef.current !== null) closePanel("none");
    // One side panel shows at a time. Automations closes first, and keeps its place if the person keeps a draft there.
    if (props.automations?.open) props.automations.close(show); else show();
  };
  // A record open from a board, a calendar or another page of records is not among the table's, and its fields change the same way.
  // The new record in the panel is no row either: its values are what the person gave it, and a new record's defaults.
  const liveRows = new Map(rows);
  if (openKey !== null && details !== null && !rows.has(openKey)) liveRows.set(openKey, details);
  if (editor) liveRows.set(NEW_RECORD, { id: NEW_RECORD, version: 0, values: Object.fromEntries(form.map(entry => [entry.field.fieldId, entry.value])) });
  live.current = { rows: liveRows, openRecord: openPanel, fields, editable: new Set(editableIds), editOperation, held: disabled || editor !== null, query, load, openCreate, scope, offline, read,
    creatable: new Set(creatableIds), changeDraft, tableName: table.name, uploading,
    outOfView: () => props.onNotice?.("Created a record. It is not among the records on screen."), resources: { uploadFile: props.uploadFile, readFile: props.readFile, resolveRelation: props.resolveRelation }, onError };
  // The table's new row shows its own change while a table shows that takes one. Without it, the page's list does.
  const rowHosted = !visual && page !== null && canCreate === true && !needsPanel;
  if (!rowHosted) rowSave.current = null;
  const rowWrite = rowSave.current?.id;
  // What needs the person and has no cell to say so: on a board or calendar, on another page of records, or in a
  // field the table no longer shows or changes.
  const inCell = (recordKey: string, fieldId: string) => fields.some(field => field.fieldId === fieldId) &&
    ((!visual && page !== null && rows.has(recordKey)) || (recordKey === openKey && details !== null && failure === null && !automationsOpen));
  // A cell shows a change's own state only while no later change to the cell shows over it, so a cell that
  // can't offer the change's Try again leaves it to the list.
  const cellShows = (write: QueuedWrite, state: "unconfirmed" | "waiting") => write.record !== null &&
    Object.keys(write.values).some(fieldId => inCell(write.record!.key, fieldId) && view.statuses.get(write.record!.key, fieldId)?.state === state);
  const unshown = queue.attention().filter(item => item.kind === "unconfirmed" || item.kind === "waiting" ? item.write.id !== awaiting && item.write.id !== rowWrite && !cellShows(item.write, item.kind)
    : item.kind !== "held" || !(inCell(item.recordKey, item.fieldId) && editableIds.includes(item.fieldId)));
  const problem = (entry: FormField) => entry.changed ? VALUE_CHANGED : invalid[entry.field.fieldId];
  const errorId = (entry: FormField) => problem(entry) === undefined ? undefined : `${errorIds}-${encodeURIComponent(entry.field.fieldId)}`;
  const fieldError = (entry: FormField) => problem(entry) === undefined ? null : <FieldError id={errorId(entry)!}>{problem(entry)}</FieldError>;
  // A value its field can no longer take: read-only, with a copy of it and the control that clears it.
  const changedValue = (entry: FormField) => <div key={entry.field.fieldId} data-field={entry.field.fieldId} className="flex flex-col gap-1 pt-2 text-[12px] text-muted">
    <span>{entry.field.name}</span>
    <ChangedValue name={entry.field.name} value={entry.value} disabled={formDisabled} describedBy={errorId(entry)} onClear={() => clearValue(entry.field.fieldId)} />
    {fieldError(entry)}
  </div>;
  const canCreateForm = props.onCreateForm && operations.some(operation => operation.kind === "create" && operation.access === "link" && !operation.readOnly);
  const savedPages = props.copy && "coverage" in props.copy && props.copy.coverage === "saved-pages";
  // The page's own controls wait for a read or a new record open in the panel. A menu row says why.
  const paused = disabled || editor !== null;
  const why = (needsRecords = false) => editor !== null ? NEW_RECORD_OPEN : disabled ? RECORDS_LOADING : needsRecords && failure !== null ? RECORDS_FAILED : undefined;
  const icon = (Icon: typeof Archive) => <Icon size={14} strokeWidth={1.9} aria-hidden />;
  // The tabs. Someone who can save views gets All records and each saved view. Anyone else gets the three
  // layouts, which change what this computer shows and save nothing.
  const saved = props.views;
  const groupable = fields.filter(supportsSort);
  const tabs: readonly CollectionFrameTab[] = saved
    ? [{ id: ALL_RECORDS, name: "All records", kind: "table" }, ...saved.list.map((view): CollectionFrameTab => ({ id: view.viewId, name: view.name, kind: view.kind, saved: true }))]
    : LAYOUT_TABS.filter(tab => tab.kind !== "board" || groupable.length > 0);
  const showLayout = (kind: CollectionTableView["kind"]) => setLocalView({ viewId: "local", name: "Current view", search: query.search, filters: query.filters ?? [], sort: query.sort ?? null, kind,
    ...(kind === "board" ? { groupBy: fields.find(field => field.type === "select")?.fieldId ?? groupable[0]?.fieldId } : {}),
    ...(kind === "calendar" ? { dateField: dateFields[0]?.fieldId } : {}) });
  const frameViews: CollectionFrameViews | undefined = saved && {
    groupFields: groupable.map(field => ({ id: field.fieldId, name: field.name })),
    dateFields: dateFields.map(field => ({ id: field.fieldId, name: field.name })),
    onAddDateField: props.onAddDateField,
    nameMaxLength: 100,
    create: saved.create, rename: saved.rename, remove: saved.remove, onEdit: saved.edit,
    // A deleted view comes back from its notice's Undo.
    confirmDelete: false,
  };
  // A saved view keeps the field its board groups by and its calendar's date field. A layout that is not saved changes here only.
  const changeViewField = (field: { groupBy: string } | { dateField: string }) => {
    if (!shownView) return;
    if (saved && localView === null && props.activeView?.viewId === shownView.viewId) saved.setField(shownView.viewId, field);
    else setLocalView({ ...shownView, ...field });
  };
  const viewField: CollectionFrameViewField | undefined = shownView?.kind === "board"
    ? { label: "Group board by", prefix: "Group by", value: shownView.groupBy, options: groupable.map(field => ({ id: field.fieldId, name: field.name })), onChange: groupBy => changeViewField({ groupBy }) }
    : shownView?.kind === "calendar" && shownView.dateField
      ? { label: "Calendar date", prefix: "Date", value: shownView.dateField, options: dateFields.map(field => ({ id: field.fieldId, name: field.name })), onChange: dateField => changeViewField({ dateField }) }
      : undefined;
  const shownRecords = !visual && page ? page.rows.length : null;
  // The open record, in the panel. It shows no key and no version: the record's name is its heading.
  const nameField = fields.find(field => field.fieldId === nameFieldId);
  const shownPanel = (() => {
    // Records that could not load show no record, and the ⚡ panel has the side panel's place while it is open.
    if (openKey === null || failure !== null || automationsOpen) return null;
    const unavailable = detailsUnavailable?.id === openKey ? detailsUnavailable.text : undefined;
    const nameStatus = nameField && view.statuses.get(openKey, nameField.fieldId);
    // The name as its cell shows it: what the person gave, until the host confirms it. A record with no name
    // says so in its heading. Only the panel's accessible name falls back to what the table's Open control calls it.
    const nameText = !details ? undefined : nameField ? display(nameStatus ? nameStatus.value as AppBackendJson : details.values[nameField.fieldId]) : "";
    // An offline copy lists no action, as it takes no change.
    const recordActions = onCustomAction && !offline ? operations.filter(operation => operation.kind === "action") : [];
    const commands: RecordPanelCommand[] = details && remove && confirmDelete
      ? [{ id: "delete", label: "Delete record…", icon: icon(Trash2), danger: true, disabled, reason: RECORDS_LOADING, onSelect: () => { void deleteRecord(details); } }] : [];
    // The name opens only where a cell of its field would. An open name stays with its record and its field,
    // and saves as a cell does: the page asks the rules again, and keeps what they refuse.
    return <RecordPanel key={openKey} panelRef={recordPanel.element} collectionName={table.name}
      name={nameText || (details ? recordName(details, fields) : "")} nameText={nameText} nameLabel={nameField?.name}
      nameField={nameField?.fieldId} canRename={nameField !== undefined && !offline && editableIds.includes(nameField.fieldId)}
      onNameChange={nameField && (value => { commitCell(openKey, nameField.fieldId, value === "" ? null : value); })}
      onNameAbandoned={nameField && (text => keepDraft({ recordId: openKey, field: nameField.fieldId, text }))}
      nameNote={nameField ? <CellStatusNote statuses={view.statuses} recordId={openKey} field={nameField.fieldId} /> : undefined}
      loading={details === null && unavailable === undefined} unavailable={unavailable} commands={commands}
      width={recordPanel.width} onWidthChange={recordPanel.setWidth} onClose={() => closePanel("opener")}
      properties={details && panelRecord ? <>
        {props.buttons?.fields.length ? <div data-testid="record-buttons" className="flex flex-wrap items-center gap-2 pb-3">{props.buttons.fields.map(field => <Fragment key={field}>{props.buttons!.render(field, details)}</Fragment>)}</div> : null}
        <RecordProperties schema={panelSchema} record={panelRecord} omitFields={nameOmitted} fieldLabel={names.fieldLabel} fieldMarks={tableMarks}
          onCellChange={changeCell} onDraftAbandoned={keepDraft} editingDisabled={offline} canEditCell={canEditCell} cellStatuses={view.statuses}
          acknowledgedWriteId={view.acknowledged} subscribeToDiscardedWrites={queue.subscribeToDiscarded} hostCells={hostCells} />
        {recordActions.length ? <div className="mt-4 flex flex-col gap-2"><p className="m-0 text-[12px] text-muted">Open an action to review its inputs before running it.</p>
          <div className="flex flex-wrap gap-2">{recordActions.map(operation => <SecondaryButton key={operation.operationId} disabled={disabled} onClick={() => onCustomAction?.(operation.operationId)}>Open {operation.label}</SecondaryButton>)}</div></div> : null}
      </> : undefined}
      footer={offline ? "Offline copy · Read-only" : editableIds.length === 0 && recordActions.length === 0 ? "No edit action is available for this record." : undefined} />;
  })();
  // A new record in the panel, before it exists: one row per field its create takes, with the table's own editors.
  // It has no buttons, actions or file to download yet. Cancel, Close and Escape let it go.
  const draftShown = form.filter(entry => !entry.changed);
  const draftRecord: CollectionRecord = { id: NEW_RECORD, path: "", conflicted: false,
    values: draftShown.map(({ field, value }) => ({ field: field.fieldId, value: value as CollectionValue, validation: { status: "valid" }, resolvedRelations: [] })) };
  const cancelDraft = () => { if (!formDisabled) closeEditor(); };
  const draftPanelNode = editor ? <RecordPanel key={NEW_RECORD} panelRef={draftPanel} collectionName={table.name} name="New record"
    width={recordPanel.width} onWidthChange={recordPanel.setWidth} onClose={cancelDraft}
    properties={<>
      <RecordProperties schema={visualSchema(draftShown.map(entry => entry.field))} record={draftRecord} fieldLabel={fieldId => knownFields.current.get(fieldId)?.name ?? fieldId}
        onCellChange={change => { changeDraft(change.field, jsonValue(change.value) ?? null); return queue.skip(); }} onDraftAbandoned={keepDraftText}
        editingDisabled={draftLocked || !formOperation} acknowledgedWriteId={view.acknowledged} hostCells={draftHostCells} problems={new Map(Object.entries(invalid))} />
      {form.filter(entry => entry.changed).map(changedValue)}
    </>}
    actions={<>
      {formNote}
      <div className="flex flex-wrap justify-end gap-2"><SecondaryButton disabled={formDisabled} onClick={cancelDraft}>Cancel</SecondaryButton><PrimaryButton disabled={formDisabled || !formOperation} onClick={submitEditor}>{sent ? "Saving…" : "Create record"}</PrimaryButton></div>
    </>} /> : null;
  return <CollectionFrame name={table.name} aria-busy={busy}
    onKeyDown={recordPanel.onPageKeyDown}
    // A count of this page's records. It says so when the Collection holds more pages.
    count={shownRecords === null ? undefined : `${shownRecords} ${shownRecords === 1 ? "record" : "records"}${previous.length > 0 || (page?.nextCursor ?? null) !== null ? " on this page" : ""}`}
    status={props.copy ? <span role="status" className="truncate text-[12px] text-muted">{savedPages ? "Offline · Saved pages only" : props.copy.offline ? `Offline copy · Read-only${props.copy.host ? ` until ${props.copy.host} is reachable` : ""}`
      : `${props.copy.host ? `On ${props.copy.host} · ` : ""}Saved on this device`} · {new Date(props.copy.savedAtMs).toLocaleString()}</span> : undefined}
    tabs={tabs} activeTabId={saved ? props.activeView?.viewId ?? ALL_RECORDS : selectedView?.kind ?? "table"}
    onSelectTab={tabId => { if (saved) saved.select(tabId === ALL_RECORDS ? null : tabId); else showLayout(tabId as CollectionTableView["kind"]); }}
    tabsDisabled={paused || saved?.busy === true} views={frameViews} viewField={viewField}
    search={{ value: search, onChange: setSearch, disabled: paused, onSubmit: () => void load({ ...query, after: null, search }, []) }}
    actions={[
      ...(undo && !offline ? [{ id: "undo", label: "Undo last edit", icon: icon(Undo2), disabled: writeDisabled || queue.size > 0, onClick: undoLast }] : []),
      ...(onCustomAction ? operations.filter(operation => operation.kind === "action").map(operation => ({ id: operation.operationId, label: operation.label, disabled: writeDisabled, onClick: () => onCustomAction(operation.operationId) })) : []),
    ]}
    automations={props.automations}
    // In a table that takes a new row, the button starts it. Elsewhere the new record opens in the panel.
    newRecord={canCreate ? { disabled: writeDisabled || editor !== null, onClick: opener => { if (rowHosted) startRow.current?.(); else openCreate(opener); } } : undefined}
    menuLabel="Manage Collection"
    menu={[
      { label: "View", commands: [
        props.onReviewSchema && { id: "fields", label: "Fields and names", icon: icon(LayoutList), disabled: writeDisabled || editor !== null, reason: why(true), onSelect: props.onReviewSchema },
        saved && { id: "views", label: "Views", icon: icon(PanelsTopLeft), disabled: paused || saved.busy, reason: why() ?? "dohc is reading the saved views.", onSelect: saved.manage },
        { id: "refresh", label: "Refresh", icon: icon(RefreshCw), disabled: paused, reason: why(), onSelect: () => props.onRefresh ? props.onRefresh() : void load(query) },
      ] },
      { label: "Collection", commands: [
        props.automations && { id: "automations", label: "Automations", icon: icon(Zap), count: props.automations.count, onSelect: props.automations.onToggle },
        props.onCustomize && { id: "customize", label: "Customize…", icon: icon(SlidersHorizontal), disabled: paused, reason: why(), onSelect: props.onCustomize },
        canCreateForm && props.onCreateForm && { id: "form", label: "Create form", icon: icon(FileInput), disabled: writeDisabled || editor !== null, reason: why(true), onSelect: props.onCreateForm },
        props.onManageAccess && { id: "access", label: "Manage access", icon: icon(Shield), disabled: paused, reason: why(), onSelect: props.onManageAccess },
        props.onTransferCsv && { id: "csv", label: "Import or export CSV", icon: icon(FileSpreadsheet), disabled: writeDisabled || editor !== null, reason: why(true), onSelect: props.onTransferCsv },
        props.onHistory && { id: "history", label: "History", icon: icon(History), disabled: paused, reason: why(), onSelect: props.onHistory },
        props.onPendingResponses && { id: "pending", label: "Pending responses", icon: icon(Inbox), disabled: paused, reason: why(), onSelect: props.onPendingResponses },
        props.onExportRecovery && { id: "recovery", label: "Export recovery", icon: icon(Download), disabled: paused, reason: why(), onSelect: props.onExportRecovery },
        props.onOpenSource && { id: "source", label: "Open source", icon: icon(FileCode), onSelect: props.onOpenSource },
        props.onArchive && { id: "archive", label: "Archive", icon: icon(Archive), disabled: paused, reason: why(), onSelect: props.onArchive },
      ] },
    ]}
    panel={draftPanelNode ?? shownPanel ?? props.panel}
  // The table starts at the tabs' line, as a document Collection's does. What stands above or in place of it keeps 12px under the tabs.
  ><div className="flex min-h-0 flex-1 flex-col gap-3">
    {unshown.length > 0 ? <div className="shrink-0 px-5 pt-3"><UnshownChanges items={unshown} onRetry={id => queue.retry(id)} onDiscard={id => queue.discard(id)} onClear={(recordKey, fieldId) => queue.dismiss(recordKey, fieldId)} onClearRecord={id => queue.dismissRecord(id)} onDismissDeletion={id => queue.dismissDeletion(id)} /></div> : null}
    {/* Lines stand in only for records not yet shown; a page already shown keeps its records and says it is loading. */}
    {busy ? page ? <p role="status" className="m-0 px-5 text-[12px] text-muted first:pt-3">Loading records…</p> : <SkeletonRows label="Loading records…" className="first:mt-3" /> : null}
    {visual && shownView?.kind === "calendar" && !shownView.dateField ? <CalendarNeedsDateField disabled={writeDisabled || editor !== null} onAddDateField={props.onAddDateField} />
    : visual && shownView ? <div className="flex min-h-0 flex-1 flex-col px-5 pb-3 first:pt-3"><Suspense fallback={<SkeletonRows label="Opening view…" />}><TransactionalCollectionViews key={JSON.stringify([activeViewKey,query.search,visualEpoch])} view={shownView} fields={fields} search={query.search} refresh={visualRefresh} changed={visualChanged} rules={contractKey}
      onReadInPlace={rows => { const shows = Number.isFinite(visualRead.current) ? visualRead.current : -1; visualRead.current = Number.POSITIVE_INFINITY; showOpenRecord(rows); showRead(shows, rows); }}
      disabled={busy || resourceBusy || editor !== null} onBusy={setVisualBusy} onError={failLoad} onLoaded={settle}
      read={(input,signal)=>{ visualRead.current = Math.min(visualRead.current, view.readStarted()); return invoke(request(read,input,crypto.randomUUID()),signal); }}
      openRecord={openKey} onOpen={openPanel}
      // A column's New and a day's New record open the new record in the panel, with the column's value or the day filled in.
      canNew={fieldId=>canCreate===true&&create.fieldIds.includes(fieldId)}
      onNew={(fieldId,value)=>{const field=table.fields.find(entry=>entry.fieldId===fieldId);
        openCreate(document.activeElement instanceof HTMLElement?document.activeElement:null,field?{[fieldId]:{value,under:field}}:{});}}
      canMove={fieldId=>editOperation(fieldId)!==undefined}
      onMove={(row,fieldId,value)=>{const operation=editOperation(fieldId),field=fields.find(field=>field.fieldId===fieldId);if(!operation||!field||disabled)return;
        queue.enqueue({kind:"edit",record:row,operationId:operation.operationId,values:{[fieldId]:{value,under:field}},label:"Moved the record"},view);}} /></Suspense></div> : null}
    {failure && !busy && !visualBusy && (visual || !page) ? <CollectionUnavailable waiting={failure.wait !== null} words={failure.wait?.ended ? WAIT_ENDED : failure.words} onRetry={failure.retry} /> : null}
    {/* The table always shows its columns, so an empty Collection already says what a record holds. An offline copy pauses an open editor with what it holds. */}
    {!visual && page ? <div className="min-h-0 flex-1"><DataTable schema={schema} records={records} sort={sort} onSortChange={sortTable} canSortField={names.canSortField} fieldLabel={names.fieldLabel} recordName={nameRecord}
      onCellChange={changeCell} onDraftAbandoned={keepDraft} editingDisabled={offline} canEditCell={canEditCell} cellStatuses={view.statuses} acknowledgedWriteId={view.acknowledged} subscribeToDiscardedWrites={queue.subscribeToDiscarded}
      hostCells={hostCells} fieldMarks={tableMarks} renderButton={renderButton} onOpenRecord={openRecord} openRecordId={openKey}
      onNewRecord={canCreate && needsPanel ? newRecord : undefined} newRecord={canCreate && !needsPanel ? tableNewRecord : undefined}
      emptyText={page.rows.length > 0 || (!query.search && canCreate) ? undefined : query.search ? "No records match. Try a shorter search." : "No records yet. Refresh to check for new submissions."} /></div> : null}
    {!visual && page && (page.rows.length > 0 || previous.length > 0) ? <footer className="flex shrink-0 items-center justify-end gap-2 px-5 pb-2 text-[12px] text-muted"><div className="flex gap-2"><IconButton aria-label="Previous" title="Previous page" disabled={disabled || editor !== null || previous.length === 0} onClick={() => void load({ ...query, after: previous.at(-1) ?? null }, previous.slice(0, -1))}><ChevronLeft size={16} strokeWidth={1.9} aria-hidden /></IconButton><IconButton aria-label="Next" title="Next page" disabled={disabled || editor !== null || page.nextCursor === null} onClick={() => void load({ ...query, after: page.nextCursor }, [...previous, query.after])}><ChevronRight size={16} strokeWidth={1.9} aria-hidden /></IconButton></div></footer> : null}
  </div></CollectionFrame>;
}

type LoadFailure = { words: string; retry(): void; wait: { ms: number; ended: boolean } | null };
const WAIT_ENDED = "The wait has ended.";
/** Records that could not load: why, and Try again, which reads them as the toast's Try again does. A Collection waiting to reopen shows a clock. */
export function CollectionUnavailable({ waiting, words, onRetry }: { waiting: boolean; words: string; onRetry(): void }) {
  return <EmptyState icon={waiting ? Clock : AlertTriangle} tone={waiting ? "ghost" : "danger"} title={words}><SecondaryButton onClick={onRetry}>Try again</SecondaryButton></EmptyState>;
}

