import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Archive, CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Download, Eraser, FileInput, FileSpreadsheet, History, Inbox, LayoutList, MoreHorizontal, PanelsTopLeft, Plus, RefreshCw, Search, Shield, SlidersHorizontal, Table2, Undo2, X } from "lucide-react";
import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { DatasetCopyStatus } from "@dohc/cli/dataset";
// The table alone: the package's index also loads the board and the calendar, which this page loads only for those views.
import { TableView, type CollectionCellChange, type TableFieldMark, type TableHostCell } from "@dohc/collection-views/table";
import type { CollectionQuerySort, CollectionRecord, CollectionValue, FieldDefinition } from "@dohc/workspace-contracts";
import type { CollectionTableView } from "./collectionTableViews";
import { readCollectionReopenWait } from "../ipc/errorWords";
import { EmptyState, FieldError, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { CopyButton } from "./ui/CopyButton";
import { SkeletonRows } from "./ui/SkeletonRows";
import { isComposingKey } from "./ui/keys";
import { AutomationFieldIcon, automationFieldMarkLabel, type FieldMarks } from "./collections/collectionFieldMarks";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CalendarNeedsDateField } from "./collections/CalendarNeedsDateField";
import { CollectionAttachmentInput, CollectionRelationInput, invalidField } from "./CollectionResourceInputs";
import { TransactionalRecordDetailsDialog } from "./TransactionalRecordDetailsDialog";
import { ResourceCell, ResourceCellEditor } from "./TransactionalResourceCells";
import type { CollectionResources, CollectionResourceScope } from "./transactionalCollectionResources";
import {
  cannotTake, display, emptyValue, fieldShape, initialValue, inputProblem, isEmptyValue, isGeneratedRecordIdField, object, parsePage, supportsInput, supportsSort,
  type TransactionalCursor, type TransactionalDatasetDescription, type TransactionalField, type TransactionalPage, type TransactionalRow,
} from "./transactionalCollectionModel";
import { buttonColumn, buttonField, recordName, tableRecords, tableSchema } from "./transactionalVisualQueries";
import { NOT_CONFIRMED, resetWriteQueuesForTests, RULES_DISALLOW, writeQueueFor, type QueuedWrite, type Typed, type WriteAttention } from "./transactionalWriteQueue";

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
export interface TransactionalCollectionPageProps extends CollectionResources {
  buttons?: TransactionalButtons;
  /** The ⚡ Automations button, at the top beside New record. */
  automationsButton?: ReactNode;
  /** The fields switched-on automations set, by name, with those automations' names. */
  fieldMarks?: FieldMarks;
  activeView?: CollectionTableView | null;
  viewControls?(disabled: boolean): ReactNode;
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
  /** A change that answered after the page closed, which the page can no longer show. */
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
  onManageAccess?(): void;
  onExportRecovery?(): void;
  onArchive?(): void;
}
type Query = { after: TransactionalCursor | null; search: string; filters?: CollectionTableView["filters"]; sort?: { fieldId: string; direction: "asc" | "desc" } };
type Editor = { kind: "create"; operation: DatasetOperation } | { kind: "edit"; operation: DatasetOperation; row: TransactionalRow; field: TransactionalField };
/** The last confirmed edit that can be reversed: its record at the version its receipt reported, and the values it replaced. */
type Undo = { operation: DatasetOperation; id: string | number; version: number; values: Record<string, AppBackendJson> };
/** A field of the open form: its definition now, or the one its value was typed under once it is gone, and whether its value no longer fits. */
type FormField = { field: TransactionalField; value: AppBackendJson; changed: boolean };
const VALUE_CHANGED = "This field changed, so this value can't be saved. Copy it if you need it, then clear it.";
const CHANGE_GONE = "The Collection's rules no longer allow this change. Copy what you need, then choose Cancel.";
const SAVE_OFFLINE = "You can save this once the Collection is back online.";

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

/** A value dohc can't save: read-only, beside a copy of it and the one control that clears it. */
function ChangedValue({ name, value, disabled, describedBy, onClear }: { name: string; value: AppBackendJson; disabled: boolean; describedBy?: string; onClear(): void }) {
  return <span className="flex min-w-0 items-center gap-1">
    <input aria-label={name} {...invalidField(describedBy)} readOnly value={display(value)} className={inputClass} />
    <CopyButton iconOnly pinName label="Copy value" getText={() => display(value)} />
    <IconButton title="Clear value" aria-label="Clear value" disabled={disabled} onClick={onClear}><Eraser size={15} strokeWidth={1.9} aria-hidden /></IconButton>
  </span>;
}

function ValueInput({ field, value, disabled, describedBy, onChange }: { field: TransactionalField; value: AppBackendJson; disabled: boolean; describedBy?: string; onChange(value: AppBackendJson): void }) {
  const marked = invalidField(describedBy);
  if (field.type === "checkbox") return <input aria-label={field.name} {...marked} type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
  if (field.type === "select") return <select aria-label={field.name} {...marked} value={display(value)} disabled={disabled} onChange={event => onChange(event.target.value || null)} className={selectClass}>
    <option value="">Choose an option</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
  if (field.type === "multi-select") return <fieldset disabled={disabled} aria-label={field.name} aria-describedby={describedBy} className="m-0 flex flex-wrap gap-3 border-0 p-0">
    {field.options?.map(option => <label key={option} className="flex items-center gap-1 text-[13px] text-ink"><input type="checkbox" aria-invalid={describedBy === undefined ? undefined : true} checked={Array.isArray(value) && value.includes(option)} onChange={event => {
      const prior = Array.isArray(value) ? value : [];
      onChange(event.target.checked ? [...prior, option] : prior.filter(entry => entry !== option));
    }} />{option}</label>)}</fieldset>;
  return <input aria-label={field.name} {...marked} disabled={disabled} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
    step={field.type === "number" ? "any" : undefined} value={display(value)} className={inputClass} onChange={event => {
      const raw = event.target.value;
      onChange(field.type === "number" ? raw === "" ? null : Number(raw) : raw === "" && field.type !== "text" ? null : raw);
    }} />;
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
/**
 * The changes that need the person and that no cell on screen shows: a
 * change dohc could not confirm, with Try again, and a value it did not
 * save, with a copy of it and the control that clears it.
 */
function UnshownChanges({ items, onRetry, onClear }: { items: readonly WriteAttention[]; onRetry(id: number): void; onClear(recordKey: string, fieldId: string): void }) {
  const ids = useId();
  return <div role="group" aria-label="Changes dohc did not confirm" className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3 text-[12px] text-muted">
    {items.map((item, index) => item.kind === "unconfirmed"
      ? <div key={`change:${item.write.id}`} className="flex flex-wrap items-center gap-2"><span>{unconfirmedWords(item.write)}</span><SecondaryButton size="row" onClick={() => onRetry(item.write.id)}>Try again</SecondaryButton></div>
      : <div key={`value:${item.recordKey}:${item.fieldId}`} className="flex flex-col gap-1">
        <span>{item.fieldName} of record {String(item.recordId)}</span>
        <ChangedValue name={item.fieldName} value={item.value} disabled={false} describedBy={`${ids}-${index}`} onClear={() => onClear(item.recordKey, item.fieldId)} />
        <FieldError id={`${ids}-${index}`}>{item.reason}</FieldError>
      </div>)}
  </div>;
}

const sameRecord = (a: TransactionalRow, b: TransactionalRow) => JSON.stringify(a.id) === JSON.stringify(b.id);
/** Whether a field's values, read or typed under the `before` fields, may not show under the `now` ones. */
function staleUnder(before: readonly TransactionalField[], now: readonly TransactionalField[]): (fieldId: string) => boolean {
  const old = new Map(before.map(field => [field.fieldId, field])), current = new Map(now.map(field => [field.fieldId, field]));
  return fieldId => { const a = old.get(fieldId), b = current.get(fieldId); return !a || !b || fieldShape(a) !== fieldShape(b); };
}
/** The row without the values `stale` names, or the same row when it has none. */
function withoutStale(row: TransactionalRow, stale: (fieldId: string) => boolean): TransactionalRow {
  return Object.keys(row.values).some(stale) ? { ...row, values: Object.fromEntries(Object.entries(row.values).filter(([fieldId]) => !stale(fieldId))) } : row;
}
// `fields`: the table's fields when the edit was kept, under which its record's values were read.
type KeptEdit = { editor: Editor; draft: Record<string, Typed>; inDetails: boolean; fields: TransactionalField[] };
// Edits with changes a page held when it closed without asking, as when another file opens in its
// tab group, by workspace, Collection and table. The page opens the edit again.
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
  rows: ReadonlyMap<string, TransactionalRow>;
  fields: TransactionalField[];
  /** The fields a cell can change now, by id. */
  editable: ReadonlySet<string>;
  editOperation(fieldId: string): DatasetOperation | undefined;
  /** A load or an open form holds the page's own controls. */
  held: boolean;
  query: Query;
  load(next: Query, history?: Array<TransactionalCursor | null>): Promise<void>;
  openCreate(opener: HTMLElement | null): void;
  scope: CollectionResourceScope;
  offline: boolean;
  read: DatasetOperation;
  resources: CollectionResources;
  onError: TransactionalCollectionPageProps["onError"];
}
function ScopedCollectionPage(props: TransactionalCollectionPageProps) {
  const { workspaceId, dataset, tableId, invoke, onError, onNotice, confirmDelete, onCustomAction } = props;
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
  const [details, setDetails] = useState<TransactionalRow | null>(null);
  // What the open record's dialog says instead of its values, by the record's id, once a read in place could not find it.
  const [detailsUnavailable, setDetailsUnavailable] = useState<{ id: string; text: string } | null>(null);
  const openDetails = useRef(details); openDetails.current = details;
  // The by-id read of an open record a read in place left out, while it runs.
  const openRecordRead = useRef<AbortController | null>(null);
  // The element that last took focus in an open form, and its field.
  const lastFocus = useRef<{ element: Element; fieldId: string } | null>(null);
  const detailsOpen = details !== null;
  useEffect(() => { if (!detailsOpen) setDetailsUnavailable(null); }, [detailsOpen]);
  const editorForm = useRef<HTMLFormElement>(null);
  // What the person typed into the open form, by field id. A field they have not touched shows its record's
  // value, or a new record's default, under the field's definition now.
  const [draft, setDraft] = useState<Record<string, Typed>>({});
  // What is wrong with each field the person tried to save, by field id.
  const [invalid, setInvalid] = useState<Readonly<Record<string, string>>>({});
  const errorIds = useId(), focusInvalid = useRef(false);
  // The changes this table made that its host has not confirmed. The queue is this table's own, by workspace,
  // Collection and table, so an answer for another one reaches another queue and changes nothing here.
  const queue = useState(() => writeQueueFor(JSON.stringify([workspaceId, dataset.datasetId, tableId])))[0];
  useSyncExternalStore(queue.subscribe, queue.version);
  // The change the open form sent, while the form waits for its answer.
  const [awaiting, setAwaiting] = useState<number | null>(null), awaitingRef = useRef<number | null>(null);
  // Why the Collection did not take the open form's new record.
  const [formRefusal, setFormRefusal] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [resourceBusy, setResourceBusy] = useState(false);
  const resourceLock = useRef(false);
  const pendingResources = useRef(new Set<string>());
  const alive = useRef(true), sequence = useRef(0), readActive = useRef<AbortController | null>(null);
  // A full read of records holds the page's own controls. A change never does.
  const locked = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const currentQuery = useRef(query); currentQuery.current = query;
  const loadedVersion = useRef(props.recordsVersion), changedVersion = useRef(props.recordsChanged);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; readActive.current?.abort(); openRecordRead.current?.abort(); }; }, []);
  // Which edit is open. A change to the fields that only drops values from its record keeps it, and its focus.
  const opened = editor === null ? null : editor.kind === "create" ? `create:${editor.operation.operationId}` : JSON.stringify([editor.row.id, editor.field.fieldId, editor.operation.operationId]);
  useLayoutEffect(() => {
    const first = editor ? editorForm.current?.querySelector<HTMLElement>("input, select, button") : null;
    first?.focus();
    // The caret goes after the value, so typing adds to it.
    if (first instanceof HTMLInputElement && (first.type === "text" || first.type === "url")) first.setSelectionRange(first.value.length, first.value.length);
    // An edit the page opened again has no opener, so focus returns to the field's own button beside its input.
    if (editor && trigger.current === null) trigger.current = editorForm.current?.closest("dd")?.querySelector<HTMLElement>(":scope > button[hidden]") ?? null;
  }, [opened]);
  // The Save of a field open in details, which takes focus when its change could not be confirmed.
  const formSave = useRef<HTMLButtonElement>(null);

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
      setDetails(null); setQuery(next); setVisualRefresh(value => value + 1); return;
    }
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current, shows = queue.readStarted();
    locked.current = true; setBusy(true);
    try {
      const response = await invoke(request(read, pageInput(next), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded); setQuery(next); setPrevious(history);
      setDetails(open => open && (loaded.rows.find(row => JSON.stringify(row.id) === JSON.stringify(open.id)) ?? null));
      settle();
      queue.readShown(shows, loaded.rows);
    } catch (cause) {
      if (alive.current && sequence.current === mine && !abort.signal.aborted) {
        setPage(null); setDetails(null);
        failLoad(`dohc could not load ${table?.name ?? "this collection"}.`, cause, () => { if (alive.current) void load(next, history); });
      }
    } finally {
      if (alive.current && sequence.current === mine) { locked.current = false; setBusy(false); }
    }
  }
  // The words state the wait when it began, so once it ends the page says so.
  useEffect(() => {
    if (!failure?.wait || failure.wait.ended) return;
    const timer = setTimeout(() => setFailure(current => current === failure ? { ...failure, wait: { ms: failure.wait!.ms, ended: true } } : current), failure.wait.ms);
    return () => clearTimeout(timer);
  }, [failure]);
  // The queue reads the page's rules and handlers when it sends and when an answer comes, so each commit gives
  // it the current ones. It is given them before the page opens it, and before the rules change under it below.
  useLayoutEffect(() => {
    queue.sync({ workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, tableName: table?.name ?? "this Collection",
      fields: table?.fields ?? [], operations, offline, invoke, onError, onSettled: props.onSettled, onNotice, confirmed, dropped, unconfirmed, read: readForQueue });
  });
  // A page that closes leaves its queue. A request in flight ends without it, and what is unsent or unconfirmed
  // is here when the page opens again.
  useLayoutEffect(() => { queue.attach(); return () => queue.detach(); }, [queue]);
  const contractKey = JSON.stringify([dataset.revision, dataset.revisionSha256, dataset.operations, props.copy?.offline ?? false]);
  const priorContract = useRef(contractKey);
  // The fields the shown records, Undo and a board or calendar were read under.
  const priorFields = useRef(table?.fields ?? []);
  const activeViewKey = JSON.stringify(selectedView ?? null);
  // A change to the fields or rules keeps the page as it is: its records, search, page, open record, open form
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
    // An open edit shows its record's values from the page, its details, or as it opened, so all three lose them.
    setEditor(current => { if (current?.kind !== "edit") return current; const row = strip(current.row); return row === current.row ? current : { ...current, row }; });
    // A field whose focused input went, for another input or its changed value, keeps focus. Focus the person moved elsewhere stays there.
    const focused = lastFocus.current;
    if (focused && !focused.element.isConnected && (document.activeElement === null || document.activeElement === document.body)) focusField(focused.fieldId);
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
  // An edit with changes still open when the page closes opens again once the page shows its records. It keeps
  // the record's version from when it opened, so a change made to the record meanwhile is refused, not overwritten.
  const keptKey = JSON.stringify([workspaceId, dataset.datasetId, tableId]);
  const restoring = useRef(keptEdits.get(keptKey) ?? null);
  // The open form's operation, by id in the rules now. Gone, the form keeps what was typed but can't save it.
  const formOperation = editor && operations.find(operation => operation.operationId === editor.operation.operationId) || null;
  // A field the person has not touched shows the record's value as the page last read it.
  const editedRow = editor?.kind === "edit" ? page?.rows.find(row => sameRecord(row, editor.row)) ?? (details && sameRecord(details, editor.row) ? details : editor.row) : null;
  const untouched = (field: TransactionalField) => editedRow ? editedRow.values[field.fieldId] ?? null : initialValue(field);
  const form: FormField[] = !editor || !table ? [] : (() => {
    const allowed = (formOperation ?? editor.operation).fieldIds;
    const current = (fieldId: string) => allowed.includes(fieldId) ? table.fields.find(field => field.fieldId === fieldId) : undefined;
    const ids = editor.kind === "edit" ? [editor.field.fieldId] : table.fields.filter(field => allowed.includes(field.fieldId)).map(field => field.fieldId);
    // A value typed into a field the rules then dropped stays in the form until the person clears it.
    if (editor.kind === "create") ids.push(...Object.keys(draft).filter(fieldId => !ids.includes(fieldId)));
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
  keeping.current = editor && typed ? { editor, draft, inDetails: editor.kind === "edit" && details !== null && sameRecord(details, editor.row), fields: table?.fields ?? [] } : null;
  useEffect(() => {
    keptEdits.delete(keptKey);
    // A form whose change is with the queue is not kept: the queue has the change, and reports how it ended.
    // An edit not opened again yet, because the page closed before its records showed, stays kept.
    return () => { const kept = keeping.current ?? restoring.current; if (kept && awaitingRef.current === null) keptEdits.set(keptKey, kept); };
  }, [keptKey]);
  useLayoutEffect(() => {
    const kept = restoring.current;
    // A board or calendar opens the edit once its view has read, since the page's first load closes record details.
    if (!kept || (visual ? visualRefresh === 0 || visualBusy : page === null)) return;
    restoring.current = null;
    // Fields that changed while the page was closed flag their values, as for a change while it is open,
    // and the record's values read under their old definitions go.
    const editor = kept.editor.kind === "edit" ? { ...kept.editor, row: withoutStale(kept.editor.row, staleUnder(kept.fields, table?.fields ?? [])) } : kept.editor;
    setDraft(kept.draft); setInvalid({}); setEditor(editor);
    if (kept.inDetails && editor.kind === "edit") {
      const shown = page?.rows.find(row => sameRecord(row, editor.row));
      setDetails(shown ?? editor.row);
      // Not on the page, the record is read by its id for the values that went.
      if (!shown && kept.editor.kind === "edit" && editor.row !== kept.editor.row) void readOpenRecord(editor.row);
    }
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
    const mine = ++sequence.current, next = currentQuery.current, shows = queue.readStarted();
    try {
      const response = await invoke(request(read, pageInput(next), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded);
      settle();
      showOpenRecord(loaded.rows);
      queue.readShown(shows, loaded.rows);
    } catch (cause) {
      // Otherwise nothing to say: the change happened elsewhere, and the page still shows its last read.
      if (failure === undefined || !alive.current || sequence.current !== mine || abort.signal.aborted) return;
      setPage(null); setDetails(null);
      failLoad(failure, cause, () => { if (alive.current) void load(next, []); });
    }
  }
  /**
   * An open record shows what a read in place found of it. One the read left
   * out, as a Calendar record moved to another month, is read by its id, and
   * one that is gone says so instead of showing its old values.
   */
  function showOpenRecord(rows: readonly TransactionalRow[]): void {
    const open = openDetails.current;
    if (!open) return;
    // This read is newer than a by-id read still in flight, which then changes nothing.
    openRecordRead.current?.abort();
    const found = rows.find(row => sameRecord(row, open));
    if (!found) { void readOpenRecord(open); return; }
    setDetails(found); setDetailsUnavailable(null);
  }
  async function readOpenRecord(open: TransactionalRow): Promise<void> {
    if (!read || !alive.current || locked.current) return;
    const id = JSON.stringify(open.id), key = table?.primaryKeyFieldId;
    if (key === undefined || !read.fieldIds.includes(key)) {
      setDetailsUnavailable({ id, text: "This record is no longer in this view. Close it, then search for it." });
      return;
    }
    // Its own controller, so a newer read in place can stop it; the sequence, so any newer read makes it stale.
    const abort = new AbortController(); openRecordRead.current = abort;
    const mine = ++sequence.current;
    try {
      const response = await invoke(request(read, { limit: 1, filters: [{ fieldId: key, value: open.id }] }, crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const found = parsePage(response.result, read.fieldIds).rows.find(row => sameRecord(row, open));
      if (!found) { setDetailsUnavailable({ id, text: "This record is no longer in this Collection." }); return; }
      setDetails(current => current && sameRecord(current, open) ? found : current); setDetailsUnavailable(null);
    } catch {
      // Nothing to say, as for the read in place: the next change or Refresh reads again.
    }
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

  function closeEditor(): void { setEditor(null); setInvalid({}); setFormRefusal(null); awaitingRef.current = null; setAwaiting(null); }
  // An edit whose field the rules dropped, with nothing typed, has nothing left to show. A create action may take no fields.
  const emptyForm = editor?.kind === "edit" && form.length === 0;
  useEffect(() => { if (emptyForm) closeEditor(); }, [emptyForm]);
  // A cleared value's field takes focus, now an ordinary input.
  const refocus = useRef<string | null>(null);
  function focusField(fieldId: string): void {
    const root = editorForm.current;
    const holder = root && [root, ...root.querySelectorAll<HTMLElement>("[data-field]")].find(element => element.dataset.field === fieldId);
    holder?.querySelector<HTMLElement>("input, select, button")?.focus();
  }
  useLayoutEffect(() => {
    const fieldId = refocus.current;
    refocus.current = null;
    if (fieldId !== null) focusField(fieldId);
  }, [draft]);
  function clearValue(fieldId: string): void {
    refocus.current = fieldId;
    setDraft(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== fieldId)));
    setInvalid(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== fieldId)));
  }
  /** The host confirmed a change. The table shows it once a read does. */
  function confirmed(write: QueuedWrite, receipt: AppBackendJson): void {
    // Undo holds only under the rules its edit ran under.
    const current = write.request?.revision === dataset.revision && write.request.revisionSha256 === dataset.revisionSha256;
    setUndo(current ? undoFromReceipt(write, operations.find(operation => operation.operationId === write.operationId), receipt) : null);
    if (awaitingRef.current === write.id) closeEditor();
  }
  /** A change went unsaved. The form that sent it stays open with what was typed, and says why. */
  function dropped(write: QueuedWrite, reason: string): boolean {
    if (awaitingRef.current !== write.id) return false;
    awaitingRef.current = null; setAwaiting(null);
    const fieldId = write.kind === "edit" ? Object.keys(write.values)[0] : undefined;
    if (fieldId === undefined) setFormRefusal(reason);
    else { focusInvalid.current = true; setInvalid({ [fieldId]: reason }); }
    return true;
  }
  /** dohc could not confirm a change. */
  function unconfirmed(write: QueuedWrite): void {
    if (awaitingRef.current !== write.id) return;
    const fieldId = write.kind === "edit" ? Object.keys(write.values)[0] : undefined;
    // A field open in details keeps its value and says why under its input. Its check mark sends the same change again.
    if (fieldId !== undefined) { focusInvalid.current = true; setInvalid({ [fieldId]: NOT_CONFIRMED }); }
    // A new record's form closes, and the page lists the change with Try again.
    else closeEditor();
  }
  function submitEditor(): void {
    if (!editor || resourceLock.current) return;
    // The form's own change that dohc could not confirm goes again, as the same request, before any other.
    const sent = awaitingRef.current === null ? undefined : queue.find(awaitingRef.current);
    if (sent) { if (sent.state === "unconfirmed") queue.retry(sent.id); return; }
    if (!formOperation) return;
    // A value its field can no longer take is never sent: Save points at the first one instead.
    if (form.some(entry => entry.changed)) { focusInvalid.current = true; setInvalid(current => ({ ...current })); return; }
    const problems = form.flatMap(({ field, value }) => { const problem = inputProblem(field, value); return problem ? [[field.fieldId, problem] as const] : []; });
    if (problems.length > 0) { focusInvalid.current = true; setInvalid(Object.fromEntries(problems)); return; }
    setFormRefusal(null);
    const values: Record<string, Typed> = Object.fromEntries(form.map(({ field, value }) => [field.fieldId, { value, under: field }]));
    // The form waits from before the change is queued, since the queue can answer as it takes the change.
    awaitingRef.current = queue.nextWrite; setAwaiting(queue.nextWrite);
    // An edit keeps the record's version from when its field opened, so a change made to the record meanwhile is refused, not overwritten.
    queue.enqueue(editor.kind === "edit" ? { kind: "edit", record: editor.row, operationId: formOperation.operationId, values, label: "Saved the edit" }
      : { kind: "create", record: null, operationId: formOperation.operationId, values, label: "Created a record" });
  }
  // One confirmation at a time: a second press while the shell asks does nothing.
  const asking = useRef(false);
  async function deleteRecord(row: TransactionalRow): Promise<void> {
    if (!remove || !confirmDelete || asking.current) return;
    asking.current = true;
    try {
      const confirmed = await confirmDelete(row);
      if (!alive.current || !confirmed) return;
      setDetails(null);
      // The deletion follows the record's changes still queued, at the version they leave it.
      queue.enqueue({ kind: "delete", record: row, operationId: remove.operationId, label: "Deleted the record" });
    } catch (cause) { if (alive.current) onError("dohc could not confirm deletion.", cause, null); }
    finally { asking.current = false; }
  }
  function undoLast(): void {
    if (!undo || !table) return;
    const values: Record<string, Typed> = {};
    for (const [fieldId, value] of Object.entries(undo.values)) { const field = table.fields.find(entry => entry.fieldId === fieldId); if (field) values[fieldId] = { value, under: field }; }
    queue.enqueue({ kind: "edit", undo: true, record: { id: undo.id, version: undo.version }, operationId: undo.operation.operationId, values, label: "Reversed the last edit" });
  }
  // An edit started in record details opens in its field there.
  const editEntry = editor?.kind === "edit" ? form[0] : undefined;
  const detailsEdit = editEntry && editor?.kind === "edit" && details !== null && sameRecord(details, editor.row) ? editor : null;
  // The open form's change, while its host has not answered.
  const sent = awaiting === null ? undefined : queue.find(awaiting);
  // A full read, a view opening, or an upload holds the page's own controls. A change waiting to be confirmed never does.
  const disabled = busy || visualBusy || resourceBusy;
  // A form's inputs wait while its change is with the host. Once dohc could not confirm it, its Cancel and Save work again.
  const formDisabled = disabled || sent !== undefined;
  const formHeld = disabled || (sent !== undefined && sent.state !== "unconfirmed");
  // Records that could not load take no changes until a read shows them; Search and Refresh still read again.
  const writeDisabled = disabled || failure !== null;
  // A closed form returns focus to its opener once that is enabled again, unless the person has moved on.
  const returningFocus = useRef(false);
  useLayoutEffect(() => {
    if (editor) { returningFocus.current = true; return; }
    if (!returningFocus.current) return;
    const target = trigger.current?.isConnected ? trigger.current : null;
    if (target?.matches(":disabled")) return;
    returningFocus.current = false;
    if (document.activeElement === null || document.activeElement === document.body) target?.focus();
  }, [editor, writeDisabled]);
  // Pressing the check mark or Save with a wrong field moves focus to the first one.
  useLayoutEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    const target = editorForm.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    // A field's input stays disabled while its change waits to be confirmed, so its Save takes focus to try again.
    (target?.matches(":disabled") && formSave.current ? formSave.current : target)?.focus();
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
    if (!now || !row || !field) return queue.skip();
    const shown = queue.statuses.get(recordKey, fieldId), refused = shown?.state === "refused";
    const current = shown && !refused ? shown.value as AppBackendJson : row.values[fieldId] ?? null;
    // The same value saves nothing, and takes back a value dohc did not save.
    if (value !== undefined && sameValue(value, current)) { if (refused) queue.dismiss(recordKey, fieldId); return queue.skip(); }
    const operation = now.editOperation(fieldId);
    if (!operation || !now.editable.has(fieldId)) return queue.hold(row, field, value ?? null, RULES_DISALLOW);
    if (value === undefined) return queue.hold(row, field, null, `Enter a value ${field.name} can take.`);
    const problem = inputProblem(field, value);
    if (problem !== null) return queue.hold(row, field, value, problem);
    return queue.enqueue({ kind: "edit", record: row, operationId: operation.operationId, values: { [fieldId]: { value, under: field } }, label: "Saved the edit" });
  }, [queue]);
  const changeCell = useCallback((change: CollectionCellChange) => commitCell(change.recordId, change.field, jsonValue(change.value)), [commitCell]);
  const sortTable = useCallback((next: CollectionQuerySort[]) => {
    const now = live.current, by = next[0];
    if (!now || now.held) return;
    void now.load({ ...now.query, after: null, sort: by ? { fieldId: by.field, direction: by.direction } : undefined }, []);
  }, []);
  const openRecord = useCallback((record: CollectionRecord) => {
    const now = live.current, row = now?.rows.get(record.id);
    if (!now || !row || now.held) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetails(row);
  }, []);
  const newRecord = useCallback(() => {
    const now = live.current;
    if (now && !now.held) now.openCreate(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, []);
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
  const hostCells = useMemo(() => new Map(fields.filter(field => field.type === "attachment" || field.type === "relation").map((field): [string, TableHostCell] => [field.fieldId, {
    cell: record => {
      const now = live.current;
      if (!now) return null;
      const status = queue.statuses.get(record.id, field.fieldId);
      const value = status ? status.value as AppBackendJson : now.rows.get(record.id)?.values[field.fieldId];
      const readFile = now.resources.readFile;
      return <ResourceCell scope={now.scope} field={field} value={value} unconfirmed={status !== undefined} editable={now.editable.has(field.fieldId)} offline={now.offline} onError={now.onError}
        download={readFile && typeof value === "string" ? (request, signal) => readFile({ ...request, read: { operationId: now.read.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value }] } } }, signal) : undefined} />;
    },
    editor: canInput(field) ? (record, close) => {
      const now = live.current;
      if (!now) return null;
      const status = queue.statuses.get(record.id, field.fieldId);
      const initial = status ? status.value as AppBackendJson : now.rows.get(record.id)?.values[field.fieldId] ?? emptyValue(field);
      return <ResourceCellEditor scope={now.scope} field={field} initial={initial} upload={now.resources.uploadFile} resolve={now.resources.resolveRelation} onError={now.onError}
        onSave={value => { commitCell(record.id, field.fieldId, value); }} onClose={close} />;
    } : undefined,
  }])), [fieldKey, resourceKey]);

  if (!table || !read) return <section aria-label="Collection" className="p-4 text-sm text-muted">This collection is unavailable. Ask its owner for access.</section>;
  // Why the open form can't save, beside its Save.
  const formBlocked = editor && !formOperation ? offline ? SAVE_OFFLINE : CHANGE_GONE : null;
  const formProblem = formBlocked === SAVE_OFFLINE ? null : formBlocked ?? formRefusal;
  const formNote = formProblem !== null ? <FieldError id={`${errorIds}-form`}>{formProblem}</FieldError> : formBlocked !== null ? <p className="m-0 text-[12px] text-muted">{formBlocked}</p> : null;
  const openCreate = (opener: HTMLElement | null) => {
    if (!create) return;
    trigger.current = opener; setDraft({}); setInvalid({}); setFormRefusal(null); setEditor({ kind: "create", operation: create });
  };
  live.current = { rows, fields, editable: new Set(editableIds), editOperation, held: disabled || editor !== null, query, load, openCreate, scope, offline, read,
    resources: { uploadFile: props.uploadFile, readFile: props.readFile, resolveRelation: props.resolveRelation }, onError };
  // What needs the person and has no cell to say so: on a board or calendar, on another page of records, or in a
  // field the table no longer shows or changes.
  const inCell = (recordKey: string, fieldId: string) => !visual && page !== null && rows.has(recordKey) && fields.some(field => field.fieldId === fieldId);
  const unshown = queue.attention().filter(item => item.kind === "unconfirmed"
    ? item.write.id !== awaiting && !(item.write.record !== null && Object.keys(item.write.values).length > 0 && Object.keys(item.write.values).every(fieldId => inCell(item.write.record!.key, fieldId)))
    : !(inCell(item.recordKey, item.fieldId) && editableIds.includes(item.fieldId)));
  const problem = (entry: FormField) => entry.changed ? VALUE_CHANGED : invalid[entry.field.fieldId];
  const errorId = (entry: FormField) => problem(entry) === undefined ? undefined : `${errorIds}-${encodeURIComponent(entry.field.fieldId)}`;
  const fieldError = (entry: FormField) => problem(entry) === undefined ? null : <FieldError id={errorId(entry)!}>{problem(entry)}</FieldError>;
  const valueInput = (entry: FormField) => {
    const { field } = entry;
    if (entry.changed) return <ChangedValue name={field.name} value={entry.value} disabled={formDisabled} describedBy={errorId(entry)} onClear={() => clearValue(field.fieldId)} />;
    const input = { field, value: entry.value, disabled: formDisabled, describedBy: errorId(entry), onChange: (value: AppBackendJson) => {
      setDraft(current => ({ ...current, [field.fieldId]: { value, under: field } }));
      setInvalid(current => current[field.fieldId] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([fieldId]) => fieldId !== field.fieldId)));
    } };
    // A new definition, such as another related table, gets a new input with nothing it found under the old one.
    return field.type === "attachment" && props.uploadFile ? <CollectionAttachmentInput key={fieldShape(field)} {...input} scope={scope} upload={props.uploadFile} onError={onError} onBusy={value => {
      if (value) pendingResources.current.add(field.fieldId); else pendingResources.current.delete(field.fieldId);
      resourceLock.current = pendingResources.current.size > 0; setResourceBusy(resourceLock.current);
    }} /> : field.type === "relation" && props.resolveRelation ? <CollectionRelationInput key={fieldShape(field)} {...input} scope={scope} resolve={props.resolveRelation} onError={onError} /> : <ValueInput {...input} />;
  };
  // A field open in record details: its form, its Cancel and Save, and its keys.
  // Escape works from the input and from Cancel and Save, which sit outside the form.
  const editForm = (entry: FormField, className: string) => <form ref={editorForm} id={`${errorIds}-cell`} data-field={entry.field.fieldId} aria-label={`Edit ${entry.field.name}`} className={`flex flex-col gap-1 wrap-anywhere ${className}`} onSubmit={event => { event.preventDefault(); submitEditor(); }}>{valueInput(entry)}{fieldError(entry)}{formNote}</form>;
  const editButtons = <>
    <IconButton title="Cancel" aria-label="Cancel" disabled={formHeld} onClick={closeEditor}><X size={15} strokeWidth={1.9} aria-hidden /></IconButton>
    <IconButton ref={formSave} type="submit" form={`${errorIds}-cell`} title="Save" aria-label="Save" disabled={formHeld || !formOperation}><Check size={15} strokeWidth={1.9} aria-hidden /></IconButton>
  </>;
  const editKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || isComposingKey(event)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!formHeld) closeEditor(); }
    else if (event.key === "Enter" && (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement && event.target.type !== "file")) { event.preventDefault(); event.target.form?.requestSubmit(); }
  };
  // An open input keeps the value's text where it was. A checkbox or a list of choices keeps its own place.
  const inPlace = (field: TransactionalField) => field.type !== "checkbox" && field.type !== "multi-select";
  const canCreateForm = props.onCreateForm && operations.some(operation => operation.kind === "create" && operation.access === "link" && !operation.readOnly);
  const savedPages = props.copy && "coverage" in props.copy && props.copy.coverage === "saved-pages";
  const hasManagement = props.onCustomize || props.onReviewSchema || props.onManageAccess || props.onExportRecovery || props.onTransferCsv || props.onHistory || props.onPendingResponses || props.onArchive;
  return <section aria-label={table.name} aria-busy={busy} className="flex h-full min-h-0 flex-col gap-3 p-4" onFocus={event => {
    const fieldId = event.target.closest<HTMLElement>("[data-field]")?.dataset.field;
    lastFocus.current = fieldId === undefined ? null : { element: event.target, fieldId };
  }}>
    <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="m-0 min-w-0 truncate text-sm font-semibold text-ink">{table.name}</h2>
      <div className="flex shrink-0 items-center gap-2">{props.automationsButton}
      {canCreate ? <PrimaryButton className="flex shrink-0 items-center gap-1.5" disabled={writeDisabled || editor !== null} onClick={event => openCreate(event.currentTarget)}><Plus size={16} strokeWidth={1.9} aria-hidden />New record</PrimaryButton> : null}</div>
    </header>
    <div className="flex flex-wrap items-center gap-2">
      {props.viewControls?.(disabled || editor !== null)}
      <span className="relative flex items-center text-muted">
        {selectedView?.kind === "board" ? <PanelsTopLeft size={14} strokeWidth={1.9} aria-hidden className="pointer-events-none absolute left-2.5" /> : selectedView?.kind === "calendar" ? <CalendarDays size={14} strokeWidth={1.9} aria-hidden className="pointer-events-none absolute left-2.5" /> : <Table2 size={14} strokeWidth={1.9} aria-hidden className="pointer-events-none absolute left-2.5" />}
        <select aria-label="Collection layout" className={`${selectClass.replace("w-full", "w-auto").replace("px-2", "pl-8 pr-2")}`} disabled={disabled || editor !== null} value={selectedView?.kind ?? "table"} onChange={event => {
        const kind = event.target.value as CollectionTableView["kind"];
        setLocalView({viewId:"local",name:"Current view",search:query.search,filters:query.filters??[],sort:query.sort??null,kind,
          ...(kind==="board"?{groupBy:fields.find(field=>field.type==="select")?.fieldId??fields.find(supportsSort)?.fieldId}:{}),
          ...(kind==="calendar"?{dateField:dateFields[0]?.fieldId}:{})});
      }}><option value="table">Table</option><option value="board" disabled={!fields.some(supportsSort)}>Board</option><option value="calendar">Calendar</option></select></span>
      {selectedView?.kind==="board" ? <select aria-label="Group board by" className={selectClass.replace("w-full", "w-auto")} disabled={disabled || editor!==null} value={selectedView.groupBy??""} onChange={event=>setLocalView({...selectedView,groupBy:event.target.value})}>{fields.filter(supportsSort).map(field=><option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select> : null}
      {shownView?.kind==="calendar" && shownView.dateField ? <select aria-label="Calendar date" className={selectClass.replace("w-full", "w-auto")} disabled={disabled || editor!==null} value={shownView.dateField} onChange={event=>setLocalView({...shownView,dateField:event.target.value})}>{dateFields.map(field=><option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select> : null}
      {onCustomAction ? operations.filter(operation => operation.kind === "action").map(operation => <SecondaryButton key={operation.operationId} disabled={writeDisabled} onClick={() => onCustomAction(operation.operationId)}>{operation.label}</SecondaryButton>) : null}
      {undo && !offline ? <SecondaryButton disabled={writeDisabled || queue.size > 0} onClick={undoLast} className="flex items-center gap-1.5"><Undo2 size={14} strokeWidth={1.9} aria-hidden />Undo last edit</SecondaryButton> : null}
      <form className="ml-auto flex min-w-40 flex-1 items-center gap-1" onSubmit={event => { event.preventDefault(); void load({ ...query, after: null, search }, []); }}>
      <input aria-label="Search collection" placeholder="Search records" type="search" maxLength={200} className={`${inputClass.replace("w-full", "w-48 min-w-32 flex-1")}`} value={search} disabled={disabled || editor !== null} onChange={event => setSearch(event.target.value)} />
      <IconButton type="submit" aria-label="Search" title="Search" disabled={disabled || editor !== null}><Search size={16} strokeWidth={1.9} aria-hidden /></IconButton><IconButton aria-label="Refresh" title="Refresh" disabled={disabled || editor !== null} onClick={() => props.onRefresh ? props.onRefresh() : void load(query)}><RefreshCw size={16} strokeWidth={1.9} aria-hidden /></IconButton>
      </form>
      {canCreateForm ? <SecondaryButton className="flex items-center gap-1.5" disabled={writeDisabled || editor !== null} onClick={props.onCreateForm}><FileInput size={14} strokeWidth={1.9} aria-hidden />Create form</SecondaryButton> : null}
      {hasManagement ? <details className="group relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onClick={event => { if (event.target instanceof Element && event.target.closest("button:not(:disabled)")) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); event.stopPropagation(); } }}>
        <summary aria-label="Manage Collection" title="Manage Collection" className="flex cursor-pointer list-none items-center gap-1 rounded-lg border border-line bg-transparent px-2.5 py-1.5 text-xs text-muted hover:bg-hover hover:text-ink [&::-webkit-details-marker]:hidden">
          <MoreHorizontal size={16} strokeWidth={1.9} aria-hidden />
        </summary>
        <div className="dohc-popover absolute right-0 top-9 z-20 flex min-w-48 flex-col gap-1 rounded-lg border border-line bg-panel p-1">
          {props.onReviewSchema ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={writeDisabled || editor !== null} onClick={props.onReviewSchema}><LayoutList size={14} strokeWidth={1.9} aria-hidden />Fields and names</SecondaryButton> : null}
          {props.onManageAccess ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={disabled || editor !== null} onClick={props.onManageAccess}><Shield size={14} strokeWidth={1.9} aria-hidden />Manage access</SecondaryButton> : null}
          {props.onExportRecovery ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={disabled || editor !== null} onClick={props.onExportRecovery}><Download size={14} strokeWidth={1.9} aria-hidden />Export recovery</SecondaryButton> : null}
          {props.onTransferCsv ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={writeDisabled || editor !== null} onClick={props.onTransferCsv}><FileSpreadsheet size={14} strokeWidth={1.9} aria-hidden />Import or export CSV</SecondaryButton> : null}
          {props.onHistory ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={disabled || editor !== null} onClick={props.onHistory}><History size={14} strokeWidth={1.9} aria-hidden />History</SecondaryButton> : null}
          {props.onPendingResponses ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={disabled || editor !== null} onClick={props.onPendingResponses}><Inbox size={14} strokeWidth={1.9} aria-hidden />Pending responses</SecondaryButton> : null}
          {props.onCustomize ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={disabled || editor !== null} onClick={props.onCustomize}><SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden />Customize…</SecondaryButton> : null}
          {props.onArchive ? <SecondaryButton className="flex w-full items-center gap-2 text-left" disabled={disabled || editor !== null} onClick={props.onArchive}><Archive size={14} strokeWidth={1.9} aria-hidden />Archive</SecondaryButton> : null}
        </div>
      </details> : null}
    </div>
    {props.copy ? <span role="status" className="text-[12px] text-muted">{savedPages ? "Offline · Saved pages only" : props.copy.offline ? `Offline copy · Read-only${props.copy.host ? ` until ${props.copy.host} is reachable` : ""}`
      : `${props.copy.host ? `On ${props.copy.host} · ` : ""}Saved on this device`} · {new Date(props.copy.savedAtMs).toLocaleString()}</span> : null}
    {unshown.length > 0 ? <UnshownChanges items={unshown} onRetry={id => queue.retry(id)} onClear={(recordKey, fieldId) => queue.dismiss(recordKey, fieldId)} /> : null}
    {/* Lines stand in only for records not yet shown; a page already shown keeps its records and says it is loading. */}
    {busy ? page ? <p role="status" className="m-0 text-[12px] text-muted">Loading records…</p> : <SkeletonRows label="Loading records…" /> : null}
    {visual && shownView?.kind === "calendar" && !shownView.dateField ? <CalendarNeedsDateField disabled={writeDisabled || editor !== null} onAddDateField={props.onAddDateField} />
    : visual && shownView ? <Suspense fallback={<SkeletonRows label="Opening view…" />}><TransactionalCollectionViews key={JSON.stringify([activeViewKey,query.search,visualEpoch])} view={shownView} fields={fields} search={query.search} refresh={visualRefresh} changed={visualChanged} rules={contractKey}
      onReadInPlace={rows => { showOpenRecord(rows); const shows = visualRead.current; visualRead.current = Number.POSITIVE_INFINITY; queue.readShown(Number.isFinite(shows) ? shows : -1, rows); }}
      disabled={busy || resourceBusy || editor !== null} onBusy={setVisualBusy} onError={failLoad} onLoaded={settle}
      read={(input,signal)=>{ visualRead.current = Math.min(visualRead.current, queue.readStarted()); return invoke(request(read,input,crypto.randomUUID()),signal); }}
      onOpen={row=>{trigger.current=document.activeElement instanceof HTMLElement ? document.activeElement : null;setDetails(row);}}
      canMove={fieldId=>editOperation(fieldId)!==undefined}
      onMove={(row,fieldId,value)=>{const operation=editOperation(fieldId),field=fields.find(field=>field.fieldId===fieldId);if(!operation||!field||disabled)return;
        queue.enqueue({kind:"edit",record:row,operationId:operation.operationId,values:{[fieldId]:{value,under:field}},label:"Moved the record"});}} /></Suspense> : null}
    {failure && !busy && !visualBusy && (visual || !page) ? <CollectionUnavailable waiting={failure.wait !== null} words={failure.wait?.ended ? WAIT_ENDED : failure.words} onRetry={failure.retry} /> : null}
    {/* The table always shows its columns, so an empty Collection already says what a record holds. An offline copy pauses an open editor with what it holds. */}
    {!visual && page ? <div className="min-h-0 flex-1"><DataTable schema={schema} records={records} sort={sort} onSortChange={sortTable} canSortField={names.canSortField} fieldLabel={names.fieldLabel} recordName={nameRecord}
      onCellChange={changeCell} editingDisabled={offline} canEditCell={canEditCell} cellStatuses={queue.statuses} acknowledgedWriteId={queue.acknowledged} subscribeToDiscardedWrites={queue.subscribeToDiscarded}
      hostCells={hostCells} fieldMarks={tableMarks} renderButton={renderButton} onOpenRecord={openRecord} onNewRecord={canCreate ? newRecord : undefined}
      emptyText={page.rows.length > 0 || (!query.search && canCreate) ? undefined : query.search ? "No records match. Try a shorter search." : "No records yet. Refresh to check for new submissions."} /></div> : null}
    {!visual && page && (page.rows.length > 0 || previous.length > 0) ? <footer className="flex items-center justify-between gap-2 text-[12px] text-muted"><span className="tabular-nums">{page.rows.length} {page.rows.length === 1 ? "record" : "records"}{previous.length > 0 || page.nextCursor !== null ? " on this page" : ""}</span><div className="flex gap-2"><IconButton aria-label="Previous" title="Previous page" disabled={disabled || editor !== null || previous.length === 0} onClick={() => void load({ ...query, after: previous.at(-1) ?? null }, previous.slice(0, -1))}><ChevronLeft size={16} strokeWidth={1.9} aria-hidden /></IconButton><IconButton aria-label="Next" title="Next page" disabled={disabled || editor !== null || page.nextCursor === null} onClick={() => void load({ ...query, after: page.nextCursor }, [...previous, query.after])}><ChevronRight size={16} strokeWidth={1.9} aria-hidden /></IconButton></div></footer> : null}
    {/* While a field is open in details, its other controls wait. Closing details closes the field, as Cancel does. */}
    {details ? <TransactionalRecordDetailsDialog scope={scope} row={details} unavailable={detailsUnavailable?.id === JSON.stringify(details.id) ? detailsUnavailable.text : undefined} fields={fields} readOperation={read} operations={operations} readFile={props.readFile} offline={offline} disabled={disabled || detailsEdit !== null} canEdit={canInput} onError={onError} buttons={props.buttons} fieldMarks={props.fieldMarks}
      editing={detailsEdit ? { fieldId: detailsEdit.field.fieldId, name: editEntry!.field.name, content: <div data-edit-in-place className="flex min-w-0 flex-1 items-start gap-2" onKeyDown={editKeys}>
        {editForm(editEntry!, `min-w-0 flex-1${inPlace(editEntry!.field) && !editEntry!.changed ? " -mt-[7px] -mb-[2.5px] -ml-[11px]" : ""}`)}<span className="flex shrink-0 gap-2">{editButtons}</span>
      </div>, onCancel: () => { if (!formHeld) closeEditor(); } } : undefined}
      onClose={() => { setDetails(null); if (detailsEdit) closeEditor(); }}
      onEdit={(field, operation, opener) => { trigger.current = opener; setDraft({}); setInvalid({}); setFormRefusal(null); setEditor({ kind: "edit", operation, row: details, field }); }}
      onDelete={remove && confirmDelete ? () => { void deleteRecord(details); } : undefined}
      onAction={onCustomAction ? operation => { setDetails(null); onCustomAction(operation.operationId); } : undefined} /> : null}
    {/* A new record's form, and an edit whose record details has closed. Escape cancels it, as Cancel does. */}
    {editor && !detailsEdit ? <form ref={editorForm} aria-label={editor.kind === "edit" ? `Edit ${editor.field.name}` : "New record"} className="rounded-lg border border-line bg-panel p-3" onKeyDown={editKeys} onSubmit={event => { event.preventDefault(); submitEditor(); }}>
      <div className="flex flex-wrap gap-3">{form.map(entry => <div key={entry.field.fieldId} data-field={entry.field.fieldId} className="flex min-w-40 flex-1 flex-col gap-1 text-[12px] text-muted"><span>{entry.field.name}</span>{valueInput(entry)}{fieldError(entry)}</div>)}</div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2"><span className="mr-auto">{formNote}</span><SecondaryButton disabled={formHeld} onClick={closeEditor}>Cancel</SecondaryButton><PrimaryButton ref={formSave} type="submit" disabled={formHeld || !formOperation}>{sent && sent.state !== "unconfirmed" ? "Saving…" : editor.kind === "create" ? "Create record" : "Save"}</PrimaryButton></div>
    </form> : null}
  </section>;
}

type LoadFailure = { words: string; retry(): void; wait: { ms: number; ended: boolean } | null };
const WAIT_ENDED = "The wait has ended.";
/** Records that could not load: why, and Try again, which reads them as the toast's Try again does. A Collection waiting to reopen shows a clock. */
export function CollectionUnavailable({ waiting, words, onRetry }: { waiting: boolean; words: string; onRetry(): void }) {
  return <EmptyState icon={waiting ? Clock : AlertTriangle} tone={waiting ? "ghost" : "danger"} title={words}><SecondaryButton onClick={onRetry}>Try again</SecondaryButton></EmptyState>;
}

