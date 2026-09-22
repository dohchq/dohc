import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { COLLECTION_SCHEMA_FILENAME, type CollectionSchema } from "@dohc/workspace-contracts/collection";
import type { CollectionRef } from "@dohc/workspace-contracts/collection-data";
import { parseDatasetDefinition, type DatasetDefinition } from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { IconButton, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { draftToField, emptyFieldDraft, fieldDraftError, FieldDraftRow, inputClass, parseOptionsText, selectClass, type FieldDraft } from "./FieldForm";
import { serializeCollectionSchema } from "./schemaAuthoring";
import { datasetDefinitionFromDrafts, type TransactionalFieldDraft } from "./datasetDefinitionFromDrafts";

type DataDraft = { name: string; type: TransactionalFieldDraft["type"]; required: boolean; unique: boolean; options: string; hasDefault: boolean; defaultText: string };
const newDataDraft = (name = ""): DataDraft => ({ name, type: "text", required: false, unique: false, options: "", hasDefault: false, defaultText: "" });
const dataTypes: Array<[DataDraft["type"], string]> = [["text", "Text"], ["number", "Number"], ["checkbox", "Checkbox"], ["date", "Date"], ["select", "Select"], ["multi-select", "Multi-select"], ["url", "URL"], ["attachment", "File"]];
function typedField(draft: DataDraft): TransactionalFieldDraft {
  const field: TransactionalFieldDraft = { name: draft.name.trim(), type: draft.type, required: draft.required, unique: draft.unique };
  if (draft.type === "select" || draft.type === "multi-select") field.options = parseOptionsText(draft.options);
  if (draft.hasDefault && draft.type !== "attachment") {
    let value: AppBackendJson = draft.defaultText;
    if (draft.type === "number") {
      if (!draft.defaultText.trim() || !Number.isFinite(Number(draft.defaultText))) throw new Error(`Enter a number for ${field.name}'s default.`);
      value = Number(draft.defaultText);
    }
    if (draft.type === "checkbox") value = draft.defaultText === "true";
    if (draft.type === "multi-select") value = parseOptionsText(draft.defaultText);
    field.default = value;
  }
  return field;
}
export interface NewCollectionDialogProps {
  workspaceId: string;
  initialFolder?: string;
  onClose(): void;
  onCreated(collection: CollectionRef): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}

export function NewCollectionDialog(props: NewCollectionDialogProps) {
  return <ScopedNewCollectionDialog key={props.workspaceId} {...props} />;
}
function ScopedNewCollectionDialog(props: NewCollectionDialogProps) {
  const [name, setName] = useState(props.initialFolder ? `${props.initialFolder}/` : "");
  const [kind, setKind] = useState<"transactional" | "document">("transactional");
  const [drafts, setDrafts] = useState<DataDraft[]>([newDataDraft("Name")]);
  const [documentDrafts, setDocumentDrafts] = useState<FieldDraft[]>([emptyFieldDraft("Name")]);
  const [relationTargets, setRelationTargets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true), creating = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (kind !== "document") return;
    let stale = false;
    void bridge().listCollections({ workspaceId: props.workspaceId }).then(result => {
      if (!stale) setRelationTargets(result.collections.map(entry => entry.path));
    }).catch(() => undefined);
    return () => { stale = true; };
  }, [kind, props.workspaceId]);

  async function create(captured?: { definition: DatasetDefinition } | { folder: string; schema: CollectionSchema }): Promise<void> {
    if (!alive.current || creating.current) return;
    let plan = captured;
    if (!plan) {
      const folder = name.trim().replace(/\/+$/, "");
      if (!folder) return;
      const names: string[] = [];
      try {
        if (kind === "document") {
          for (const draft of documentDrafts) {
            const issue = fieldDraftError(draft, names);
            if (issue) throw new Error(issue);
            names.push(draft.name.trim());
          }
          plan = { folder, schema: { name: folder.split("/").at(-1)!, description: null, fields: documentDrafts.map(draftToField), views: [] } };
        } else {
          for (const draft of drafts) {
            const issue = fieldDraftError({ ...emptyFieldDraft(), name: draft.name, type: draft.type === "attachment" ? "text" : draft.type, optionsText: draft.options }, names);
            if (issue) throw new Error(issue);
            if (draft.name.trim() === "Record ID") throw new Error('The name "Record ID" is reserved. Choose another name.');
            names.push(draft.name.trim());
          }
          const definition = datasetDefinitionFromDrafts({ name: folder.split("/").at(-1)!, schemaPath: `${folder}/schema.sql`, operationsPath: `${folder}/operations.js`, fields: drafts.map(typedField) });
          try { parseDatasetDefinition(definition); }
          catch { throw new Error("Check the collection path, field options, and default values."); }
          plan = { definition };
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the collection fields."); return; }
    }
    const retryPlan = plan;
    creating.current = true; setPending(true); setError(null);
    try {
      if ("definition" in plan) {
        const result = await bridge().dataset({ action: "create", workspaceId: props.workspaceId, definition: plan.definition });
        if (!alive.current) return;
        if (result.kind !== "approved" || result.revision.datasetId !== plan.definition.datasetId) throw new Error("The collection creation returned a different dataset.");
        props.onCreated({ kind: "transactional", datasetId: result.revision.datasetId, tableId: plan.definition.tables[0]!.tableId });
      } else {
        const result = await bridge().createWorkspaceFile({ workspaceId: props.workspaceId, relativePath: `${plan.folder}/${COLLECTION_SCHEMA_FILENAME}`, initialText: serializeCollectionSchema(plan.schema) });
        if (!alive.current) return;
        props.onCreated({ kind: "document", path: result.path.slice(0, -(COLLECTION_SCHEMA_FILENAME.length + 1)) });
      }
    } catch (cause) {
      if (alive.current) props.onError("dohc could not create this collection.", cause, () => { if (alive.current) void create(retryPlan); });
    } finally { if (alive.current) { creating.current = false; setPending(false); } }
  }
  const changeDraft = (index: number, patch: Partial<DataDraft>) => setDrafts(current => current.map((entry, at) => at === index ? { ...entry, ...patch } : entry));
  return <Overlay onClose={pending ? undefined : props.onClose}>
    <div data-testid="new-collection-dialog" className="dohc-elevated flex max-h-[85vh] w-130 max-w-[85vw] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-5">
      <h2 className="m-0 text-sm font-semibold text-ink">New collection</h2>
      <fieldset disabled={pending} className="m-0 flex gap-4 border-0 p-0"><legend className="sr-only">Record type</legend>
        <label className="flex items-center gap-1.5 text-[13px] text-ink"><input type="radio" name="collection-kind" checked={kind === "transactional"} onChange={() => { setKind("transactional"); setError(null); }} />Data</label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink"><input type="radio" name="collection-kind" checked={kind === "document"} onChange={() => { setKind("document"); setError(null); }} />Documents</label>
      </fieldset>
      <p className="m-0 text-xs text-muted">{kind === "transactional" ? "Data records connect to forms and apps." : "Each record has a document body and editable properties."}</p>
      <input ref={inputRef} spellCheck={false} aria-label="Collection name" placeholder="projects/tasks" value={name} disabled={pending} className={`${inputClass} font-mono`} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void create(); }} />
      <SectionLabel>Fields</SectionLabel>
      {(kind === "document" ? documentDrafts : drafts).map((draft, index) => <div key={index} className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">{kind === "document" ? <FieldDraftRow draft={documentDrafts[index]!} disabled={pending} relationTargets={relationTargets} onChange={next => setDocumentDrafts(current => current.map((entry, at) => at === index ? next : entry))} /> : <div className="flex flex-col gap-2">
          <div className="flex gap-2"><input aria-label="Field name" placeholder="Field name" disabled={pending} className={inputClass} value={draft.name} onChange={event => changeDraft(index, { name: event.target.value })} />
            <select aria-label="Field type" disabled={pending} className={`${selectClass} w-36 shrink-0`} value={draft.type} onChange={event => changeDraft(index, { type: event.target.value as DataDraft["type"], unique: false, hasDefault: false, defaultText: "" })}>{dataTypes.map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></div>
          {draft.type === "select" || draft.type === "multi-select" ? <input aria-label="Options" placeholder="Todo, Doing, Done" className={inputClass} disabled={pending} value={drafts[index]!.options} onChange={event => changeDraft(index, { options: event.target.value })} /> : null}
          <div className="flex flex-wrap gap-3 text-[12px] text-muted"><label className="flex items-center gap-1"><input aria-label={`Require ${draft.name || `field ${index + 1}`}`} type="checkbox" disabled={pending} checked={drafts[index]!.required} onChange={event => changeDraft(index, { required: event.target.checked })} />Required</label>
            {draft.type !== "attachment" && draft.type !== "multi-select" ? <label className="flex items-center gap-1"><input aria-label={`Unique ${draft.name || `field ${index + 1}`}`} type="checkbox" disabled={pending} checked={drafts[index]!.unique} onChange={event => changeDraft(index, { unique: event.target.checked })} />Unique</label> : null}
            {draft.type !== "attachment" ? <label className="flex items-center gap-1"><input aria-label={`Default for ${draft.name || `field ${index + 1}`}`} type="checkbox" disabled={pending} checked={drafts[index]!.hasDefault} onChange={event => changeDraft(index, { hasDefault: event.target.checked })} />Default value</label> : null}</div>
          {drafts[index]!.hasDefault ? draft.type === "checkbox" ? <select aria-label={`Default ${draft.name}`} className={selectClass} disabled={pending} value={drafts[index]!.defaultText || "false"} onChange={event => changeDraft(index, { defaultText: event.target.value })}><option value="false">Unchecked</option><option value="true">Checked</option></select> : <input aria-label={`Default ${draft.name}`} type={draft.type === "number" ? "number" : draft.type === "date" ? "date" : "text"} step={draft.type === "number" ? "any" : undefined} className={inputClass} disabled={pending} value={drafts[index]!.defaultText} onChange={event => changeDraft(index, { defaultText: event.target.value })} /> : null}
        </div>}</div>
        <IconButton aria-label="Remove field" disabled={pending || (kind === "document" ? documentDrafts : drafts).length === 1} onClick={() => kind === "document" ? setDocumentDrafts(current => current.filter((_, at) => at !== index)) : setDrafts(current => current.filter((_, at) => at !== index))}><X size={14} strokeWidth={1.9} /></IconButton>
      </div>)}
      <SecondaryButton className="self-start" disabled={pending || drafts.length >= 127} onClick={() => kind === "document" ? setDocumentDrafts(current => [...current, emptyFieldDraft()]) : setDrafts(current => [...current, newDataDraft()])}>Add field</SecondaryButton>
      {error ? <p role="alert" className="m-0 text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2"><SecondaryButton disabled={pending} onClick={props.onClose}>Cancel</SecondaryButton><PrimaryButton data-testid="new-collection-create" disabled={pending || !name.trim()} onClick={() => void create()}>{pending ? "Creating…" : "Create collection"}</PrimaryButton></div>
    </div>
  </Overlay>;
}
