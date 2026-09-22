import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { CollectionAttachmentCell } from "./CollectionResourceInputs";
import type { CollectionResourceError, CollectionResourceScope, CollectionResources } from "./transactionalCollectionResources";
import { display, type TransactionalField, type TransactionalRow } from "./transactionalCollectionModel";

export interface TransactionalRecordDetailsDialogProps extends Pick<CollectionResources, "readFile"> {
  scope: CollectionResourceScope;
  row: TransactionalRow;
  fields: readonly TransactionalField[];
  readOperation: DatasetOperation;
  operations: readonly DatasetOperation[];
  offline?: boolean;
  disabled?: boolean;
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
  return <ScopedRecordDetails key={JSON.stringify([props.scope, props.row, props.readOperation, props.fields, props.operations, props.offline])} {...props} />;
}

function ScopedRecordDetails(props: TransactionalRecordDetailsDialogProps) {
  const read = props.readOperation;
  const fields = read.kind === "read" && read.readOnly ? props.fields.filter(field => read.fieldIds.includes(field.fieldId)) : [];
  const edits = props.offline ? [] : props.operations.filter(operation => operation.tableId === read.tableId && operation.kind === "edit" && !operation.readOnly);
  const actions = props.offline || !props.onAction ? [] : props.operations.filter(operation => operation.tableId === read.tableId && operation.kind === "action");
  const hasEditableField = fields.some(field => props.canEdit(field) && edits.some(operation => operation.fieldIds.includes(field.fieldId)));
  return <Overlay onClose={props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Record details", className: "dohc-elevated dohc-pop-in flex max-h-[90vh] w-[min(620px,92vw)] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><div><h2 className="m-0 text-sm font-semibold">Record details</h2><p className="m-0 mt-1 text-[12px] text-muted">Record {String(props.row.id)} · Version {props.row.version}</p></div><SecondaryButton disabled={props.disabled} onClick={props.onClose}>Close</SecondaryButton></div>
    <dl className="m-0 grid gap-2">
      {fields.map(field => {
        const value = props.row.values[field.fieldId];
        const edit = props.canEdit(field) ? edits.find(operation => operation.fieldIds.includes(field.fieldId)) : undefined;
        const attachment = field.type === "attachment" && typeof value === "string" && props.readFile && !props.offline;
        return <div key={field.fieldId} className="grid gap-1 border-b border-line pb-2 last:border-0"><dt className="text-[12px] font-medium text-muted">{field.name}</dt><dd className="m-0 break-words text-[13px] text-ink">
          {attachment ? <CollectionAttachmentCell scope={props.scope} fieldName={field.name} fileId={value} disabled={props.disabled ?? false} read={(request, signal) => props.readFile!({ ...request, read: { operationId: read.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value }] } } }, signal)} onError={props.onError} /> : <span className="whitespace-pre-wrap">{field.type === "attachment" && value ? props.offline ? "File available when online" : "Attached file" : field.type === "checkbox" ? value === true ? "Yes" : value === false ? "No" : "—" : valueText(value)}</span>}
          {edit ? <SecondaryButton size="compact" className="ml-2" aria-label={`Edit ${field.name}`} disabled={props.disabled} onClick={() => props.onEdit(field, edit)}>Edit</SecondaryButton> : null}
        </dd></div>;
      })}
    </dl>
    {actions.length ? <div className="grid gap-2 border-t border-line pt-3"><p className="m-0 text-[12px] text-muted">Open an action to review its inputs before running it.</p><div className="flex flex-wrap gap-2">{actions.map(operation => <SecondaryButton key={operation.operationId} disabled={props.disabled} onClick={() => props.onAction?.(operation)}>Open {operation.label}</SecondaryButton>)}</div></div> : null}
    {props.offline ? <p className="m-0 text-[12px] text-muted">Offline copy · Read-only</p> : !hasEditableField && !actions.length ? <p className="m-0 text-[12px] text-muted">No edit action is available for this record.</p> : null}
    <div className="flex justify-end"><PrimaryButton disabled={props.disabled} onClick={props.onClose}>Done</PrimaryButton></div>
  </Overlay>;
}
