import { Fragment } from "react";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import { Check, Pencil, Square } from "lucide-react";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { Overlay } from "./Overlay";
import { IconButton, Pill, PrimaryButton, SecondaryButton } from "./ui/controls";
import { FieldTypeIcon } from "./collections/FieldTypeIcon";
import { CollectionAttachmentCell } from "./CollectionResourceInputs";
import type { CollectionResourceError, CollectionResourceScope, CollectionResources } from "./transactionalCollectionResources";
import { display, type TransactionalField, type TransactionalRow } from "./transactionalCollectionModel";
import type { TransactionalButtons } from "./TransactionalCollectionPage";

export interface TransactionalRecordDetailsDialogProps extends Pick<CollectionResources, "readFile"> {
  scope: CollectionResourceScope;
  row: TransactionalRow;
  fields: readonly TransactionalField[];
  readOperation: DatasetOperation;
  operations: readonly DatasetOperation[];
  offline?: boolean;
  disabled?: boolean;
  /** The record's buttons, in one row above its fields. */
  buttons?: TransactionalButtons;
  canEdit(field: TransactionalField): boolean;
  onEdit(field: TransactionalField, operation: DatasetOperation): void;
  onAction?(operation: DatasetOperation): void;
  onClose(): void;
  onError: CollectionResourceError;
}

function valueText(value: AppBackendJson | undefined): string {
  if (value === undefined || value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value) : display(value);
}

export function TransactionalRecordDetailsDialog(props: TransactionalRecordDetailsDialogProps) {
  // A new version of the same record keeps the dialog, and the focus in it.
  return <ScopedRecordDetails key={JSON.stringify([props.scope, props.row.id, props.readOperation, props.fields, props.operations, props.offline])} {...props} />;
}

function ScopedRecordDetails(props: TransactionalRecordDetailsDialogProps) {
  const read = props.readOperation;
  const fields = read.kind === "read" && read.readOnly ? props.fields.filter(field => read.fieldIds.includes(field.fieldId)) : [];
  const edits = props.offline ? [] : props.operations.filter(operation => operation.tableId === read.tableId && operation.kind === "edit" && !operation.readOnly);
  const actions = props.offline || !props.onAction ? [] : props.operations.filter(operation => operation.tableId === read.tableId && operation.kind === "action");
  const hasEditableField = fields.some(field => props.canEdit(field) && edits.some(operation => operation.fieldIds.includes(field.fieldId)));
  return <Overlay onClose={props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Record details", className: "dohc-elevated dohc-pop-in flex max-h-[90vh] w-[min(620px,92vw)] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><div><h2 className="m-0 text-sm font-semibold">Record details</h2><p className="m-0 mt-1 text-[12px] text-muted">Record {String(props.row.id)} · Version {props.row.version}</p></div><SecondaryButton disabled={props.disabled} onClick={props.onClose}>Close</SecondaryButton></div>
    {props.buttons?.fields.length ? <div data-testid="record-buttons" className="flex flex-wrap items-center gap-1.5">{props.buttons.fields.map(field => <Fragment key={field}>{props.buttons!.render(field, props.row)}</Fragment>)}</div> : null}
    <dl className="m-0 grid gap-2">
      {fields.map(field => {
        const value = props.row.values[field.fieldId];
        const edit = props.canEdit(field) ? edits.find(operation => operation.fieldIds.includes(field.fieldId)) : undefined;
        const attachment = field.type === "attachment" && typeof value === "string" && props.readFile && !props.offline;
        return <div key={field.fieldId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4 border-b border-line py-2 last:border-0"><dt className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-muted"><FieldTypeIcon type={field.type} className="shrink-0" /><span className="break-words">{field.name}</span></dt><dd className="m-0 flex min-w-0 items-start justify-between gap-2 break-words text-[13px] text-ink">
          {attachment ? <CollectionAttachmentCell key={value} scope={props.scope} fieldName={field.name} fileId={value} disabled={props.disabled ?? false} read={(request, signal) => props.readFile!({ ...request, read: { operationId: read.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value }] } } }, signal)} onError={props.onError} /> : field.type === "select" && typeof value === "string" && value ? <Pill>{value}</Pill> : field.type === "multi-select" && Array.isArray(value) && value.length > 0 ? <span className="flex flex-wrap gap-1">{value.map((item, index) => <Pill key={index}>{valueText(item)}</Pill>)}</span> : <span className="flex min-w-0 items-center gap-1.5 whitespace-pre-wrap">{field.type === "checkbox" && typeof value === "boolean" ? value ? <Check size={14} strokeWidth={1.9} aria-hidden className="text-success" /> : <Square size={14} strokeWidth={1.9} aria-hidden className="text-muted" /> : null}{field.type === "attachment" && value ? props.offline ? "File available when online" : "Attached file" : field.type === "checkbox" ? value === true ? "Yes" : value === false ? "No" : "—" : valueText(value)}</span>}
          {edit ? <IconButton className="shrink-0" aria-label={`Edit ${field.name}`} title={`Edit ${field.name}`} disabled={props.disabled} onClick={() => props.onEdit(field, edit)}><Pencil size={14} strokeWidth={1.9} aria-hidden /></IconButton> : null}
        </dd></div>;
      })}
    </dl>
    {actions.length ? <div className="grid gap-2 border-t border-line pt-3"><p className="m-0 text-[12px] text-muted">Open an action to review its inputs before running it.</p><div className="flex flex-wrap gap-2">{actions.map(operation => <SecondaryButton key={operation.operationId} disabled={props.disabled} onClick={() => props.onAction?.(operation)}>Open {operation.label}</SecondaryButton>)}</div></div> : null}
    {props.offline ? <p className="m-0 text-[12px] text-muted">Offline copy · Read-only</p> : !hasEditableField && !actions.length ? <p className="m-0 text-[12px] text-muted">No edit action is available for this record.</p> : null}
    <div className="flex justify-end"><PrimaryButton disabled={props.disabled} onClick={props.onClose}>Done</PrimaryButton></div>
  </Overlay>;
}
