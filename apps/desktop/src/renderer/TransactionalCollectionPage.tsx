import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Archive, CalendarDays, Check, CheckSquare, ChevronLeft, ChevronRight, Clock, Download, Eraser, Expand, FileInput, FileSpreadsheet, History, Inbox, LayoutList, MoreHorizontal, PanelsTopLeft, Plus, RefreshCw, Search, Shield, SlidersHorizontal, Square, Table2, Trash2, Undo2, X } from "lucide-react";
import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { DatasetCopyStatus } from "@dohc/cli/dataset";
import type { CollectionTableView } from "./collectionTableViews";
import { readCollectionReopenWait } from "../ipc/errorWords";
import { EmptyState, FieldError, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { CopyButton } from "./ui/CopyButton";
import { SkeletonRows } from "./ui/SkeletonRows";
import { isComposingKey } from "./ui/keys";
import { FieldTypeIcon } from "@dohc/collection-views/values";
import { AutomationFieldMark, type FieldMarks } from "./collections/collectionFieldMarks";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CalendarNeedsDateField } from "./collections/CalendarNeedsDateField";
import { CollectionAttachmentCell, CollectionAttachmentInput, CollectionRelationInput, invalidField } from "./CollectionResourceInputs";
import { TransactionalRecordDetailsDialog } from "./TransactionalRecordDetailsDialog";
import type { CollectionResources, CollectionResourceScope } from "./transactionalCollectionResources";
import {
  cannotTake, display, fieldShape, initialValue, inputProblem, isGeneratedRecordIdField, object, parsePage, supportsInput, supportsSort,
  type TransactionalCursor, type TransactionalDatasetDescription, type TransactionalField, type TransactionalPage, type TransactionalRow,
} from "./transactionalCollectionModel";

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
/** `cell` is the field a cell edit saves, so a failure shows under its input while the cell stays open. */
type Mutation = { operation: DatasetOperation; input: AppBackendJson; key: string; label: string; undo?: boolean; request?: TransactionalInvoke; invalidated?: boolean; cell?: string };
type Undo = { operation: DatasetOperation; input: AppBackendJson };
/** A value the person typed, with the field's definition they typed it under, so a later change to the field can tell whether it still fits. */
type Typed = { value: AppBackendJson; under: TransactionalField };
/** A field of the open form: its definition now, or the one its value was typed under once it is gone, and whether its value no longer fits. */
type FormField = { field: TransactionalField; value: AppBackendJson; changed: boolean };
const VALUE_CHANGED = "This field changed, so this value can't be saved. Copy it if you need it, then clear it.";
const CHANGE_GONE = "The Collection's rules no longer allow this change. Copy what you need, then choose Cancel.";
const SAVE_OFFLINE = "You can save this once the Collection is back online.";

function undoFromReceipt(change: Mutation, raw: AppBackendJson): Undo | null {
  if (change.operation.kind !== "edit" || !change.operation.reversible || change.undo) return null;
  let result: Record<string, AppBackendJson>;
  try { result = object(parseAppBackendJson(raw)); } catch { return null; }
  const priorRaw = result.priorValues;
  if (priorRaw === undefined) return null;
  try {
    const prior = object(priorRaw);
    const sent = object(change.input);
    const changedFields = Object.keys(object(sent.values!)).sort();
    if (typeof result.version !== "number" || !Number.isSafeInteger(result.version) || result.version < 1 || result.id !== sent.id ||
      JSON.stringify(Object.keys(prior).sort()) !== JSON.stringify(changedFields) || Object.keys(prior).some(field => !change.operation.fieldIds.includes(field))) return null;
    return { operation: change.operation, input: { id: result.id!, expectedVersion: result.version, values: prior } };
  } catch { return null; }
}

/** A value its field can no longer take: read-only, beside a copy of it and the one control that clears it. */
function ChangedValue({ field, value, disabled, describedBy, onClear }: { field: TransactionalField; value: AppBackendJson; disabled: boolean; describedBy?: string; onClear(): void }) {
  return <span className="flex min-w-0 items-center gap-1">
    <input aria-label={field.name} {...invalidField(describedBy)} readOnly value={display(value)} className={inputClass} />
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
/** Field and button columns share the table's width down to this floor; past it the table scrolls sideways. */
const FIELD_COLUMN_FLOOR = 160;
/** Fits a row's two icon buttons. */
const ACTIONS_COLUMN = 80;

function Cell({ field, value }: { field: TransactionalField; value: AppBackendJson | undefined }) {
  if (field.type === "checkbox" && typeof value === "boolean") {
    const Icon = value ? CheckSquare : Square;
    return <span className="inline-flex items-center"><Icon size={16} strokeWidth={1.9} aria-hidden className={value ? "text-accent" : "text-muted"} /><span className="sr-only">{value ? "Yes" : "No"}</span></span>;
  }
  if ((field.type === "select" || field.type === "multi-select") && value !== null && value !== undefined) {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) return <span className="text-muted">—</span>;
    return <span className="flex flex-wrap gap-1">{values.map((entry, index) => <span key={index} className="max-w-full truncate rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[12px] text-ink">{display(entry)}</span>)}</span>;
  }
  if (field.type === "checkbox") return <span className="text-[13px] text-ink">{value === true ? "Yes" : value === false ? "No" : "—"}</span>;
  return <span className="block truncate text-[13px] text-ink">{display(value) || "—"}</span>;
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
/** Tests start without edits an earlier test's page kept. */
export function resetKeptCollectionEditsForTests(): void {
  keptEdits.clear();
}

/** Keep view state across refreshes, but never across Collection identities. */
export function TransactionalCollectionPage(props: TransactionalCollectionPageProps) {
  const scope = JSON.stringify([props.workspaceId, props.dataset.datasetId, props.tableId]);
  return <ScopedCollectionPage key={scope} {...props} />;
}
function ScopedCollectionPage(props: TransactionalCollectionPageProps) {
  const { workspaceId, dataset, tableId, invoke, onError, onNotice, confirmDelete, onCustomAction } = props;
  const table = dataset.tables.find(table => table.tableId === tableId);
  const operations = dataset.operations.filter(operation => operation.tableId === tableId && (!props.copy?.offline || operation.readOnly));
  const read = operations.find(operation => operation.kind === "read" && operation.readOnly);
  const create = operations.find(operation => operation.kind === "create" && !operation.readOnly);
  const remove = operations.find(operation => operation.kind === "delete" && !operation.readOnly);
  const fields = table?.fields.filter(field => read?.fieldIds.includes(field.fieldId) &&
    !isGeneratedRecordIdField(field)) ?? [];
  const createFields = table?.fields.filter(field => create?.fieldIds.includes(field.fieldId)) ?? [];
  const canInput = (field: TransactionalField) => supportsInput(field) || (field.type === "attachment" && !!props.uploadFile) || (field.type === "relation" && !!field.relation && !!props.resolveRelation);
  const canCreate = create && createFields.every(canInput);
  const scope: CollectionResourceScope = { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256 };
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
  const editorForm = useRef<HTMLFormElement>(null), createRow = useRef<HTMLTableRowElement>(null), addRow = useRef<HTMLButtonElement>(null);
  // What the person typed into the open form, by field id. A field they have not touched shows its record's
  // value, or a new record's default, under the field's definition now.
  const [draft, setDraft] = useState<Record<string, Typed>>({});
  // What is wrong with each field the person tried to save, by field id.
  const [invalid, setInvalid] = useState<Readonly<Record<string, string>>>({});
  const errorIds = useId(), focusInvalid = useRef(false);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [resourceBusy, setResourceBusy] = useState(false);
  const resourceLock = useRef(false);
  const pendingResources = useRef(new Set<string>());
  const alive = useRef(true), sequence = useRef(0), active = useRef<AbortController | null>(null), readActive = useRef<AbortController | null>(null);
  const mutation = useRef<Mutation | null>(null), locked = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const currentQuery = useRef(query); currentQuery.current = query;
  const loadedVersion = useRef(props.recordsVersion), changedVersion = useRef(props.recordsChanged);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; readActive.current?.abort(); openRecordRead.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    const first = editor ? (createRow.current ?? editorForm.current)?.querySelector<HTMLElement>("input, select, button") : null;
    first?.focus();
    // The caret goes after the value, so typing adds to it.
    if (first instanceof HTMLInputElement && (first.type === "text" || first.type === "url")) first.setSelectionRange(first.value.length, first.value.length);
    // An edit the page opened again has no opener, so focus returns to the field's own button beside its input.
    if (editor && trigger.current === null) trigger.current = editorForm.current?.closest("td, dd")?.querySelector<HTMLElement>(":scope > button[hidden]") ?? null;
  }, [editor]);
  // The field of the cell open for editing, read when a save answers after this render.
  const openCell = useRef<string | null>(null), cellSave = useRef<HTMLButtonElement>(null);

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
      if (!mutation.current) { locked.current = false; setBusy(false); }
      setDetails(null); setQuery(next); setVisualRefresh(value => value + 1); return;
    }
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current;
    locked.current = true; setBusy(true);
    try {
      const response = await invoke(request(read, pageInput(next), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded); setQuery(next); setPrevious(history);
      setDetails(open => open && (loaded.rows.find(row => JSON.stringify(row.id) === JSON.stringify(open.id)) ?? null));
      settle();
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
    const change = mutation.current;
    if (change?.request && (change.request.revision !== dataset.revision || change.request.revisionSha256 !== dataset.revisionSha256)) {
      change.invalidated = true; active.current?.abort();
      mutation.current = null; setPending(null); setInvalid({});
      onError("The Collection's rules changed. Check the records before making another change.", new Error("The Collection's rules changed before this change was confirmed. Check the records before making another change."), null);
    }
    // The read stopped above can't end its own load now.
    if (!mutation.current) { locked.current = false; setBusy(false); }
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
      const values = Object.entries(object(object(current.input).values!));
      return values.every(([fieldId, value]) => { const old = before.get(fieldId); return old !== undefined && operation.fieldIds.includes(fieldId) && !cannotTake(old, now.get(fieldId), value); }) ? { ...current, operation } : null;
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
      return field || changed ? [{ field: field ?? typed.under, value: typed.value, changed }] : [];
    });
  })();
  const typed = form.some(({ field, value, changed }) => draft[field.fieldId] !== undefined && (changed || JSON.stringify(value) !== JSON.stringify(untouched(field))));
  const keeping = useRef<KeptEdit | null>(null);
  keeping.current = editor && typed ? { editor, draft, inDetails: editor.kind === "edit" && details !== null && sameRecord(details, editor.row), fields: table?.fields ?? [] } : null;
  useEffect(() => {
    keptEdits.delete(keptKey);
    // A change still saving goes on without the page and reports how it ended, so its edit is not kept.
    // An edit not opened again yet, because the page closed before its records showed, stays kept.
    return () => { const kept = keeping.current ?? restoring.current; if (kept && !mutation.current) keptEdits.set(keptKey, kept); };
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
  }, [props.recordsVersion, pending, editor, resourceBusy, busy]);
  /**
   * Reads the shown page again in place: no loading line, nothing disabled,
   * and an open record stays open, with its new values. A later read
   * supersedes it, and one that fails keeps what the page shows, which
   * Refresh reads again. It never starts while a read or a change holds the
   * page, since superseding that one would leave the page busy.
   *
   * After a change to the fields, the page's last read is stale, so a failure
   * is reported in `failure`'s words, as a load's is.
   */
  async function reread(failure?: string): Promise<void> {
    if (!read || !alive.current || locked.current) return;
    readActive.current?.abort();
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current, next = currentQuery.current;
    try {
      const response = await invoke(request(read, pageInput(next), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded);
      settle();
      showOpenRecord(loaded.rows);
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
  // What changed elsewhere waits for a read or a change in flight to end, then shows in place. The lock is
  // read now, not from this render, since a read the effect above started in this same commit has taken it.
  useEffect(() => {
    if (changedVersion.current === props.recordsChanged || busy || visualBusy || resourceBusy || locked.current) return;
    changedVersion.current = props.recordsChanged;
    if (visual) setVisualChanged(value => value + 1);
    else void reread();
  }, [props.recordsChanged, busy, visualBusy, resourceBusy]);

  function closeEditor(): void { setEditor(null); setInvalid({}); }
  // An edit whose field the rules dropped, with nothing typed, has nothing left to show.
  const emptyForm = editor !== null && form.length === 0;
  useEffect(() => { if (emptyForm) closeEditor(); }, [emptyForm]);
  // A cleared value's field takes focus, now an ordinary input.
  const refocus = useRef<string | null>(null);
  function focusField(fieldId: string): void {
    const root = createRow.current ?? editorForm.current;
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
  const currentExecute = useRef(execute);
  useLayoutEffect(() => { currentExecute.current = execute; });
  async function execute(change: Mutation): Promise<void> {
    if (props.copy?.offline) return;
    if (!alive.current || change.invalidated || locked.current || (mutation.current && mutation.current !== change)) return;
    if (change.request && (change.request.revision !== dataset.revision || change.request.revisionSha256 !== dataset.revisionSha256)) return;
    mutation.current = change; setPending(change); locked.current = true; setBusy(true);
    const abort = new AbortController(); active.current = abort;
    try {
      const submission = change.request ??= request(change.operation, change.input, change.key);
      const response = await invoke(submission, abort.signal);
      if (abort.signal.aborted) return;
      // The page shows its own change. Once it has closed, a notice says the change saved, and in which Collection.
      if (!alive.current) { if (table) onNotice?.(`${change.undo ? "Reversed the last edit" : change.label} in ${table.name}`); return; }
      setUndo(priorContract.current === contractKey ? undoFromReceipt(change, response.result) : null);
      mutation.current = null; setPending(null); closeEditor();
      locked.current = false; setBusy(false);
      if (priorContract.current === contractKey) await load(currentQuery.current);
    } catch (cause) {
      if (abort.signal.aborted) return;
      const refused = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "operation_refused";
      // Once the page has closed, a failure still reaches a toast and Notices, and names the Collection.
      if (!alive.current) {
        const name = table?.name ?? "this Collection";
        onError(refused ? `${name} refused the change. Open it to check its records.` : `dohc could not confirm the change to ${name}. Open it to check its records.`, cause, null);
        return;
      }
      const words = refused ? "The collection refused this change." : "dohc could not confirm this change.";
      if (refused) { mutation.current = null; setPending(null); }
      // A cell still open keeps its value and says why under its input. Its check mark tries the same change again.
      if (change.cell !== undefined && openCell.current === change.cell) { focusInvalid.current = true; setInvalid({ [change.cell]: words }); }
      else if (!refused) closeEditor();
      // Try again sends the change only while it still waits, so once it lands an old row can't close a newer edit.
      onError(words, cause, refused ? null : () => { if (alive.current && mutation.current === change) void currentExecute.current(change); });
    } finally { if (alive.current && !change.invalidated) { locked.current = false; setBusy(false); } }
  }
  function submitEditor(): void {
    if (!editor || locked.current || resourceLock.current) return;
    // The cell's own change that could not be confirmed goes again, with its key, before any other.
    if (mutation.current) { if (mutation.current.cell !== undefined && mutation.current.cell === openCell.current) void execute(mutation.current); return; }
    // The row has no form to stop a value the browser rejects, such as a half-typed number.
    if (createRow.current && !Array.from(createRow.current.querySelectorAll("input")).every(input => input.reportValidity())) return;
    if (!formOperation) return;
    // A value its field can no longer take is never sent: Save points at the first one instead.
    if (form.some(entry => entry.changed)) { focusInvalid.current = true; setInvalid(current => ({ ...current })); return; }
    const problems = form.flatMap(({ field, value }) => { const problem = inputProblem(field, value); return problem ? [[field.fieldId, problem] as const] : []; });
    if (problems.length > 0) { focusInvalid.current = true; setInvalid(Object.fromEntries(problems)); return; }
    const values = Object.fromEntries(form.map(({ field, value }) => [field.fieldId, value]));
    const input: AppBackendJson = editor.kind === "edit" ? { id: editor.row.id, expectedVersion: editor.row.version, values } : { values };
    void execute({ operation: formOperation, input, key: crypto.randomUUID(), label: editor.kind === "edit" ? "Saved the edit" : "Created a record", ...(editor.kind === "edit" && editor.field.fieldId === openCell.current ? { cell: editor.field.fieldId } : {}) });
  }
  async function deleteRecord(row: TransactionalRow): Promise<void> {
    if (!remove || !confirmDelete || locked.current || mutation.current) return;
    locked.current = true; setBusy(true);
    try {
      const confirmed = await confirmDelete(row);
      if (!alive.current) return;
      locked.current = false; setBusy(false);
      if (confirmed) await execute({ operation: remove, input: { id: row.id, expectedVersion: row.version }, key: crypto.randomUUID(), label: "Deleted the record" });
    } catch (cause) { if (alive.current) onError("dohc could not confirm deletion.", cause, null); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  // An edit started in record details opens in its field there. Any other edit of a field this page of the table shows opens in its cell.
  const editEntry = editor?.kind === "edit" ? form[0] : undefined;
  const detailsEdit = editEntry && editor?.kind === "edit" && details !== null && sameRecord(details, editor.row) ? editor : null;
  const cellEdit = editEntry && !detailsEdit && editor?.kind === "edit" && !visual && page !== null && fields.some(field => field.fieldId === editor.field.fieldId) && page.rows.some(row => sameRecord(row, editor.row)) ? editor : null;
  const openEdit = detailsEdit ?? cellEdit;
  openCell.current = openEdit?.field.fieldId ?? null;
  // The open cell's own change that could not be confirmed: the cell says so, and its check mark and × stay usable.
  const cellPending = pending?.cell !== undefined && pending.cell === openEdit?.field.fieldId;
  const disabled = busy || visualBusy || pending !== null || resourceBusy;
  const cellDisabled = busy || visualBusy || resourceBusy || (pending !== null && !cellPending);
  const readDisabled = busy || visualBusy || resourceBusy;
  // Records that could not load take no changes until a read shows them; Search and Refresh still read again.
  const writeDisabled = disabled || failure !== null;
  // A closed editor returns focus to its opener once that is enabled again, unless the person has moved on.
  // Closing the table's New record row remounts its button, so focus goes to the new button.
  const returningFocus = useRef(false);
  useLayoutEffect(() => {
    if (editor) { returningFocus.current = true; return; }
    if (!returningFocus.current) return;
    const target = trigger.current?.isConnected ? trigger.current : addRow.current;
    if (target?.matches(":disabled")) return;
    returningFocus.current = false;
    if (document.activeElement === null || document.activeElement === document.body) target?.focus();
  }, [editor, writeDisabled]);
  // Pressing the check mark or Save with a wrong field moves focus to the first one.
  useLayoutEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    const target = (createRow.current ?? editorForm.current)?.querySelector<HTMLElement>('[aria-invalid="true"]');
    // A cell's input stays disabled while its change waits to be confirmed, so its check mark takes focus to try again.
    (target?.matches(":disabled") && cellSave.current ? cellSave.current : target)?.focus();
  }, [invalid]);
  if (!table || !read) return <section aria-label="Collection" className="p-4 text-sm text-muted">This collection is unavailable. Ask its owner for access.</section>;
  // A new record is a row of the table when every field it takes is a column.
  const createInRow = editor?.kind === "create" && !visual && page !== null && formOperation !== null && form.every(entry => fields.some(field => field.fieldId === entry.field.fieldId));
  // Why the open form can't save, beside its Save.
  const formBlocked = editor && !formOperation ? props.copy?.offline ? SAVE_OFFLINE : CHANGE_GONE : null;
  const formNote = formBlocked === null ? null : formBlocked === CHANGE_GONE ? <FieldError id={`${errorIds}-form`}>{formBlocked}</FieldError> : <p className="m-0 text-[12px] text-muted">{formBlocked}</p>;
  const columns = fields.length + (props.buttons?.fields.length ?? 0) + 1;
  const openCreate = (opener: HTMLElement) => {
    if (!create) return;
    trigger.current = opener; setDraft({}); setInvalid({}); setEditor({ kind: "create", operation: create });
  };
  const problem = (entry: FormField) => entry.changed ? VALUE_CHANGED : invalid[entry.field.fieldId];
  const errorId = (entry: FormField) => problem(entry) === undefined ? undefined : `${errorIds}-${encodeURIComponent(entry.field.fieldId)}`;
  const fieldError = (entry: FormField) => problem(entry) === undefined ? null : <FieldError id={errorId(entry)!}>{problem(entry)}</FieldError>;
  const valueInput = (entry: FormField) => {
    const { field } = entry;
    if (entry.changed) return <ChangedValue field={field} value={entry.value} disabled={disabled} describedBy={errorId(entry)} onClear={() => clearValue(field.fieldId)} />;
    const input = { field, value: entry.value, disabled, describedBy: errorId(entry), onChange: (value: AppBackendJson) => {
      setDraft(current => ({ ...current, [field.fieldId]: { value, under: field } }));
      setInvalid(current => current[field.fieldId] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([fieldId]) => fieldId !== field.fieldId)));
    } };
    // A new definition, such as another related table, gets a new input with nothing it found under the old one.
    return field.type === "attachment" && props.uploadFile ? <CollectionAttachmentInput key={fieldShape(field)} {...input} scope={scope} upload={props.uploadFile} onError={onError} onBusy={value => {
      if (value) pendingResources.current.add(field.fieldId); else pendingResources.current.delete(field.fieldId);
      resourceLock.current = pendingResources.current.size > 0; setResourceBusy(resourceLock.current);
    }} /> : field.type === "relation" && props.resolveRelation ? <CollectionRelationInput key={fieldShape(field)} {...input} scope={scope} resolve={props.resolveRelation} onError={onError} /> : <ValueInput {...input} />;
  };
  // An open cell, in the table or in record details: its form, its Cancel and Save, and its keys.
  // Escape works from the input and from Cancel and Save, which sit outside the form.
  const editForm = (entry: FormField, className: string) => <form ref={editorForm} id={`${errorIds}-cell`} data-field={entry.field.fieldId} aria-label={`Edit ${entry.field.name}`} className={`flex flex-col gap-1 wrap-anywhere ${className}`} onSubmit={event => { event.preventDefault(); submitEditor(); }}>{valueInput(entry)}{fieldError(entry)}{formNote}</form>;
  const editButtons = <>
    <IconButton title="Cancel" aria-label="Cancel" disabled={cellDisabled} onClick={closeEditor}><X size={15} strokeWidth={1.9} aria-hidden /></IconButton>
    <IconButton ref={cellSave} type="submit" form={`${errorIds}-cell`} title="Save" aria-label="Save" disabled={cellDisabled || !formOperation}><Check size={15} strokeWidth={1.9} aria-hidden /></IconButton>
  </>;
  const editKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || isComposingKey(event)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!cellDisabled) closeEditor(); }
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
      {undo && !props.copy?.offline ? <SecondaryButton disabled={writeDisabled} onClick={() => void execute({ ...undo, key: crypto.randomUUID(), label: "Reversed the last edit", undo: true })} className="flex items-center gap-1.5"><Undo2 size={14} strokeWidth={1.9} aria-hidden />Undo last edit</SecondaryButton> : null}
      <form className="ml-auto flex min-w-40 flex-1 items-center gap-1" onSubmit={event => { event.preventDefault(); void load({ ...query, after: null, search }, []); }}>
      <input aria-label="Search collection" placeholder="Search records" type="search" maxLength={200} className={`${inputClass.replace("w-full", "w-48 min-w-32 flex-1")}`} value={search} disabled={readDisabled || editor !== null} onChange={event => setSearch(event.target.value)} />
      <IconButton type="submit" aria-label="Search" title="Search" disabled={readDisabled || editor !== null}><Search size={16} strokeWidth={1.9} aria-hidden /></IconButton><IconButton aria-label="Refresh" title="Refresh" disabled={readDisabled || editor !== null} onClick={() => props.onRefresh ? props.onRefresh() : void load(query)}><RefreshCw size={16} strokeWidth={1.9} aria-hidden /></IconButton>
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
    {pending && !busy && !cellPending ? <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><span>Change not confirmed</span><span>Browse records while you wait. Retry this change before making another.</span><SecondaryButton onClick={() => void execute(pending)}>Try again</SecondaryButton></div> : null}
    {/* Lines stand in only for records not yet shown; a page already shown keeps its records and says it is loading. */}
    {busy ? pending || page ? <p role="status" className="m-0 text-[12px] text-muted">{pending ? "Saving…" : "Loading records…"}</p> : <SkeletonRows label="Loading records…" /> : null}
    {visual && shownView?.kind === "calendar" && !shownView.dateField ? <CalendarNeedsDateField disabled={writeDisabled || editor !== null} onAddDateField={props.onAddDateField} />
    : visual && shownView ? <Suspense fallback={<SkeletonRows label="Opening view…" />}><TransactionalCollectionViews key={JSON.stringify([activeViewKey,query.search,visualEpoch])} view={shownView} fields={fields} search={query.search} refresh={visualRefresh} changed={visualChanged} rules={contractKey} onReadInPlace={showOpenRecord}
      disabled={busy || pending !== null || resourceBusy || editor !== null} onBusy={setVisualBusy} onError={failLoad} onLoaded={settle}
      read={(input,signal)=>invoke(request(read,input,crypto.randomUUID()),signal)}
      onOpen={row=>{trigger.current=document.activeElement instanceof HTMLElement ? document.activeElement : null;setDetails(row);}}
      canMove={fieldId=>!props.copy?.offline&&operations.some(operation=>operation.kind==="edit"&&!operation.readOnly&&operation.fieldIds.includes(fieldId))}
      onMove={(row,fieldId,value)=>{const operation=operations.find(operation=>operation.kind==="edit"&&!operation.readOnly&&operation.fieldIds.includes(fieldId));if(!operation||disabled)return;
        void execute({operation,input:{id:row.id,expectedVersion:row.version,values:{[fieldId]:value}},key:crypto.randomUUID(),label:"Moved the record"});}} /></Suspense> : null}
    {failure && !busy && !visualBusy && (visual || !page) ? <CollectionUnavailable waiting={failure.wait !== null} words={failure.wait?.ended ? WAIT_ENDED : failure.words} onRetry={failure.retry} /> : null}
    {/* The table always shows its columns, so an empty Collection already says what a record holds. */}
    {!visual && page ? <div className="min-h-0 overflow-auto"><table className="w-full table-fixed border-collapse text-[13px]" style={{ minWidth: (columns - 1) * FIELD_COLUMN_FLOOR + ACTIONS_COLUMN }}>
      <colgroup>{Array.from({ length: columns - 1 }, (_, index) => <col key={index} />)}<col style={{ width: ACTIONS_COLUMN }} /></colgroup>
      <thead className="sticky top-0 bg-bg"><tr>{fields.map(field => <th key={field.fieldId} scope="col" aria-sort={query.sort?.fieldId === field.fieldId ? query.sort.direction === "asc" ? "ascending" : "descending" : undefined} className="border-b border-line px-3 py-2 text-left font-medium text-muted">
        <span className="flex items-center gap-1.5">{supportsSort(field) ? <button type="button" disabled={readDisabled || editor !== null} className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => void load({ ...query, after: null, sort: { fieldId: field.fieldId, direction: query.sort?.fieldId === field.fieldId && query.sort.direction === "asc" ? "desc" : "asc" } }, [])}><FieldTypeIcon type={field.type} /><span className="min-w-0 truncate">{field.name}</span>{query.sort?.fieldId === field.fieldId ? <span className="shrink-0">{query.sort.direction === "asc" ? " ↑" : " ↓"}</span> : null}</button> : <><FieldTypeIcon type={field.type} /><span className="min-w-0 truncate">{field.name}</span></>}
        {props.fieldMarks?.has(field.name) ? <AutomationFieldMark automations={props.fieldMarks.get(field.name)!} /> : null}</span>
      </th>)}{props.buttons?.fields.map(field => <th key={`button:${field}`} scope="col" className="border-b border-line px-3 py-2 text-left font-medium text-muted"><span className="block truncate">{field}</span></th>)}<th scope="col" className="border-b border-line"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{page.rows.map(row => {
        // The row with an open cell aligns its cells to the top, so an error under the input pushes only the rows below.
        const editing = cellEdit !== null && sameRecord(row, cellEdit.row);
        const rest = editing ? "px-3 pt-2.5 pb-2 align-top" : "px-3 py-2";
        return <tr key={JSON.stringify(row.id)} className="border-b border-line last:border-0 hover:bg-hover" onKeyDown={editing ? editKeys : undefined}>{fields.map(field => {
        const edit = operations.find(operation => operation.kind === "edit" && !operation.readOnly && operation.fieldIds.includes(field.fieldId));
        const open = editing && cellEdit?.field.fieldId === field.fieldId;
        const attachment = field.type === "attachment" && typeof row.values[field.fieldId] === "string" && props.readFile && !props.copy?.offline;
        return <td key={field.fieldId} className={`${open && inPlace(field) ? "px-px py-[3px] align-top" : rest} text-ink`}>{attachment && !open ? <CollectionAttachmentCell key={String(row.values[field.fieldId])} scope={scope} fieldName={field.name} fileId={String(row.values[field.fieldId])} disabled={disabled || editor !== null} read={(request, signal) => props.readFile!({ ...request, read: { operationId: read!.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value: row.values[field.fieldId]! }] } } }, signal)} onError={onError} /> : null}{edit && canInput(field) ? <button type="button" aria-label={`Edit ${field.name} for record ${row.id}`} disabled={disabled || editor !== null} hidden={open} className="block w-full truncate rounded text-left" onClick={event => {
          trigger.current = event.currentTarget; setDraft({}); setInvalid({}); setEditor({ kind: "edit", operation: edit, row, field });
        }}>{field.type === "attachment" ? "Change file" : <Cell field={field} value={row.values[field.fieldId]} />}</button> : attachment ? null : field.type === "attachment" && row.values[field.fieldId] && props.copy?.offline ? <span className="block truncate text-[13px] text-muted">File available when online</span> : <Cell field={field} value={row.values[field.fieldId]} />}{open && editEntry ? editForm(editEntry, "") : null}</td>;
      })}{props.buttons?.fields.map(field => <td key={`button:${field}`} className={rest}>{props.buttons!.render(field, row)}</td>)}<td className={editing ? "px-3 py-2 align-top" : "px-3 py-2"}><div className="flex justify-end gap-2">{editing ? editButtons : null}{/* The record actions stay while hidden, so focus can return to the one that opened details. */}<IconButton hidden={editing} title="Record details" aria-label={`Open record ${row.id}`} disabled={disabled || editor !== null} onClick={event => { trigger.current = event.currentTarget; setDetails(row); }}><Expand size={15} strokeWidth={1.9} aria-hidden /></IconButton>{remove && confirmDelete ? <IconButton hidden={editing} title="Delete record" aria-label={`Delete record ${row.id}`} disabled={disabled || editor !== null} onClick={() => void deleteRecord(row)}><Trash2 size={15} strokeWidth={1.9} aria-hidden /></IconButton> : null}</div></td></tr>;
      })}
      {page.rows.length === 0 && (query.search || !canCreate) ? <tr><td colSpan={columns} className="px-3 py-2 text-muted">{query.search ? "No records match. Try a shorter search." : "No records yet. Refresh to check for new submissions."}</td></tr> : null}
      {createInRow ? <tr ref={createRow} aria-label="New record" className="border-b border-line" onKeyDown={event => {
        if (event.defaultPrevented || isComposingKey(event)) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeEditor(); }
        else if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox" && event.target.type !== "file") { event.preventDefault(); submitEditor(); }
      }}>{fields.map(field => { const entry = form.find(entry => entry.field.fieldId === field.fieldId); return <td key={field.fieldId} className="px-3 py-1.5 align-top">{entry ? <div data-field={entry.field.fieldId} className="flex flex-col gap-1 wrap-anywhere">{valueInput(entry)}{fieldError(entry)}</div> : null}</td>; })}{props.buttons?.fields.map(field => <td key={`button:${field}`} />)}<td className="px-3 py-1.5 align-top"><div className="flex justify-end gap-2">
        <IconButton title="Cancel" aria-label="Cancel" disabled={disabled} onClick={closeEditor}><X size={15} strokeWidth={1.9} aria-hidden /></IconButton>
        <IconButton title="Create record" aria-label="Create record" disabled={disabled} onClick={submitEditor}><Check size={15} strokeWidth={1.9} aria-hidden /></IconButton>
      </div></td></tr> : null}
      {canCreate && !createInRow ? <tr><td colSpan={columns} className="p-0"><button ref={addRow} type="button" disabled={writeDisabled || editor !== null} className="flex h-9 w-full items-center gap-1.5 px-3 text-left text-[13px] text-subtle transition-colors hover:text-ink dohc-focus-row disabled:cursor-not-allowed disabled:opacity-50" onClick={event => openCreate(event.currentTarget)}><Plus size={14} strokeWidth={1.9} aria-hidden />New record</button></td></tr> : null}
    </tbody>
    </table></div> : null}
    {!visual && page && (page.rows.length > 0 || previous.length > 0) ? <footer className="flex items-center justify-between gap-2 text-[12px] text-muted"><span className="tabular-nums">{page.rows.length} {page.rows.length === 1 ? "record" : "records"}{previous.length > 0 || page.nextCursor !== null ? " on this page" : ""}</span><div className="flex gap-2"><IconButton aria-label="Previous" title="Previous page" disabled={readDisabled || editor !== null || previous.length === 0} onClick={() => void load({ ...query, after: previous.at(-1) ?? null }, previous.slice(0, -1))}><ChevronLeft size={16} strokeWidth={1.9} aria-hidden /></IconButton><IconButton aria-label="Next" title="Next page" disabled={readDisabled || editor !== null || page.nextCursor === null} onClick={() => void load({ ...query, after: page.nextCursor }, [...previous, query.after])}><ChevronRight size={16} strokeWidth={1.9} aria-hidden /></IconButton></div></footer> : null}
    {/* While a field is open in details, its other controls wait. Closing details closes the field, as Cancel does. */}
    {details ? <TransactionalRecordDetailsDialog scope={scope} row={details} unavailable={detailsUnavailable?.id === JSON.stringify(details.id) ? detailsUnavailable.text : undefined} fields={fields} readOperation={read} operations={operations} readFile={props.readFile} offline={props.copy?.offline} disabled={disabled || detailsEdit !== null} canEdit={canInput} onError={onError} buttons={props.buttons} fieldMarks={props.fieldMarks}
      editing={detailsEdit ? { fieldId: detailsEdit.field.fieldId, name: editEntry!.field.name, content: <div data-edit-in-place className="flex min-w-0 flex-1 items-start gap-2" onKeyDown={editKeys}>
        {editForm(editEntry!, `min-w-0 flex-1${inPlace(editEntry!.field) && !editEntry!.changed ? " -mt-[7px] -mb-[2.5px] -ml-[11px]" : ""}`)}<span className="flex shrink-0 gap-2">{editButtons}</span>
      </div>, onCancel: () => { if (!cellDisabled) closeEditor(); } } : undefined}
      onClose={() => { setDetails(null); if (detailsEdit) closeEditor(); }}
      onEdit={(field, operation, opener) => { trigger.current = opener; setDraft({}); setInvalid({}); setEditor({ kind: "edit", operation, row: details, field }); }}
      onAction={onCustomAction ? operation => { setDetails(null); onCustomAction(operation.operationId); } : undefined} /> : null}
    {editor && !createInRow && !openEdit ? <form ref={editorForm} aria-label={editor.kind === "edit" ? `Edit ${editor.field.name}` : "New record"} className="rounded-lg border border-line bg-panel p-3" onSubmit={event => { event.preventDefault(); submitEditor(); }}>
      <div className="flex flex-wrap gap-3">{form.map(entry => <div key={entry.field.fieldId} data-field={entry.field.fieldId} className="flex min-w-40 flex-1 flex-col gap-1 text-[12px] text-muted"><span>{entry.field.name}</span>{valueInput(entry)}{fieldError(entry)}</div>)}</div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2"><span className="mr-auto">{formNote}</span><SecondaryButton disabled={disabled} onClick={closeEditor}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={disabled || !formOperation}>{editor.kind === "create" ? "Create record" : "Save"}</PrimaryButton></div>
    </form> : null}
  </section>;
}

type LoadFailure = { words: string; retry(): void; wait: { ms: number; ended: boolean } | null };
const WAIT_ENDED = "The wait has ended.";
/** Records that could not load: why, and Try again, which reads them as the toast's Try again does. A Collection waiting to reopen shows a clock. */
export function CollectionUnavailable({ waiting, words, onRetry }: { waiting: boolean; words: string; onRetry(): void }) {
  return <EmptyState icon={waiting ? Clock : AlertTriangle} tone={waiting ? "ghost" : "danger"} title={words}><SecondaryButton onClick={onRetry}>Try again</SecondaryButton></EmptyState>;
}
