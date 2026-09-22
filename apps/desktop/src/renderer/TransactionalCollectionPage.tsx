import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { DatasetCopyStatus } from "@dohc/cli/dataset";
import type { CollectionTableView } from "./collectionTableViews";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CollectionAttachmentCell, CollectionAttachmentInput, CollectionRelationInput } from "./CollectionResourceInputs";
import { TransactionalRecordDetailsDialog } from "./TransactionalRecordDetailsDialog";
import type { CollectionResources, CollectionResourceScope } from "./transactionalCollectionResources";
import {
  display, initialValue, inputProblem, object, parsePage, supportsInput, supportsSort,
  type TransactionalCursor, type TransactionalDatasetDescription, type TransactionalField, type TransactionalPage, type TransactionalRow,
} from "./transactionalCollectionModel";

export type { TransactionalDatasetDescription, TransactionalRow } from "./transactionalCollectionModel";
export interface TransactionalInvoke {
  workspaceId: string;
  datasetId: string;
  revision: number;
  revisionSha256: string;
  operationId: string;
  input: AppBackendJson;
  idempotencyKey: string;
}
export interface TransactionalCollectionPageProps extends CollectionResources {
  activeView?: CollectionTableView | null;
  viewControls?(disabled: boolean): ReactNode;
  copy?: DatasetCopyStatus;
  onRefresh?(): void;
  recordsVersion?: number;
  workspaceId: string;
  dataset: TransactionalDatasetDescription;
  tableId: string;
  invoke(request: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
  onNotice?(message: string): void;
  /** Shell-owned confirmation states the real recovery path before deletion. */
  confirmDelete?(row: TransactionalRow): Promise<boolean>;
  onCustomAction?(operationId: string): void;
  onCreateForm?(): void;
  onTransferCsv?(): void;
  onHistory?(): void;
  onPendingResponses?(): void;
  onReviewSchema?(): void;
  onManageAccess?(): void;
  onExportRecovery?(): void;
  onArchive?(): void;
}
type Query = { after: TransactionalCursor | null; search: string; filters?: Array<{ fieldId: string; value: AppBackendJson }>; sort?: { fieldId: string; direction: "asc" | "desc" } };
type Editor = { kind: "create"; operation: DatasetOperation } | { kind: "edit"; operation: DatasetOperation; row: TransactionalRow; field: TransactionalField };
type Mutation = { operation: DatasetOperation; input: AppBackendJson; key: string; label: string; undo?: boolean; request?: TransactionalInvoke };
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
  if (!supportsInput(field)) return <span className="truncate text-[13px] text-ink">{display(value) || "—"}</span>;
  if (field.type === "checkbox") return <span className="text-[13px] text-ink">{value === true ? "Yes" : value === false ? "No" : "—"}</span>;
  return <span className="truncate text-[13px] text-ink">{display(value) || "—"}</span>;
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
  const fields = table?.fields.filter(field => read?.fieldIds.includes(field.fieldId)) ?? [];
  const createFields = table?.fields.filter(field => create?.fieldIds.includes(field.fieldId)) ?? [];
  const canInput = (field: TransactionalField) => supportsInput(field) || (field.type === "attachment" && !!props.uploadFile) || (field.type === "relation" && !!field.relation && !!props.resolveRelation);
  const canCreate = create && createFields.every(canInput);
  const scope: CollectionResourceScope = { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256 };
  const [page, setPage] = useState<TransactionalPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<Query>({ after: null, search: "" });
  const [previous, setPrevious] = useState<Array<TransactionalCursor | null>>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [details, setDetails] = useState<TransactionalRow | null>(null);
  const editorForm = useRef<HTMLFormElement>(null);
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
  const loadedVersion = useRef(props.recordsVersion);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; active.current?.abort(); readActive.current?.abort(); }; }, []);
  useLayoutEffect(() => { if (editor) editorForm.current?.querySelector<HTMLElement>("input, select, button")?.focus(); }, [editor]);

  function request(operation: DatasetOperation, input: AppBackendJson, key: string): TransactionalInvoke {
    return { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, operationId: operation.operationId, input, idempotencyKey: key };
  }
  async function load(next: Query, history = previous): Promise<void> {
    if (!read || !alive.current) return;
    setDetails(null);
    readActive.current?.abort();
    const abort = new AbortController(); readActive.current = abort;
    const mine = ++sequence.current;
    locked.current = true; setBusy(true);
    try {
      const input: Record<string, AppBackendJson> = { limit: 50 };
      if (next.after) input.after = { id: next.after.id, value: next.after.value };
      if (next.search) input.search = next.search;
      if (next.filters?.length) input.filters = next.filters;
      if (next.sort) input.sort = { ...next.sort };
      const response = await invoke(request(read, input, crypto.randomUUID()), abort.signal);
      if (!alive.current || sequence.current !== mine || abort.signal.aborted) return;
      setPage(parsePage(response.result, read.fieldIds)); setQuery(next); setPrevious(history);
    } catch (cause) {
      if (alive.current && sequence.current === mine && !abort.signal.aborted) {
        setPage(null);
        onError(`dohc could not load ${table?.name ?? "this collection"}.`, cause, () => { if (alive.current) void load(next, history); });
      }
    } finally {
      if (alive.current && sequence.current === mine) { locked.current = false; setBusy(false); }
    }
  }
  const contractKey = JSON.stringify([dataset.revision, dataset.revisionSha256, dataset.operations, props.copy?.offline ?? false]);
  const priorContract = useRef(contractKey);
  const activeViewKey = JSON.stringify([props.activeView ?? null, contractKey]);
  useLayoutEffect(() => {
    if (priorContract.current === contractKey) return;
    priorContract.current = contractKey;
    sequence.current++; readActive.current?.abort();
    setPage(null); setUndo(null); setEditor(null); setDetails(null);
  }, [contractKey]);
  useEffect(() => {
    const view = props.activeView;
    setPage(null);
    setSearch(view?.search ?? "");
    void load({ after: null, search: view?.search ?? "", filters: view?.filters, sort: view?.sort ?? undefined }, []);
  }, [activeViewKey]);
  useEffect(() => {
    if (loadedVersion.current === props.recordsVersion || busy || editor || resourceBusy) return;
    loadedVersion.current = props.recordsVersion;
    void load(currentQuery.current);
  }, [props.recordsVersion, pending, editor, resourceBusy, busy]);

  function closeEditor(): void { setEditor(null); setInvalid(null); trigger.current?.focus(); }
  async function execute(change: Mutation): Promise<void> {
    if (props.copy?.offline) return;
    if (!alive.current || locked.current || (mutation.current && mutation.current !== change)) return;
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
        onError(refused ? "The collection refused this change." : "dohc could not confirm this change.", cause, refused ? null : () => { if (alive.current) void execute(change); });
      }
    } finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  function submitEditor(): void {
    if (!editor || locked.current || resourceLock.current || mutation.current) return;
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
  const disabled = busy || pending !== null || resourceBusy;
  const readDisabled = busy || resourceBusy;
  if (!table || !read) return <section aria-label="Collection" className="p-4 text-sm text-muted">This collection is unavailable. Ask its owner for access.</section>;
  const editorFields = editor?.kind === "edit" ? [editor.field] : createFields;
  const canCreateForm = props.onCreateForm && operations.some(operation => operation.kind === "create" && operation.access === "link" && !operation.readOnly);
  const hasManagement = props.onReviewSchema || props.onManageAccess || props.onExportRecovery || canCreateForm || props.onTransferCsv || props.onHistory || props.onPendingResponses || props.onArchive;
  return <section aria-label={table.name} aria-busy={busy} className="flex h-full min-h-0 flex-col gap-3 p-4">
    <header className="flex items-center justify-between gap-3"><h2 className="m-0 min-w-0 truncate text-sm font-semibold text-ink">{table.name}</h2>
      {canCreate ? <PrimaryButton className="shrink-0" disabled={disabled || editor !== null} onClick={event => { trigger.current = event.currentTarget; setDraft(Object.fromEntries(createFields.map(field => [field.fieldId, initialValue(field)]))); setInvalid(null); setEditor({ kind: "create", operation: create }); }}>New record</PrimaryButton> : null}
    </header>
    <div className="flex flex-wrap items-center gap-2">
      {props.viewControls?.(disabled || editor !== null)}
      {onCustomAction ? operations.filter(operation => operation.kind === "action").map(operation => <SecondaryButton key={operation.operationId} disabled={disabled} onClick={() => onCustomAction(operation.operationId)}>{operation.label}</SecondaryButton>) : null}
      {undo && !props.copy?.offline ? <SecondaryButton disabled={disabled} onClick={() => void execute({ ...undo, key: crypto.randomUUID(), label: "Reversed the last edit", undo: true })}>Undo last edit</SecondaryButton> : null}
      {hasManagement ? <details className="group relative" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); event.stopPropagation(); } }}>
        <summary aria-label="Manage Collection" className="flex cursor-pointer list-none items-center gap-1 rounded-lg border border-line bg-transparent px-2.5 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-ink [&::-webkit-details-marker]:hidden">
          <MoreHorizontal size={14} aria-hidden /> <span>Manage</span>
        </summary>
        <div className="dohc-popover absolute left-0 top-9 z-20 flex min-w-48 flex-col gap-1 rounded-lg border border-line bg-panel p-1">
          {props.onReviewSchema ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onReviewSchema}>Fields and names</SecondaryButton> : null}
          {props.onManageAccess ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onManageAccess}>Manage access</SecondaryButton> : null}
          {props.onExportRecovery ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onExportRecovery}>Export recovery</SecondaryButton> : null}
          {canCreateForm ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onCreateForm}>Create form</SecondaryButton> : null}
          {props.onTransferCsv ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onTransferCsv}>Import or export CSV</SecondaryButton> : null}
          {props.onHistory ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onHistory}>History</SecondaryButton> : null}
          {props.onPendingResponses ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onPendingResponses}>Pending responses</SecondaryButton> : null}
          {props.onArchive ? <SecondaryButton className="w-full text-left" disabled={disabled || editor !== null} onClick={props.onArchive}>Archive</SecondaryButton> : null}
        </div>
      </details> : null}
    </div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void load({ ...query, after: null, search }, []); }}>
      <input aria-label="Search collection" type="search" maxLength={200} className={inputClass} value={search} disabled={readDisabled || editor !== null} onChange={event => setSearch(event.target.value)} />
      <SecondaryButton type="submit" disabled={readDisabled || editor !== null}>Search</SecondaryButton><SecondaryButton disabled={readDisabled || editor !== null} onClick={() => props.onRefresh ? props.onRefresh() : void load(query)}>Refresh</SecondaryButton>
      {props.copy ? <span role="status" className="self-center text-[12px] text-muted">{props.copy.offline ? "Offline copy · Read-only" : "Saved on this device"} · {new Date(props.copy.savedAtMs).toLocaleString()}</span> : null}
    </form>
    {pending && !busy ? <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><span>Change not confirmed</span><span>Browse records while you wait. Retry this change before making another.</span><SecondaryButton onClick={() => void execute(pending)}>Try again</SecondaryButton></div> : null}
    {busy ? <p role="status" className="m-0 text-[12px] text-muted">{pending ? "Saving…" : "Loading records…"}</p> : null}
    {page && page.rows.length === 0 ? <p className="m-0 text-sm text-muted">{query.search ? "No records match. Try a shorter search." : canCreate ? "No records yet. Add a record to start." : "No records yet. Refresh to check for new submissions."}</p> : null}
    {page && page.rows.length > 0 ? <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line"><table className="w-full border-collapse text-[13px]">
      <thead className="sticky top-0 bg-panel"><tr>{fields.map(field => <th key={field.fieldId} scope="col" aria-sort={query.sort?.fieldId === field.fieldId ? query.sort.direction === "asc" ? "ascending" : "descending" : undefined} className="border-b border-line px-3 py-2 text-left font-medium text-muted">
        {supportsSort(field) ? <button type="button" disabled={readDisabled || editor !== null} className="text-left" onClick={() => void load({ ...query, after: null, sort: { fieldId: field.fieldId, direction: query.sort?.fieldId === field.fieldId && query.sort.direction === "asc" ? "desc" : "asc" } }, [])}>{field.name}{query.sort?.fieldId === field.fieldId ? query.sort.direction === "asc" ? " ↑" : " ↓" : ""}</button> : field.name}
      </th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{page.rows.map(row => <tr key={JSON.stringify(row.id)} className="border-b border-line last:border-0 hover:bg-panel-2/60">{fields.map(field => {
        const edit = operations.find(operation => operation.kind === "edit" && !operation.readOnly && operation.fieldIds.includes(field.fieldId));
        const attachment = field.type === "attachment" && typeof row.values[field.fieldId] === "string" && props.readFile;
        return <td key={field.fieldId} className="max-w-72 px-3 py-2 text-ink">{attachment ? <CollectionAttachmentCell key={String(row.values[field.fieldId])} scope={scope} fieldName={field.name} fileId={String(row.values[field.fieldId])} disabled={disabled || editor !== null} read={(request, signal) => props.readFile!({ ...request, read: { operationId: read!.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value: row.values[field.fieldId]! }] } } }, signal)} onError={onError} /> : null}{edit && canInput(field) ? <button type="button" aria-label={`Edit ${field.name} for record ${row.id}`} disabled={disabled || editor !== null} className="block w-full truncate rounded text-left" onClick={event => {
          trigger.current = event.currentTarget; setDraft({ [field.fieldId]: row.values[field.fieldId] ?? null }); setInvalid(null); setEditor({ kind: "edit", operation: edit, row, field });
        }}>{field.type === "attachment" ? "Change file" : field.type === "checkbox" ? row.values[field.fieldId] === true ? "Yes" : row.values[field.fieldId] === false ? "No" : "—" : display(row.values[field.fieldId]) || "—"}</button> : attachment ? null : <Cell field={field} value={row.values[field.fieldId]} />}</td>;
      })}<td className="px-3 py-2"><div className="flex gap-2"><SecondaryButton size="compact" aria-label={`Open record ${row.id}`} disabled={disabled || editor !== null} onClick={event => { trigger.current = event.currentTarget; setDetails(row); }}>Details</SecondaryButton>{remove && confirmDelete ? <SecondaryButton size="compact" aria-label={`Delete record ${row.id}`} disabled={disabled || editor !== null} onClick={() => void deleteRecord(row)}>Delete</SecondaryButton> : null}</div></td></tr>)}</tbody>
    </table></div> : null}
    {page ? <footer className="flex items-center justify-between gap-2 text-[12px] text-muted"><span>{page.rows.length} records on this page</span><div className="flex gap-2"><SecondaryButton disabled={readDisabled || editor !== null || previous.length === 0} onClick={() => void load({ ...query, after: previous.at(-1) ?? null }, previous.slice(0, -1))}>Previous</SecondaryButton><SecondaryButton disabled={readDisabled || editor !== null || page.nextCursor === null} onClick={() => void load({ ...query, after: page.nextCursor }, [...previous, query.after])}>Next</SecondaryButton></div></footer> : null}
    {details ? <TransactionalRecordDetailsDialog scope={scope} row={details} fields={fields} readOperation={read} operations={operations} readFile={props.readFile} offline={props.copy?.offline} disabled={disabled} canEdit={canInput} onError={onError}
      onClose={() => { setDetails(null); trigger.current?.focus(); }}
      onEdit={(field, operation) => { setDetails(null); setDraft({ [field.fieldId]: details.values[field.fieldId] ?? null }); setInvalid(null); setEditor({ kind: "edit", operation, row: details, field }); }}
      onAction={onCustomAction ? operation => { setDetails(null); onCustomAction(operation.operationId); } : undefined} /> : null}
    {editor ? <form ref={editorForm} aria-label={editor.kind === "edit" ? `Edit ${editor.field.name}` : "New record"} className="rounded-lg border border-line bg-panel p-3" onSubmit={event => { event.preventDefault(); submitEditor(); }}>
      <div className="flex flex-wrap gap-3">{editorFields.map(field => {
        const input = { field, value: draft[field.fieldId] ?? null, disabled, onChange: (value: AppBackendJson) => { setDraft(current => ({ ...current, [field.fieldId]: value })); setInvalid(null); } };
        return <div key={field.fieldId} className="flex min-w-40 flex-1 flex-col gap-1 text-[12px] text-muted"><span>{field.name}</span>{field.type === "attachment" && props.uploadFile ? <CollectionAttachmentInput {...input} scope={scope} upload={props.uploadFile} onError={onError} onBusy={value => {
          if (value) pendingResources.current.add(field.fieldId); else pendingResources.current.delete(field.fieldId);
          resourceLock.current = pendingResources.current.size > 0; setResourceBusy(resourceLock.current);
        }} /> : field.type === "relation" && props.resolveRelation ? <CollectionRelationInput {...input} scope={scope} resolve={props.resolveRelation} onError={onError} /> : <ValueInput {...input} />}</div>;
      })}</div>
      {invalid ? <p role="alert" className="text-[12px] text-danger">{invalid}</p> : null}<div className="mt-3 flex justify-end gap-2"><SecondaryButton disabled={disabled} onClick={closeEditor}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={disabled}>{editor.kind === "create" ? "Create record" : "Save"}</PrimaryButton></div>
    </form> : null}
  </section>;
}
