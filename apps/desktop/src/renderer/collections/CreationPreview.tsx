import { Check, FileText, ListChecks, Paperclip, Search, Table2 } from "lucide-react";
import type { DatasetColumnField } from "@dohc/security-contract/dataset";
import { FieldTypeIcon } from "./FieldTypeIcon";
import { inputClass, selectClass } from "./FieldForm";

export function CollectionKindShape({ documents }: { documents?: boolean }) {
  return <span aria-hidden="true" className="flex h-10 items-center gap-2 overflow-hidden rounded-md border border-line bg-bg px-2 text-muted">
    {documents ? <><FileText size={18} strokeWidth={1.9} /><span className="flex flex-1 flex-col gap-1.5"><span className="h-px w-3/4 bg-line" /><span className="h-px w-full bg-line" /><span className="h-px w-1/2 bg-line" /></span></> : <span className="grid w-full grid-cols-3 gap-px bg-line">{Array.from({ length: 9 }, (_, index) => <span key={index} className={`h-2 ${index < 3 ? "bg-panel-2" : "bg-bg"}`} />)}</span>}
  </span>;
}

export function CollectionCreationPreview({ name, fields, documents }: {
  name: string;
  fields: readonly { name: string; type: string; required?: boolean }[];
  documents: boolean;
}) {
  const Icon = documents ? FileText : Table2;
  return <section aria-label="Collection preview" className="min-w-0 bg-panel-2 p-5 min-[900px]:overflow-y-auto">
    <div className="mb-4 flex items-center justify-between text-[12px] text-muted"><span>Preview</span><span className="font-mono">0 records</span></div>
    <div className="overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center gap-2 border-b border-line p-3 text-sm font-semibold text-ink"><Icon size={16} strokeWidth={1.9} aria-hidden="true" /><span className="truncate">{name.trim().replace(/\/+$/, "").split("/").at(-1) || "New collection"}</span></div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-left text-[12px]">
          <thead><tr>{fields.map((field, index) => <th key={index} className="border-b border-r border-line bg-panel px-3 py-2 font-medium last:border-r-0"><span className="flex items-center gap-1.5 whitespace-nowrap"><FieldTypeIcon type={field.type} />{field.name.trim() || "Field name"}{field.required ? <span title="Required"><span aria-hidden="true">*</span><span className="sr-only">Required</span></span> : null}</span></th>)}</tr></thead>
          <tbody aria-hidden="true"><tr>{fields.map((_, index) => <td key={index} className="h-16 border-r border-line last:border-r-0" />)}</tr></tbody>
        </table>
      </div>
    </div>
    <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">{documents ? <FileText size={14} strokeWidth={1.9} aria-hidden="true" /> : <Table2 size={14} strokeWidth={1.9} aria-hidden="true" />}<span>{documents ? "Each record opens as a document" : "Connect records to forms and apps"}</span></div>
  </section>;
}

export function DatasetFormPreview({ title, fields }: { title: string; fields: readonly Omit<DatasetColumnField, "sqlColumn">[] }) {
  return <section aria-label="Form preview" className="min-w-0 bg-panel-2 p-5 min-[900px]:overflow-y-auto">
    <div className="mb-4 flex items-center justify-between text-[12px] text-muted"><span>Preview</span><span className="font-mono">{fields.length} fields</span></div>
    <div className="rounded-lg border border-line bg-bg p-5">
      <h3 className="m-0 mb-5 break-words text-lg font-semibold text-ink">{title.trim() || "Form title"}</h3>
      <div className="flex flex-col gap-4">
        {fields.map(field => {
          const required = field.required && !Object.hasOwn(field, "default");
          const value = field.default;
          const choices = field.type === "select" || field.type === "multi-select" || field.type === "relation";
          const multiple = field.type === "multi-select" || field.relation?.many === true;
          return <div key={field.fieldId} className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink">
              {field.type === "checkbox" ? <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center rounded border border-line">{value === true ? <Check size={12} strokeWidth={1.9} /> : null}</span> : null}
              <span className="break-words">{field.name}{required ? " *" : ""}</span>
            </div>
            {field.type === "checkbox" ? null : choices ? <div>
              <select aria-label={`Preview ${field.name}`} tabIndex={-1} disabled multiple={multiple} size={multiple ? 3 : undefined} className={selectClass} value={multiple ? Array.isArray(value) ? value.map(String) : [] : typeof value === "string" ? value : ""}>
                {!multiple ? <option value="">Choose an option</option> : null}
                {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
              {field.type === "relation" ? <div aria-hidden="true" className="mt-1.5 flex h-8 items-center gap-2 rounded-md border border-line px-2 text-muted"><Search size={14} strokeWidth={1.9} /><span className="text-[12px]">Search {field.name}</span></div> : null}
            </div> : field.type === "attachment" ? <div aria-hidden="true" className="flex items-center gap-2 rounded-md border border-line p-2 text-[12px] text-muted opacity-50"><Paperclip size={14} strokeWidth={1.9} /><span>Choose file</span></div> : <input aria-label={`Preview ${field.name}`} tabIndex={-1} disabled type={field.type === "number" || field.type === "date" || field.type === "url" ? field.type : "text"} placeholder={field.type === "url" ? "https://" : undefined} value={value === null || value === undefined ? "" : String(value)} className={inputClass} />}
          </div>;
        })}
        {fields.length === 0 ? <div className="flex items-center gap-2 py-6 text-[13px] text-muted"><ListChecks size={16} strokeWidth={1.9} aria-hidden="true" />Select fields to preview</div> : <span aria-hidden="true" className="self-start rounded-lg bg-accent/15 px-3 py-2 text-[13px] text-muted">Submit</span>}
      </div>
    </div>
  </section>;
}
