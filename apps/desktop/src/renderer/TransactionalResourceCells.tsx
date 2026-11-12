import { useLayoutEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { CollectionAttachmentCell, CollectionAttachmentInput, CollectionRelationInput } from "./CollectionResourceInputs";
import { IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { isComposingKey } from "./ui/keys";
import { display, type TransactionalField } from "./transactionalCollectionModel";
import type { CollectionResourceError, CollectionResourceScope, CollectionResources } from "./transactionalCollectionResources";

// A Data Collection's file and relation cells. The shared table knows neither
// kind of value, so the page draws them and their editor here, with the
// inputs that upload a file or search the related table.

/** A file or relation cell: its value, a download where the file can be read, and a way in where it can change. */
export function ResourceCell(props: {
  scope: CollectionResourceScope;
  field: TransactionalField;
  value: AppBackendJson | undefined;
  /** The value is a change the host has not confirmed, so a file has nothing to download yet. */
  unconfirmed: boolean;
  editable: boolean;
  offline: boolean;
  /** The control that edits the value is a Tab stop and its row's open target, as in a record's panel. In the table the grid is the stop. */
  tabStop?: boolean;
  /** Reads the file's bytes through the table's read action. Absent, the file can't be downloaded here. */
  download?: NonNullable<CollectionResources["readFile"]>;
  onError: CollectionResourceError;
}) {
  const { field, value, editable } = props;
  const stop = props.tabStop ? undefined : -1, target = props.tabStop ? " dohc-row-open-target" : "";
  if (field.type !== "attachment") {
    const text = <span className="truncate">{display(value)}</span>;
    // A button, so assistive technology hears that the cell opens. In the table the grid is the Tab stop.
    return editable ? <button type="button" tabIndex={stop} aria-label={display(value) === "" ? `Edit ${field.name}` : undefined} className={`flex min-h-5 w-full min-w-0 items-center text-left text-[13px]${target}`}>{text}</button>
      : <span className="flex min-w-0 text-[13px]">{text}</span>;
  }
  const fileId = typeof value === "string" && value !== "" ? value : null;
  return <span className="flex w-full min-w-0 items-center gap-1">
    {fileId === null ? null : props.unconfirmed ? <span className="truncate text-[13px] text-muted">File chosen</span>
      : props.offline ? <span className="truncate text-[13px] text-muted">File available when online</span>
      // The press downloads the file. It neither selects nor edits the cell.
      : props.download ? <span className="flex min-w-0" onClick={event => event.stopPropagation()}><CollectionAttachmentCell key={fileId} compact scope={props.scope} fieldName={field.name} fileId={fileId} disabled={false} read={props.download} onError={props.onError} /></span>
      : <span className="truncate text-[13px]">Attached file</span>}
    {editable ? <IconButton tabIndex={stop} className={`ml-auto shrink-0${target}`} aria-label={fileId === null ? `Add ${field.name}` : `Change ${field.name}`} title={fileId === null ? "Add file" : "Change file"}><Paperclip size={14} strokeWidth={1.9} aria-hidden /></IconButton> : null}
  </span>;
}

/**
 * The editor of a file or relation cell, in the table's overlay. An upload
 * and a search both take time and can fail, so the value saves on Save, not
 * on a press away. Escape and Cancel leave the record as it was.
 */
export function ResourceCellEditor(props: {
  scope: CollectionResourceScope;
  field: TransactionalField;
  initial: AppBackendJson;
  upload?: CollectionResources["uploadFile"];
  resolve?: CollectionResources["resolveRelation"];
  onError: CollectionResourceError;
  onSave(value: AppBackendJson): void;
  onClose(): void;
}) {
  const { field } = props;
  const [value, setValue] = useState(props.initial);
  const [uploading, setUploading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { root.current?.querySelector<HTMLElement>("input, button")?.focus(); }, []);
  const changed = JSON.stringify(value) !== JSON.stringify(props.initial);
  const input = { scope: props.scope, field, value, disabled: false, onChange: setValue, onError: props.onError };
  return <div ref={root} className="flex flex-col gap-2 p-2" onKeyDown={event => {
    if (event.defaultPrevented || isComposingKey(event) || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); props.onClose();
  }}>
    {field.type === "attachment" && props.upload ? <CollectionAttachmentInput {...input} upload={props.upload} onBusy={setUploading} />
      : props.resolve ? <CollectionRelationInput {...input} resolve={props.resolve} /> : null}
    <div className="flex justify-end gap-2">
      <SecondaryButton size="compact" onClick={props.onClose}>Cancel</SecondaryButton>
      {/* The table keeps this editor open, and comes back to Save, while it holds a value it has not saved. */}
      <PrimaryButton size="compact" data-unsaved={changed || undefined} disabled={uploading} onClick={() => { if (changed) props.onSave(value); props.onClose(); }}>Save</PrimaryButton>
    </div>
  </div>;
}
