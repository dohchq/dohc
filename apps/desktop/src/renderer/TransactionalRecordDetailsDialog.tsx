import { Fragment, type ReactNode } from "react";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import { Check, Pencil, Square } from "lucide-react";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { Overlay } from "./Overlay";
import { IconButton, Pill, PrimaryButton, SecondaryButton } from "./ui/controls";
import { FieldTypeIcon } from "@dohc/collection-views/values";
import { CollectionAttachmentCell } from "./CollectionResourceInputs";
import type { CollectionResourceError, CollectionResourceScope, CollectionResources } from "./transactionalCollectionResources";
import { display, type TransactionalField, type TransactionalRow } from "./transactionalCollectionModel";
import type { TransactionalButtons } from "./TransactionalCollectionPage";
import { AutomationFieldMark, type FieldMarks } from "./collections/collectionFieldMarks";

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
  /** The fields switched-on automations set, by name, with those automations' names. */
  fieldMarks?: FieldMarks;
  canEdit(field: TransactionalField): boolean;
  /** Opens a field for editing here. `opener` is its pencil, which takes focus back when the edit closes. */
  onEdit(field: TransactionalField, operation: DatasetOperation, opener: HTMLElement): void;
  /** The field open for editing, and what shows in its place: the page's input, any error, Cancel and Save.
   * While it is open, Escape anywhere in details calls `onCancel`, so the next Escape closes details. */
  editing?: { fieldId: string; name: string; content: ReactNode; onCancel(): void };
  onAction?(operation: DatasetOperation): void;
  onClose(): void;
  onError: CollectionResourceError;
  /** Why the dialog cannot show the record now, which replaces its values, as for a record deleted since it opened. */
  unavailable?: string;
}

function valueText(value: AppBackendJson | undefined): string {
  if (value === undefined || value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value) : display(value);
}

export function TransactionalRecordDetailsDialog(props: TransactionalRecordDetailsDialogProps) {
  // A new version of the same record, or new rules for its Collection, keeps the dialog, and the focus in it.
  return <ScopedRecordDetails key={JSON.stringify([props.scope.workspaceId, props.scope.datasetId, props.row.id])} {...props} />;
}

function ScopedRecordDetails(props: TransactionalRecordDetailsDialogProps) {
  const read = props.readOperation;
  const fields = read.kind === "read" && read.readOnly ? props.fields.filter(field => read.fieldIds.includes(field.fieldId)) : [];
  const edits = props.offline ? [] : props.operations.filter(operation => operation.tableId === read.tableId && operation.kind === "edit" && !operation.readOnly);
  const actions = props.offline || !props.onAction ? [] : props.operations.filter(operation => operation.tableId === read.tableId && operation.kind === "action");
  const hasEditableField = fields.some(field => props.canEdit(field) && edits.some(operation => operation.fieldIds.includes(field.fieldId)));
  return <Overlay onClose={props.editing?.onCancel ?? props.onClose} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Record details", className: "dohc-elevated dohc-pop-in flex max-h-[90vh] w-[min(620px,92vw)] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink" }}>
    <div className="flex items-center justify-between gap-3"><div><h2 className="m-0 text-base font-semibold">Record details</h2><p className="m-0 mt-1 text-[12px] text-muted">Record {String(props.row.id)}{props.unavailable ? null : ` · Version ${props.row.version}`}</p></div><SecondaryButton onClick={props.onClose}>Close</SecondaryButton></div>
    {props.unavailable ? <p role="status" className="m-0 text-sm text-muted">{props.unavailable}</p> : <>
    {props.buttons?.fields.length ? <div data-testid="record-buttons" className="flex flex-wrap items-center gap-1.5">{props.buttons.fields.map(field => <Fragment key={field}>{props.buttons!.render(field, props.row)}</Fragment>)}</div> : null}
    <dl className="m-0 grid gap-2">
      {fields.map(field => {
        const value = props.row.values[field.fieldId];
        const edit = props.canEdit(field) ? edits.find(operation => operation.fieldIds.includes(field.fieldId)) : undefined;
        const attachment = field.type === "attachment" && typeof value === "string" && props.readFile && !props.offline;
        // An open field stays open when the rules, or going offline, take its edit away, so what was typed still shows.
        const open = props.editing?.fieldId === field.fieldId;
        return <div key={field.fieldId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4 border-b border-line py-2 last:border-0"><dt className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-muted"><FieldTypeIcon type={field.type} className="shrink-0" /><span className="break-words">{field.name}</span>{props.fieldMarks?.has(field.name) ? <AutomationFieldMark automations={props.fieldMarks.get(field.name)!} /> : null}</dt><dd className="m-0 flex min-w-0 items-start justify-between gap-2 break-words text-[13px] text-ink">
          {open ? props.editing!.content : attachment ? <CollectionAttachmentCell key={value} scope={props.scope} fieldName={field.name} fileId={value} disabled={props.disabled ?? false} read={(request, signal) => props.readFile!({ ...request, read: { operationId: read.operationId, fieldId: field.fieldId, input: { limit: 1, filters: [{ fieldId: field.fieldId, value }] } } }, signal)} onError={props.onError} /> : field.type === "select" && typeof value === "string" && value ? <Pill>{value}</Pill> : field.type === "multi-select" && Array.isArray(value) && value.length > 0 ? <span className="flex flex-wrap gap-1">{value.map((item, index) => <Pill key={index}>{valueText(item)}</Pill>)}</span> : <span className="flex min-w-0 items-center gap-1.5 whitespace-pre-wrap">{field.type === "checkbox" && typeof value === "boolean" ? value ? <Check size={14} strokeWidth={1.9} aria-hidden className="text-success" /> : <Square size={14} strokeWidth={1.9} aria-hidden className="text-muted" /> : null}{field.type === "attachment" && value ? props.offline ? "File available when online" : "Attached file" : field.type === "checkbox" ? value === true ? "Yes" : value === false ? "No" : "—" : valueText(value)}</span>}
          {/* The pencil stays while hidden, so focus can return to it when the edit closes. */}
          {edit ? <IconButton className="shrink-0" hidden={open} aria-label={`Edit ${field.name}`} title={`Edit ${field.name}`} disabled={props.disabled} onClick={event => props.onEdit(field, edit, event.currentTarget)}><Pencil size={14} strokeWidth={1.9} aria-hidden /></IconButton> : null}
        </dd></div>;
      })}
      {/* A field open with a value typed into it stays after the rules remove it, until the value is cleared. */}
      {props.editing && !fields.some(field => field.fieldId === props.editing!.fieldId) ? <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4 border-b border-line py-2 last:border-0"><dt className="min-w-0 break-words text-[12px] font-medium text-muted">{props.editing.name}</dt><dd className="m-0 flex min-w-0 items-start justify-between gap-2 break-words text-[13px] text-ink">{props.editing.content}</dd></div> : null}
    </dl>
    {actions.length ? <div className="grid gap-2 border-t border-line pt-3"><p className="m-0 text-[12px] text-muted">Open an action to review its inputs before running it.</p><div className="flex flex-wrap gap-2">{actions.map(operation => <SecondaryButton key={operation.operationId} disabled={props.disabled} onClick={() => props.onAction?.(operation)}>Open {operation.label}</SecondaryButton>)}</div></div> : null}
    {props.offline ? <p className="m-0 text-[12px] text-muted">Offline copy · Read-only</p> : !hasEditableField && !actions.length ? <p className="m-0 text-[12px] text-muted">No edit action is available for this record.</p> : null}
    </>}
    <div className="flex justify-end"><PrimaryButton onClick={props.onClose}>Done</PrimaryButton></div>
  </Overlay>;
}
