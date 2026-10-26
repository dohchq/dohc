import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Archive, CalendarDays, Check, CheckSquare, ChevronLeft, ChevronRight, Clock, Download, Expand, FileInput, FileSpreadsheet, History, Inbox, LayoutList, MoreHorizontal, PanelsTopLeft, Plus, RefreshCw, Search, Shield, SlidersHorizontal, Square, Table2, Trash2, Undo2, X } from "lucide-react";
import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { DatasetCopyStatus } from "@dohc/cli/dataset";
import type { CollectionTableView } from "./collectionTableViews";
import { readCollectionReopenWait } from "../ipc/errorWords";
import { EmptyState, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { isComposingKey } from "./ui/keys";
import { FieldTypeIcon } from "./collections/FieldTypeIcon";
import { AutomationFieldMark, type FieldMarks } from "./collections/collectionFieldMarks";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CalendarNeedsDateField } from "./collections/CalendarNeedsDateField";
import { CollectionAttachmentCell, CollectionAttachmentInput, CollectionRelationInput } from "./CollectionResourceInputs";
import { TransactionalRecordDetailsDialog } from "./TransactionalRecordDetailsDialog";
import type { CollectionResources, CollectionResourceScope } from "./transactionalCollectionResources";
import {
  display, initialValue, inputProblem, isGeneratedRecordIdField, object, parsePage, supportsInput, supportsSort,
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
type Mutation = { operation: DatasetOperation; input: AppBackendJson; key: string; label: string; undo?: boolean; request?: TransactionalInvoke; invalidated?: boolean };
type Undo = { operation: DatasetOperation; input: AppBackendJson };

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

function ValueInput({ field, value, disabled, onChange }: { field: TransactionalField; value: AppBackendJson; disabled: boolean; onChange(value: AppBackendJson): void }) {
  if (field.type === "checkbox") return <input aria-label={field.name} type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
  if (field.type === "select") return <select aria-label={field.name} value={display(value)} disabled={disabled} onChange={event => onChange(event.target.value || null)} className={selectClass}>
    <option value="">Choose an option</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>;
  if (field.type === "multi-select") return <fieldset disabled={disabled} aria-label={field.name} className="m-0 flex flex-wrap gap-3 border-0 p-0">
    {field.options?.map(option => <label key={option} className="flex items-center gap-1 text-[13px] text-ink"><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={event => {
      const prior = Array.isArray(value) ? value : [];
      onChange(event.target.checked ? [...prior, option] : prior.filter(entry => entry !== option));
    }} />{option}</label>)}</fieldset>;
  return <input aria-label={field.name} disabled={disabled} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
    step={field.type === "number" ? "any" : undefined} value={display(value)} className={inputClass} onChange={event => {
      const raw = event.target.value;
      onChange(field.type === "number" ? raw === "" ? null : Number(raw) : raw === "" && field.type !== "text" ? null : raw);
    }} />;
}
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
  return <span className="truncate text-[13px] text-ink">{display(value) || "—"}</span>;
}

const sameRecord = (a: TransactionalRow, b: TransactionalRow) => JSON.stringify(a.id) === JSON.stringify(b.id);

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
  // A new record is a row of the table when every field it takes is a column.
  const createsInRow = createFields.every(field => fields.includes(field));
  const scope: CollectionResourceScope = { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256 };
  const [localView, setLocalView] = useState<CollectionTableView | null>(null);
  const selectedView = localView ?? props.activeView;
  useLayoutEffect(() => { setLocalView(null); }, [props.activeView]);
  const [page, setPage] = useState<TransactionalPage | null>(null);
  const [busy, setBusy] = useState(false);
  // The last read of records that failed, until a read succeeds: its words, the toast's retry, and the wait a reopening Collection set.
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [visualBusy, setVisualBusy] = useState(false), [visualRefresh, setVisualRefresh] = useState(0), [visualChanged, setVisualChanged] = useState(0);
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
  const detailsOpen = details !== null;
  useEffect(() => { if (!detailsOpen) setDetailsUnavailable(null); }, [detailsOpen]);
  const editorForm = useRef<HTMLFormElement>(null), createRow = useRef<HTMLTableRowElement>(null), addRow = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<Record<string, AppBackendJson>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
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
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; active.current?.abort(); readActive.current?.abort(); openRecordRead.current?.abort(); }; }, []);
  useLayoutEffect(() => { if (editor) (createRow.current ?? editorForm.current)?.querySelector<HTMLElement>("input, select, button")?.focus(); }, [editor]);

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
  const activeViewKey = JSON.stringify([selectedView ?? null, contractKey]);
  useLayoutEffect(() => {
    if (priorContract.current === contractKey) return;
    priorContract.current = contractKey;
    sequence.current++; readActive.current?.abort();
    const change = mutation.current;
    if (change?.request && (change.request.revision !== dataset.revision || change.request.revisionSha256 !== dataset.revisionSha256)) {
      change.invalidated = true; active.current?.abort();
      mutation.current = null; setPending(null); locked.current = false; setBusy(false);
      onError("The Collection's rules changed. Check the records before making another change.", new Error("The Collection's rules changed before this change was confirmed. Check the records before making another change."), null);
    }
    setPage(null); setUndo(null); setEditor(null); setDetails(null);
  }, [contractKey]);
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
   */
  async function reread(): Promise<void> {
    if (!read || !alive.current || locked.current) return;
    readActive.current?.abort();
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current;
    try {
      const response = await invoke(request(read, pageInput(currentQuery.current), crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      const loaded = parsePage(response.result, read.fieldIds);
      setPage(loaded);
      settle();
      showOpenRecord(loaded.rows);
    } catch {
      // Nothing to say: the change happened elsewhere, and the page still shows its last read.
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

  function closeEditor(): void { setEditor(null); setInvalid(null); }
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
      if (!alive.current || abort.signal.aborted) return;
      setUndo(priorContract.current === contractKey ? undoFromReceipt(change, response.result) : null);
      mutation.current = null; setPending(null); closeEditor();
      locked.current = false; setBusy(false);
      onNotice?.(change.undo ? "Reversed the last edit" : change.label);
      if (priorContract.current === contractKey) await load(currentQuery.current);
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) {
        const refused = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "operation_refused";
        if (refused) { mutation.current = null; setPending(null); }
        else closeEditor();
        onError(refused ? "The collection refused this change." : "dohc could not confirm this change.", cause, refused ? null : () => { if (alive.current) void currentExecute.current(change); });
      }
    } finally { if (alive.current && !change.invalidated) { locked.current = false; setBusy(false); } }
  }
  function submitEditor(): void {
    if (!editor || locked.current || resourceLock.current || mutation.current) return;
    // The row has no form to stop a value the browser rejects, such as a half-typed number.
    if (createRow.current && !Array.from(createRow.current.querySelectorAll("input")).every(input => input.reportValidity())) return;
    const editable = editor.kind === "edit" ? [editor.field] : createFields;
    for (const field of editable) {
      const problem = inputProblem(field, draft[field.fieldId] ?? null);
      if (problem) { setInvalid(problem); return; }
    }
    const values = Object.fromEntries(editable.map(field => [field.fieldId, draft[field.fieldId] ?? null]));
    const input: AppBackendJson = editor.kind === "edit" ? { id: editor.row.id, expectedVersion: editor.row.version, values } : { values };
    void execute({ operation: editor.operation, input, key: crypto.randomUUID(), label: editor.kind === "edit" ? "Saved the edit" : "Created a record" });
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
  const disabled = busy || visualBusy || pending !== null || resourceBusy;
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
  if (!table || !read) return <section aria-label="Collection" className="p-4 text-sm text-muted">This collection is unavailable. Ask its owner for access.</section>;
  const editorFields = editor?.kind === "edit" ? [editor.field] : createFields;
  const createInRow = editor?.kind === "create" && !visual && page !== null && createsInRow;
  const columns = fields.length + (props.buttons?.fields.length ?? 0) + 1;
  const openCreate = (opener: HTMLElement) => {
    if (!create) return;
    trigger.current = opener; setDraft(Object.fromEntries(createFields.map(field => [field.fieldId, initialValue(field)]))); setInvalid(null); setEditor({ kind: "create", operation: create });
  };
  const valueInput = (field: TransactionalField) => {
    const input = { field, value: draft[field.fieldId] ?? null, disabled, onChange: (value: AppBackendJson) => { setDraft(current => ({ ...current, [field.fieldId]: value })); setInvalid(null); } };
    return field.type === "attachment" && props.uploadFile ? <CollectionAttachmentInput {...input} scope={scope} upload={props.uploadFile} onError={onError} onBusy={value => {
      if (value) pendingResources.current.add(field.fieldId); else pendingResources.current.delete(field.fieldId);
      resourceLock.current = pendingResources.current.size > 0; setResourceBusy(resourceLock.current);
    }} /> : field.type === "relation" && props.resolveRelation ? <CollectionRelationInput {...input} scope={scope} resolve={props.resolveRelation} onError={onError} /> : <ValueInput {...input} />;
  };
  const canCreateForm = props.onCreateForm && operations.some(operation => operation.kind === "create" && operation.access === "link" && !operation.readOnly);
  const savedPages = props.copy && "coverage" in props.copy && props.copy.coverage === "saved-pages";
  const hasManagement = props.onCustomize || props.onReviewSchema || props.onManageAccess || props.onExportRecovery || props.onTransferCsv || props.onHistory || props.onPendingResponses || props.onArchive;
  return <section aria-label={table.name} aria-busy={busy} className="flex h-full min-h-0 flex-col gap-3 p-4">
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
    {props.copy ? <span role="status" className="text-[12px] text-muted">{savedPages ? "Offline · Saved pages only" : props.copy.offline ? "Offline copy · Read-only" : "Saved on this device"} · {new Date(props.copy.savedAtMs).toLocaleString()}</span> : null}
    {pending && !busy ? <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><span>Change not confirmed</span><span>Browse records while you wait. Retry this change before making another.</span><SecondaryButton onClick={() => void execute(pending)}>Try again</SecondaryButton></div> : null}
    {/* Lines stand in only for records not yet shown; a page already shown keeps its records and says it is loading. */}
    {busy ? pending || page ? <p role="status" className="m-0 text-[12px] text-muted">{pending ? "Saving…" : "Loading records…"}</p> : <SkeletonRows label="Loading records…" /> : null}
    {visual && shownView?.kind === "calendar" && !shownView.dateField ? <CalendarNeedsDateField disabled={writeDisabled || editor !== null} onAddDateField={props.onAddDateField} />
    : visual && shownView ? <Suspense fallback={<SkeletonRows label="Opening view…" />}><TransactionalCollectionViews key={JSON.stringify([activeViewKey,query.search])} view={shownView} fields={fields} search={query.search} refresh={visualRefresh} changed={visualChanged} onReadInPlace={showOpenRecord}
      disabled={busy || pending !== null || resourceBusy || editor !== null} onBusy={setVisualBusy} onError={failLoad} onLoaded={settle}
      read={(input,signal)=>invoke(request(read,input,crypto.randomUUID()),signal)}
      onOpen={row=>{trigger.current=document.activeElement instanceof HTMLElement ? document.activeElement : null;setDetails(row);}}
      canMove={fieldId=>!props.copy?.offline&&operations.some(operation=>operation.kind==="edit"&&!operation.readOnly&&operation.fieldIds.includes(fieldId))}
      onMove={(row,fieldId,value)=>{const operation=operations.find(operation=>operation.kind==="edit"&&!operation.readOnly&&operation.fieldIds.includes(fieldId));if(!operation||disabled)return;
        void execute({operation,input:{id:row.id,expectedVersion:row.version,values:{[fieldId]:value}},key:crypto.randomUUID(),label:"Moved the record"});}} /></Suspense> : null}
    {failure && !busy && !visualBusy && (visual || !page) ? <CollectionUnavailable waiting={failure.wait !== null} words={failure.wait?.ended ? WAIT_ENDED : failure.words} onRetry={failure.retry} /> : null}
    {/* The table always shows its columns, so an empty Collection already says what a record holds. */}
    {!visual && page ? <div className="min-h-0 overflow-auto"><table className="w-full border-collapse text-[13px]">
      <thead className="sticky top-0 bg-bg"><tr>{fields.map(field => <th key={field.fieldId} scope="col" aria-sort={query.sort?.fieldId === field.fieldId ? query.sort.direction === "asc" ? "ascending" : "descending" : undefined} className="border-b border-line px-3 py-2 text-left font-medium text-muted">
        <span className="flex items-center gap-1.5">{supportsSort(field) ? <button type="button" disabled={readDisabled || editor !== null} className="flex items-center gap-1.5 text-left" onClick={() => void load({ ...query, after: null, sort: { fieldId: field.fieldId, direction: query.sort?.fieldId === field.fieldId && query.sort.direction === "asc" ? "desc" : "asc" } }, [])}><FieldTypeIcon type={field.type} />{field.name}{query.sort?.fieldId === field.fieldId ? query.sort.direction === "asc" ? " ↑" : " ↓" : ""}</button> : <><FieldTypeIcon type={field.type} />{field.name}</>}
        {props.fieldMarks?.has(field.name) ? <AutomationFieldMark automations={props.fieldMarks.get(field.name)!} /> : null}</span>
      </th>)}{props.buttons?.fields.map(field => <th key={`button:${field}`} scope="col" className="border-b border-line px-3 py-2 text-left font-medium text-muted"><span className="block truncate">{field}</span></th>)}<th scope="col" className="border-b border-line"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{page.rows.map(row => <tr key={JSON.stringify(row.id)} className="border-b border-line last:border-0 hover:bg-hover">{fields.map(field => {
        const edit = operations.find(operation => operation.kind === "edit" && !operation.readOnly && operation.fieldIds.includes(field.fieldId));
        const attachment = field.type === "attachment" && typeof row.values[field.fieldId] === "string" && props.readFile && !props.copy?.offline;
        return <td key={field.fieldId} className="max-w-72 px-3 py-2 text-ink">{attachment ? <CollectionAttachmentCell key={String(row.values[field.fieldId])} scope={scope} fieldName={field.name} fileId={String(row.values[field.fieldId])} disabled={disabled || editor !== null} read={(request, signal) => props.readFile!({ ...request, read: { operationId: read!.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value: row.values[field.fieldId]! }] } } }, signal)} onError={onError} /> : null}{edit && canInput(field) ? <button type="button" aria-label={`Edit ${field.name} for record ${row.id}`} disabled={disabled || editor !== null} className="block w-full truncate rounded text-left" onClick={event => {
          trigger.current = event.currentTarget; setDraft({ [field.fieldId]: row.values[field.fieldId] ?? null }); setInvalid(null); setEditor({ kind: "edit", operation: edit, row, field });
        }}>{field.type === "attachment" ? "Change file" : <Cell field={field} value={row.values[field.fieldId]} />}</button> : attachment ? null : field.type === "attachment" && row.values[field.fieldId] && props.copy?.offline ? <span className="text-[13px] text-muted">File available when online</span> : <Cell field={field} value={row.values[field.fieldId]} />}</td>;
      })}{props.buttons?.fields.map(field => <td key={`button:${field}`} className="max-w-72 px-3 py-2">{props.buttons!.render(field, row)}</td>)}<td className="px-3 py-2"><div className="flex justify-end gap-2"><IconButton title="Record details" aria-label={`Open record ${row.id}`} disabled={disabled || editor !== null} onClick={event => { trigger.current = event.currentTarget; setDetails(row); }}><Expand size={15} strokeWidth={1.9} aria-hidden /></IconButton>{remove && confirmDelete ? <IconButton title="Delete record" aria-label={`Delete record ${row.id}`} disabled={disabled || editor !== null} onClick={() => void deleteRecord(row)}><Trash2 size={15} strokeWidth={1.9} aria-hidden /></IconButton> : null}</div></td></tr>)}
      {page.rows.length === 0 && (query.search || !canCreate) ? <tr><td colSpan={columns} className="px-3 py-2 text-muted">{query.search ? "No records match. Try a shorter search." : "No records yet. Refresh to check for new submissions."}</td></tr> : null}
      {createInRow ? <tr ref={createRow} aria-label="New record" className="border-b border-line" onKeyDown={event => {
        if (event.defaultPrevented || isComposingKey(event)) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeEditor(); }
        else if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox" && event.target.type !== "file") { event.preventDefault(); submitEditor(); }
      }}>{fields.map(field => <td key={field.fieldId} className="max-w-72 px-3 py-1.5 align-top">{createFields.includes(field) ? valueInput(field) : null}</td>)}{props.buttons?.fields.map(field => <td key={`button:${field}`} />)}<td className="px-3 py-1.5 align-top"><div className="flex justify-end gap-2">
        <IconButton title="Cancel" aria-label="Cancel" disabled={disabled} onClick={closeEditor}><X size={15} strokeWidth={1.9} aria-hidden /></IconButton>
        <IconButton title="Create record" aria-label="Create record" disabled={disabled} onClick={submitEditor}><Check size={15} strokeWidth={1.9} aria-hidden /></IconButton>
      </div></td></tr> : null}
      {createInRow && invalid ? <tr><td colSpan={columns} role="alert" className="px-3 py-1.5 text-[12px] text-danger">{invalid}</td></tr> : null}
      {canCreate && !createInRow ? <tr><td colSpan={columns} className="p-0"><button ref={addRow} type="button" disabled={writeDisabled || editor !== null} className="flex h-9 w-full items-center gap-1.5 px-3 text-left text-[13px] text-subtle transition-colors hover:text-ink focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50" onClick={event => openCreate(event.currentTarget)}><Plus size={14} strokeWidth={1.9} aria-hidden />New record</button></td></tr> : null}
    </tbody>
    </table></div> : null}
    {!visual && page && (page.rows.length > 0 || previous.length > 0) ? <footer className="flex items-center justify-between gap-2 text-[12px] text-muted"><span className="font-mono">{page.rows.length} {page.rows.length === 1 ? "record" : "records"} on this page</span><div className="flex gap-2"><IconButton aria-label="Previous" title="Previous page" disabled={readDisabled || editor !== null || previous.length === 0} onClick={() => void load({ ...query, after: previous.at(-1) ?? null }, previous.slice(0, -1))}><ChevronLeft size={16} strokeWidth={1.9} aria-hidden /></IconButton><IconButton aria-label="Next" title="Next page" disabled={readDisabled || editor !== null || page.nextCursor === null} onClick={() => void load({ ...query, after: page.nextCursor }, [...previous, query.after])}><ChevronRight size={16} strokeWidth={1.9} aria-hidden /></IconButton></div></footer> : null}
    {details ? <TransactionalRecordDetailsDialog scope={scope} row={details} unavailable={detailsUnavailable?.id === JSON.stringify(details.id) ? detailsUnavailable.text : undefined} fields={fields} readOperation={read} operations={operations} readFile={props.readFile} offline={props.copy?.offline} disabled={disabled} canEdit={canInput} onError={onError} buttons={props.buttons} fieldMarks={props.fieldMarks}
      onClose={() => setDetails(null)}
      onEdit={(field, operation) => { setDetails(null); setDraft({ [field.fieldId]: details.values[field.fieldId] ?? null }); setInvalid(null); setEditor({ kind: "edit", operation, row: details, field }); }}
      onAction={onCustomAction ? operation => { setDetails(null); onCustomAction(operation.operationId); } : undefined} /> : null}
    {editor && !createInRow ? <form ref={editorForm} aria-label={editor.kind === "edit" ? `Edit ${editor.field.name}` : "New record"} className="rounded-lg border border-line bg-panel p-3" onSubmit={event => { event.preventDefault(); submitEditor(); }}>
      <div className="flex flex-wrap gap-3">{editorFields.map(field => <div key={field.fieldId} className="flex min-w-40 flex-1 flex-col gap-1 text-[12px] text-muted"><span>{field.name}</span>{valueInput(field)}</div>)}</div>
      {invalid ? <p role="alert" className="text-[12px] text-danger">{invalid}</p> : null}<div className="mt-3 flex justify-end gap-2"><SecondaryButton disabled={disabled} onClick={closeEditor}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={disabled}>{editor.kind === "create" ? "Create record" : "Save"}</PrimaryButton></div>
    </form> : null}
  </section>;
}

type LoadFailure = { words: string; retry(): void; wait: { ms: number; ended: boolean } | null };
const WAIT_ENDED = "The wait has ended.";
/** Records that could not load: why, and Try again, which reads them as the toast's Try again does. A Collection waiting to reopen shows a clock. */
export function CollectionUnavailable({ waiting, words, onRetry }: { waiting: boolean; words: string; onRetry(): void }) {
  return <EmptyState icon={waiting ? Clock : AlertTriangle} tone={waiting ? "ghost" : "danger"} title={words}><SecondaryButton onClick={onRetry}>Try again</SecondaryButton></EmptyState>;
}
