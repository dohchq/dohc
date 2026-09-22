import { useLayoutEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { DatasetSchemaChange, type DatasetMigrationPreparation } from "@dohc/cli/dataset";
import { Overlay } from "./Overlay";
import { CollectionMigrationReviewDialog, type CollectionMigrationReviewDialogProps } from "./CollectionMigrationReviewDialog";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputClass, selectClass, parseOptionsText } from "./collections/FieldForm";

export interface CollectionFieldsDialogProps {
  workspaceId: string;
  dataset: DatasetDescription;
  tableId: string;
  onPrepare(change: DatasetSchemaChange, signal: AbortSignal): Promise<DatasetMigrationPreparation>;
  onApprove: CollectionMigrationReviewDialogProps["onApprove"];
  onDiscard: CollectionMigrationReviewDialogProps["onDiscard"];
  onLoadPreview: CollectionMigrationReviewDialogProps["onLoadPreview"];
  onError: CollectionMigrationReviewDialogProps["onError"];
  onClose(): void;
  onReviewSource(): void;
}
type FieldType = Extract<DatasetSchemaChange, { kind: "addField" }>["field"]["type"];
const types: Array<[FieldType, string]> = [["text", "Text"], ["number", "Number"], ["checkbox", "Checkbox"], ["date", "Date"],
  ["select", "Select"], ["multi-select", "Multi-select"], ["url", "URL"], ["attachment", "File"]];

export function CollectionFieldsDialog(props: CollectionFieldsDialogProps) {
  return <ScopedFields key={`${props.workspaceId}:${props.dataset.datasetId}:${props.tableId}:${props.dataset.revisionSha256}`} {...props} />;
}
function ScopedFields(props: CollectionFieldsDialogProps) {
  const table = props.dataset.tables.find(table => table.tableId === props.tableId);
  const [kind, setKind] = useState<DatasetSchemaChange["kind"]>("addField"), [name, setName] = useState("");
  const [fieldId, setFieldId] = useState(table?.fields[0]?.fieldId ?? ""), [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false), [unique, setUnique] = useState(false), [hasDefault, setHasDefault] = useState(false);
  const [defaultText, setDefaultText] = useState(""), [options, setOptions] = useState("");
  const [review, setReview] = useState<{ preparation: DatasetMigrationPreparation; change: DatasetSchemaChange } | null>(null);
  const [pending, setPending] = useState(false), [invalid, setInvalid] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), active = useRef(true), locked = useRef(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; lifetime.current?.abort(); }; }, []);
  function changeFromDraft(): DatasetSchemaChange {
    const label = name.trim();
    if (!label) throw new Error("Enter a name.");
    if (kind === "renameCollection") return DatasetSchemaChange.parse({ kind, name: label });
    if (kind === "renameTable") return DatasetSchemaChange.parse({ kind, tableId: props.tableId, name: label });
    if (table?.fields.some(field => field.name.toLocaleLowerCase() === label.toLocaleLowerCase() && (kind === "addField" || field.fieldId !== fieldId))) throw new Error("A field already uses this name. Choose another name.");
    if (kind === "renameField") return DatasetSchemaChange.parse({ kind, tableId: props.tableId, fieldId, name: label });
    const field: Extract<DatasetSchemaChange, { kind: "addField" }>["field"] = { name: label, type, required, unique };
    if (type === "select" || type === "multi-select") { field.options = parseOptionsText(options); if (!field.options.length) throw new Error("Enter at least one option."); }
    if (hasDefault) {
      if (type === "number") { if (!defaultText.trim() || !Number.isFinite(Number(defaultText))) throw new Error("Enter a number for the default."); field.default = Number(defaultText); }
      else if (type === "checkbox") field.default = defaultText === "true";
      else if (type === "multi-select") field.default = parseOptionsText(defaultText);
      else field.default = defaultText;
    }
    if (required && !hasDefault) throw new Error("A new required field needs a default for existing records.");
    if (unique && hasDefault) throw new Error("A new unique field cannot give every record the same default.");
    return DatasetSchemaChange.parse({ kind, tableId: props.tableId, field });
  }
  async function prepare() {
    if (locked.current || !active.current) return;
    let change: DatasetSchemaChange;
    try { change = changeFromDraft(); setInvalid(null); } catch (error) { setInvalid(error instanceof Error ? error.message : "Check the field values."); return; }
    locked.current = true; setPending(true); const abort = new AbortController(); lifetime.current = abort;
    try {
      const preparation = await props.onPrepare(change, abort.signal);
      if (active.current && !abort.signal.aborted) {
        if (preparation.expected.workspaceId !== props.workspaceId || preparation.revision.datasetId !== props.dataset.datasetId
          || preparation.previousRevision.revisionSha256 !== props.dataset.revisionSha256) throw new Error("This review belongs to another Collection revision. Refresh the Collection.");
        setReview({ preparation, change });
      }
    } catch (error) { if (active.current && !abort.signal.aborted) props.onError("dohc could not prepare this field change.", error, () => { if (active.current) void prepare(); }); }
    finally { if (active.current) { locked.current = false; setPending(false); } }
  }
  if (review) return <CollectionMigrationReviewDialog workspaceId={props.workspaceId} datasetId={props.dataset.datasetId} initialPreparation={review.preparation} generatedChange
    onPrepare={(_input, signal) => props.onPrepare(review.change, signal)} onApprove={props.onApprove} onDiscard={props.onDiscard} onLoadPreview={props.onLoadPreview} onClose={props.onClose} onError={props.onError} />;
  return <Overlay onClose={pending ? undefined : props.onClose}><form role="dialog" aria-modal="true" aria-labelledby="collection-fields-title"
    onSubmit={event => { event.preventDefault(); void prepare(); }} className="dohc-elevated dohc-pop-in flex max-h-[88vh] w-[min(480px,calc(100vw-32px))] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-5">
    <h2 id="collection-fields-title" className="m-0 text-sm font-semibold text-ink">Fields and names</h2>
    <label className="text-[12px] text-muted">Change<select aria-label="Change" disabled={pending} className={`${selectClass} mt-1 w-full`} value={kind} onChange={event => {
      const next = event.target.value as DatasetSchemaChange["kind"]; setKind(next); setInvalid(null);
      setName(next === "renameTable" ? table?.name ?? "" : next === "renameCollection" ? props.dataset.name : next === "renameField" ? table?.fields.find(field => field.fieldId === fieldId)?.name ?? "" : "");
    }}><option value="addField">Add field</option><option value="renameField">Rename field</option><option value="renameTable">Rename table</option><option value="renameCollection">Rename Collection</option></select></label>
    {kind === "renameField" && <label className="text-[12px] text-muted">Field<select aria-label="Field" disabled={pending} className={`${selectClass} mt-1 w-full`} value={fieldId} onChange={event => { setFieldId(event.target.value); setName(table?.fields.find(field => field.fieldId === event.target.value)?.name ?? ""); }}>{table?.fields.map(field => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select></label>}
    <label className="text-[12px] text-muted">Name<input aria-label="Name" autoFocus className={`${inputClass} mt-1`} disabled={pending} value={name} onChange={event => setName(event.target.value)} /></label>
    {kind === "addField" && <>
      <label className="text-[12px] text-muted">Type<select aria-label="Type" className={`${selectClass} mt-1 w-full`} disabled={pending} value={type} onChange={event => { setType(event.target.value as FieldType); setRequired(false); setUnique(false); setHasDefault(false); setDefaultText(""); }}>{types.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {(type === "select" || type === "multi-select") && <label className="text-[12px] text-muted">Options<input aria-label="Options" className={`${inputClass} mt-1`} disabled={pending} value={options} placeholder="Todo, Doing, Done" onChange={event => setOptions(event.target.value)} /></label>}
      <div className="flex flex-wrap gap-3 text-[12px] text-muted"><label className="flex items-center gap-1"><input type="checkbox" checked={required} disabled={pending || type === "attachment"} onChange={event => setRequired(event.target.checked)} />Required</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={unique} disabled={pending || type === "attachment" || type === "multi-select"} onChange={event => setUnique(event.target.checked)} />Unique</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={hasDefault} disabled={pending || type === "attachment"} onChange={event => setHasDefault(event.target.checked)} />Default value</label></div>
      {hasDefault && <label className="text-[12px] text-muted">Default{type === "checkbox" ? <select aria-label="Default" className={`${selectClass} mt-1 w-full`} disabled={pending} value={defaultText || "false"} onChange={event => setDefaultText(event.target.value)}><option value="false">Unchecked</option><option value="true">Checked</option></select> : <input aria-label="Default" className={`${inputClass} mt-1`} type={type === "number" ? "number" : type === "date" ? "date" : "text"} disabled={pending} value={defaultText} onChange={event => setDefaultText(event.target.value)} />}</label>}
      <p className="m-0 text-[12px] text-muted">Shared apps and helpers need approval for the new fields. Choose their access after this change.</p>
    </>}
    {invalid && <p role="alert" className="m-0 text-[12px] text-danger">{invalid}</p>}
    <div className="flex flex-wrap items-center justify-end gap-2"><SecondaryButton type="button" disabled={pending} onClick={props.onReviewSource}>Review source change</SecondaryButton><SecondaryButton type="button" disabled={pending} onClick={props.onClose}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={pending}>{pending ? "Preparing…" : "Review change"}</PrimaryButton></div>
  </form></Overlay>;
}
