import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass } from "./collections/FieldForm";

export interface CreateDatasetFormInput {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  tableId: string;
  createOperationId: string;
  appRoot: string;
  title: string;
  fieldIds: string[];
}
export interface CreateDatasetFormDialogProps {
  workspaceId: string;
  dataset: DatasetDescription;
  tableId: string;
  onClose(): void;
  onCreate(input: CreateDatasetFormInput, signal: AbortSignal): Promise<void>;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}

export function CreateDatasetFormDialog(props: CreateDatasetFormDialogProps) {
  return <ScopedCreateForm key={JSON.stringify([props.workspaceId, props.dataset, props.tableId])} {...props} />;
}

function ScopedCreateForm(props: CreateDatasetFormDialogProps) {
  const { dataset, tableId } = props;
  const table = dataset.tables.find(candidate => candidate.tableId === tableId);
  const operations = dataset.operations.filter(operation => operation.tableId === tableId && operation.kind === "create" && operation.access === "link" && !operation.readOnly);
  const [operationId, setOperationId] = useState(operations[0]?.operationId ?? "");
  const create = operations.find(operation => operation.operationId === operationId);
  const allowed = table?.fields.filter(field => create?.fieldIds.includes(field.fieldId)) ?? [];
  const required = allowed.filter(field => field.required && !Object.hasOwn(field, "default"));
  const [selected, setSelected] = useState<string[]>(() => allowed.filter(field => field.type !== "relation" || required.includes(field)).map(field => field.fieldId));
  const [appRoot, setAppRoot] = useState(`${dataset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-form`);
  const [title, setTitle] = useState(dataset.name);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  useEffect(() => { first.current?.focus(); }, []);

  async function execute(input: CreateDatasetFormInput): Promise<void> {
    if (!alive.current || locked.current) return;
    const abort = new AbortController(); active.current = abort;
    locked.current = true; setPending(true); setInvalid(null);
    try { await props.onCreate(input, abort.signal); }
    catch (cause) {
      if (alive.current && !abort.signal.aborted) props.onError("dohc could not create this form.", cause, () => { if (alive.current) void execute(input); });
    } finally { if (alive.current) { locked.current = false; setPending(false); } }
  }
  function submit(): void {
    if (!create || locked.current) return;
    const root = appRoot.trim(), formTitle = title.trim();
    if (!isShareablePath(root) || !/^[A-Za-z0-9_@./-]+$/.test(root) || root.length > 900) { setInvalid("Choose a workspace folder for the form."); return; }
    if (!formTitle || formTitle.length > 200 || /[\u0000-\u001f\u007f]/u.test(formTitle)) { setInvalid("Use a form title with 1 to 200 characters."); return; }
    if (!selected.length || selected.length > 24) { setInvalid("Show 1 to 24 fields on the form."); return; }
    if (required.some(field => !selected.includes(field.fieldId))) { setInvalid("Show every required field on the form."); return; }
    const fields = allowed.filter(field => selected.includes(field.fieldId));
    if (fields.some(field => field.type === "relation")) { setInvalid("This form builder cannot select related records yet. Use a custom app for this field."); return; }
    if (fields.filter(field => field.type === "attachment").length > 1) { setInvalid("This form builder supports 1 file field. Use a custom app for more files."); return; }
    void execute({ datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, tableId, createOperationId: create.operationId, appRoot: root, title: formTitle, fieldIds: [...selected] });
  }
  if (!table || !create) return <Overlay onClose={props.onClose}><div className="dohc-elevated w-130 max-w-[85vw] rounded-xl border border-line bg-panel p-5"><h2 className="m-0 text-sm font-semibold text-ink">Create form</h2><p className="mt-2 text-[13px] text-muted">This collection has no approved public create action.</p><SecondaryButton className="mt-3" onClick={props.onClose}>Close</SecondaryButton></div></Overlay>;
  return <Overlay onClose={pending ? undefined : props.onClose}><form onSubmit={event => { event.preventDefault(); submit(); }} data-testid="create-dataset-form-dialog" className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-130 max-w-[85vw] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-5">
    <div><h2 className="m-0 text-sm font-semibold text-ink">Create form</h2><p className="m-0 text-[12px] text-muted">{dataset.name} · {table.name}</p></div>
    <label className="text-[12px] text-muted">Form title<input ref={first} aria-label="Form title" value={title} maxLength={200} disabled={pending} className={`${inputClass} mt-1`} onChange={event => setTitle(event.target.value)} /></label>
    <label className="text-[12px] text-muted">App folder<input aria-label="App folder" value={appRoot} disabled={pending} className={`${inputClass} mt-1 font-mono`} onChange={event => setAppRoot(event.target.value)} /><span className="mt-1 block text-[11px] text-subtle">The form source stays in this workspace folder.</span></label>
    {operations.length > 1 ? <label className="text-[12px] text-muted">Create action<select aria-label="Create action" value={operationId} disabled={pending} className={`${selectClass} mt-1`} onChange={event => {
      const next = operations.find(operation => operation.operationId === event.target.value)!;
      setOperationId(next.operationId); setSelected(table.fields.filter(field => next.fieldIds.includes(field.fieldId) && (field.type !== "relation" || (field.required && !Object.hasOwn(field, "default")))).map(field => field.fieldId)); setInvalid(null);
    }}>{operations.map(operation => <option key={operation.operationId} value={operation.operationId}>{operation.label}</option>)}</select></label> : null}
    <fieldset disabled={pending} className="m-0 flex flex-col gap-2 border-0 p-0"><legend className="text-[12px] font-medium text-ink">Fields shown on form</legend>
      <p className="m-0 text-[11px] text-muted">This form can submit only these fields.</p>
      {allowed.map(field => <label key={field.fieldId} className="flex items-center gap-2 text-[13px] text-ink"><input aria-label={field.name} type="checkbox" checked={selected.includes(field.fieldId)} disabled={required.includes(field) || field.type === "relation"} onChange={event => setSelected(current => event.target.checked ? [...current, field.fieldId] : current.filter(id => id !== field.fieldId))} />{field.name}{field.type === "attachment" ? " (file)" : ""}{required.includes(field) ? <span className="text-[11px] text-subtle">Required</span> : null}{field.type === "relation" ? <span className="text-[11px] text-muted">Needs a custom app</span> : null}</label>)}
    </fieldset>
    {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}
    <div className="flex justify-end gap-2"><SecondaryButton disabled={pending} onClick={props.onClose}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={pending}>{pending ? "Creating…" : "Create form"}</PrimaryButton></div>
  </form></Overlay>;
}
