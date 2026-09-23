import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DATASET_MAX_FIELDS, type DatasetDescription, type DatasetField } from "@dohc/security-contract/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { APP_BACKEND_OPERATION_FILES } from "@dohc/security-contract/app-backend";
import { FileCode2, LockKeyhole } from "lucide-react";
import { DatasetFormPreview } from "./collections/CreationPreview";
import { FieldTypeIcon } from "./collections/FieldTypeIcon";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass } from "./collections/FieldForm";
import { CollectionMigrationReviewDialog, type CollectionMigrationReviewDialogProps, type DatasetMigrationPreparation } from "./CollectionMigrationReviewDialog";

export interface CreateDatasetFormInput {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  tableId: string;
  createOperationId: string;
  appRoot: string;
  title: string;
  fieldIds: string[];
  relationChoices?: Array<{ fieldId: string; operationId: string; labelFieldId: string }>;
}
export interface CreateDatasetFormDialogProps {
  workspaceId: string;
  dataset: DatasetDescription;
  tableId: string;
  onClose(): void;
  onCreate(input: CreateDatasetFormInput, signal: AbortSignal): Promise<void>;
  onLoadSource?(signal: AbortSignal): Promise<{ path: string; source: string; sha256: string }>;
  onPrepareChoices?(input: { fieldId: string; labelFieldId: string }, signal: AbortSignal): Promise<DatasetMigrationPreparation>;
  onApproveChoices?: CollectionMigrationReviewDialogProps["onApprove"];
  onDiscardChoices?: CollectionMigrationReviewDialogProps["onDiscard"];
  onLoadPreview?: CollectionMigrationReviewDialogProps["onLoadPreview"];
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
  const [relationChoices, setRelationChoices] = useState<NonNullable<CreateDatasetFormInput["relationChoices"]>>([]);
  function choiceActions(field: Omit<DatasetField, "sqlColumn">) {
    const relation = field.relation;
    if (!relation || relation.datasetId !== dataset.datasetId) return [];
    const target = dataset.tables.find(candidate => candidate.tableId === relation.tableId);
    return dataset.operations.filter(action => action.kind === "read" && action.readOnly && action.access === "link" && action.tableId === relation.tableId && action.fieldIds.includes(relation.fieldId))
      .flatMap(action => (target?.fields ?? []).filter(label => ["text", "number", "select"].includes(label.type) && action.fieldIds.includes(label.fieldId) &&
        action.fieldIds.every(id => id === relation.fieldId || id === label.fieldId)).map(label => ({ action, label })));
  }
  const [appRoot, setAppRoot] = useState(`${dataset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-form`);
  const [title, setTitle] = useState(dataset.name);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [source, setSource] = useState<{ path: string; source: string; sha256: string } | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [publicLabels, setPublicLabels] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ preparation: DatasetMigrationPreparation; input: { fieldId: string; labelFieldId: string } } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  function close() { props.onClose(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }
  const sourceFolder = useRef<HTMLDetailsElement>(null);
  const alive = useRef(true), locked = useRef(false), active = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  useEffect(() => { first.current?.focus(); }, []);

  async function loadSource(): Promise<void> {
    if (!props.onLoadSource || locked.current || !alive.current) return;
    const abort = new AbortController(); active.current = abort; locked.current = true; setLoadingSource(true);
    try { const result = await props.onLoadSource(abort.signal); if (alive.current && !abort.signal.aborted) setSource(result); }
    catch (error) { if (alive.current && !abort.signal.aborted) props.onError("dohc could not load the approved action source.", error, () => void loadSource()); }
    finally { if (alive.current) { locked.current = false; setLoadingSource(false); } }
  }
  async function prepareChoices(input: { fieldId: string; labelFieldId: string }): Promise<void> {
    if (!props.onPrepareChoices || locked.current || !alive.current) return;
    const abort = new AbortController(); active.current = abort; locked.current = true; setPending(true);
    try {
      const preparation = await props.onPrepareChoices(input, abort.signal);
      if (!alive.current || abort.signal.aborted) return;
      if (preparation.expected.workspaceId !== props.workspaceId || preparation.revision.datasetId !== dataset.datasetId || preparation.previousRevision.revisionSha256 !== dataset.revisionSha256) {
        throw Error("This review belongs to another Collection revision. Refresh the Collection.");
      }
      setReview({ preparation, input });
    } catch (error) { if (alive.current && !abort.signal.aborted) props.onError("dohc could not prepare public choices.", error, () => void prepareChoices(input)); }
    finally { if (alive.current) { locked.current = false; setPending(false); } }
  }

  async function execute(input: CreateDatasetFormInput): Promise<void> {
    if (!alive.current || locked.current) return;
    const abort = new AbortController(); active.current = abort;
    locked.current = true; setPending(true); setInvalid(null);
    try { await props.onCreate(input, abort.signal); }
    catch (cause) {
      if (alive.current && !abort.signal.aborted) props.onError("dohc could not create this form.", cause, () => { if (alive.current) void execute(input); });
    } finally { if (alive.current) { locked.current = false; setPending(false); } }
  }
  if (review && props.onPrepareChoices && props.onApproveChoices && props.onDiscardChoices && props.onLoadPreview) {
    return <CollectionMigrationReviewDialog workspaceId={props.workspaceId} datasetId={dataset.datasetId} initialPreparation={review.preparation} generatedChange
      onPrepare={(_input, signal) => props.onPrepareChoices!(review.input, signal)} onApprove={props.onApproveChoices} onDiscard={props.onDiscardChoices}
      onLoadPreview={props.onLoadPreview} onError={props.onError} onClose={close} />;
  }
  function submit(): void {
    if (!create || locked.current) return;
    const root = appRoot.trim(), formTitle = title.trim();
    if (!isShareablePath(root) || !/^[A-Za-z0-9_@./-]+$/.test(root) || root.length > 900) { if (sourceFolder.current) { sourceFolder.current.open = true; sourceFolder.current.querySelector("input")?.focus(); } setInvalid("Choose a workspace folder for the form."); return; }
    if (!formTitle || formTitle.length > 200 || /[\u0000-\u001f\u007f]/u.test(formTitle)) { setInvalid("Use a form title with 1 to 200 characters."); return; }
    if (!selected.length || selected.length > DATASET_MAX_FIELDS) { setInvalid(`Show 1 to ${DATASET_MAX_FIELDS} fields on the form.`); return; }
    if (required.some(field => !selected.includes(field.fieldId))) { setInvalid("Show every required field on the form."); return; }
    const fields = allowed.filter(field => selected.includes(field.fieldId));
    if (required.filter(field => field.type === "attachment").length > APP_BACKEND_OPERATION_FILES) {
      setInvalid(`A response can include ${APP_BACKEND_OPERATION_FILES} files. Make additional file fields optional before creating this form.`); return;
    }
    if (fields.some(field => field.type === "relation" && !relationChoices.some(choice => choice.fieldId === field.fieldId &&
      choiceActions(field).some(candidate => candidate.action.operationId === choice.operationId && candidate.label.fieldId === choice.labelFieldId)))) {
      setInvalid("Choose an approved public read action for each related-record field."); return;
    }
    const choices = relationChoices.filter(choice => selected.includes(choice.fieldId));
    void execute({ datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, tableId, createOperationId: create.operationId, appRoot: root, title: formTitle, fieldIds: [...selected], ...(choices.length ? { relationChoices: choices } : {}) });
  }
  if (!table || !create) return <Overlay onClose={close}><div className="dohc-elevated w-130 max-w-[85vw] rounded-xl border border-line bg-panel p-5"><h2 className="m-0 text-sm font-semibold text-ink">Create form</h2><p className="mt-2 text-[13px] text-muted">This collection has no approved public create action.</p><SecondaryButton className="mt-3" onClick={close}>Close</SecondaryButton></div></Overlay>;
  return <Overlay onClose={pending ? undefined : close}><form onSubmit={event => { event.preventDefault(); submit(); }} data-testid="create-dataset-form-dialog" className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-[960px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line bg-panel">
    <div className="shrink-0 border-b border-line px-5 py-4"><h2 className="m-0 text-sm font-semibold text-ink">Create form</h2><p className="m-0 text-[12px] text-muted">{dataset.name}{dataset.name !== table.name ? ` · ${table.name}` : ""}</p></div>
    <div className="min-h-0 overflow-y-auto min-[900px]:grid min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-[900px]:overflow-hidden">
    <div className="flex min-w-0 flex-col gap-4 p-5 min-[900px]:overflow-y-auto">
    <label className="text-[12px] text-muted">Form title<input ref={first} aria-label="Form title" value={title} maxLength={200} disabled={pending} className={`${inputClass} mt-1`} onChange={event => setTitle(event.target.value)} /></label>

    {operations.length > 1 ? <label className="text-[12px] text-muted">Create action<select aria-label="Create action" value={operationId} disabled={pending} className={`${selectClass} mt-1`} onChange={event => {
      const next = operations.find(operation => operation.operationId === event.target.value)!;
      setOperationId(next.operationId); setSelected(table.fields.filter(field => next.fieldIds.includes(field.fieldId) && (field.type !== "relation" || (field.required && !Object.hasOwn(field, "default")))).map(field => field.fieldId)); setInvalid(null);
    }}>{operations.map(operation => <option key={operation.operationId} value={operation.operationId}>{operation.label}</option>)}</select></label> : null}
    <fieldset disabled={pending} className="m-0 flex flex-col border-0 p-0"><legend className="text-[12px] font-medium text-ink">Fields shown on form</legend>
      <p className="m-0 mb-2 text-[11px] text-muted">This form can submit only these fields.</p>
      {allowed.map(field => <div key={field.fieldId} className="border-b border-line py-2.5">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input aria-label={field.name} type="checkbox" checked={selected.includes(field.fieldId)} disabled={required.includes(field)} onChange={event => setSelected(current => event.target.checked ? [...current, field.fieldId] : current.filter(id => id !== field.fieldId))} /><FieldTypeIcon type={field.type} /><span className="min-w-0 flex-1 break-words">{field.name}</span>{required.includes(field) ? <span title="Required" className="flex items-center gap-1 text-[11px] text-muted"><LockKeyhole size={12} strokeWidth={1.9} aria-hidden="true" />Required</span> : null}</label>
        {field.type === "relation" && selected.includes(field.fieldId) ? <div className="ml-6 mt-2 flex flex-col gap-1">
          <label className="text-[12px] text-muted">Public choices<select aria-label={`Public choices for ${field.name}`} className={selectClass}
            value={(() => { const choice = relationChoices.find(choice => choice.fieldId === field.fieldId); return choice ? `${choice.operationId}:${choice.labelFieldId}` : ""; })()}
            onChange={event => { const [operationId, labelFieldId] = event.target.value.split(":"); setRelationChoices(current => [...current.filter(choice => choice.fieldId !== field.fieldId), ...(operationId && labelFieldId ? [{ fieldId: field.fieldId, operationId, labelFieldId }] : [])]); }}>
            <option value="">Choose a public read action</option>
            {choiceActions(field).map(({ action, label }) => <option key={`${action.operationId}:${label.fieldId}`} value={`${action.operationId}:${label.fieldId}`}>{action.label} · {label.name} ({action.name})</option>)}
          </select></label>
          <p className="m-0 text-[12px] text-muted">Anyone with this form can call the selected action and read its complete output. Review its source before sharing.</p>
          {props.onPrepareChoices && field.relation?.datasetId === dataset.datasetId ? <details>
            <summary className="cursor-pointer text-[12px] text-ink">Create public choices</summary>
            <p className="text-[12px] text-muted">The new action can expose every related record's key and selected label. Choose a label safe to share.</p>
            <label className="text-[12px] text-muted">Public label<select aria-label={`Public label for ${field.name}`} className={selectClass} value={publicLabels[field.fieldId] ?? ""}
              onChange={event => setPublicLabels(current => ({ ...current, [field.fieldId]: event.target.value }))}>
              <option value="">Choose a label</option>{dataset.tables.find(table => table.tableId === field.relation?.tableId)?.fields.filter(label => ["text", "number", "select"].includes(label.type)).map(label => <option key={label.fieldId} value={label.fieldId}>{label.name}</option>)}
            </select></label>
            <p className="text-[12px] text-muted">This changes the rules. Existing apps need review before they can use the new revision.</p>
            <p className="text-[12px] text-muted">After approval, choose Create form again and select the new public action.</p>
            <SecondaryButton disabled={pending || !publicLabels[field.fieldId]} onClick={() => void prepareChoices({ fieldId: field.fieldId, labelFieldId: publicLabels[field.fieldId]! })}>Review public choices</SecondaryButton>
          </details> : choiceActions(field).length === 0 ? <p className="m-0 text-[12px] text-muted">Approve a public read action for the related key and label in this dataset, then reopen this form.</p> : null}
        </div> : null}
      </div>)}
    </fieldset>
    {selected.some(id => allowed.some(field => field.fieldId === id && field.type === "relation")) && props.onLoadSource ? <div className="flex flex-col gap-2">
      <SecondaryButton disabled={pending || loadingSource} onClick={() => void loadSource()}>{loadingSource ? "Loading source…" : "Review action source"}</SecondaryButton>
      {source ? <details open><summary className="text-[12px] text-ink">Approved action source</summary><p className="break-all font-mono text-[11px] text-muted">{source.path}<br />{source.sha256}</p><pre className="max-h-60 overflow-auto rounded-md border border-line bg-bg p-2 text-[12px] text-ink">{source.source}</pre></details> : null}
    </div> : null}
    <details ref={sourceFolder} className="text-[12px] text-muted"><summary className="cursor-pointer text-ink"><FileCode2 size={14} strokeWidth={1.9} aria-hidden="true" className="mr-1.5 inline-block" />Source folder <span className="ml-2 break-all font-mono text-[11px] text-muted">{appRoot}</span></summary><div className="mt-2"><p className="mb-2 mt-0">The app source stays in this workspace folder.</p><label className="text-[12px] text-muted">App folder<input aria-label="App folder" value={appRoot} disabled={pending} className={`${inputClass} mt-1 font-mono`} onChange={event => setAppRoot(event.target.value)} /></label></div></details>
    </div>
    <DatasetFormPreview title={title} fields={selected.flatMap(id => allowed.filter(field => field.fieldId === id))} />
    </div>
    <div className="flex shrink-0 flex-col gap-3 border-t border-line px-5 py-4">
    {invalid ? <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p> : null}
    <div className="flex justify-end gap-2"><SecondaryButton disabled={pending} onClick={close}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={pending}>{pending ? "Creating…" : "Create form"}</PrimaryButton></div>
    </div>
  </form></Overlay>;
}
