import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

export function DeleteCollectionRecordDialog(props: { collectionName: string; recordId: string | number; onCancel(): void; onConfirm(): void }) {
  return <Overlay appearance="warning" onClose={props.onCancel} panelProps={{ role: "dialog", "aria-modal": true, "aria-labelledby": "delete-collection-record-title" }}>
    <div className="dohc-elevated w-110 max-w-[85vw] rounded-xl border border-line bg-panel p-5">
      <h2 id="delete-collection-record-title" className="m-0 text-sm font-semibold text-ink">Delete record from {props.collectionName}?</h2>
      <p className="text-[13px] text-muted">This deletes record <span className="font-mono">{props.recordId}</span>. You cannot undo this deletion in dohc.</p>
      <div className="flex justify-end gap-2"><SecondaryButton onClick={props.onCancel}>Cancel</SecondaryButton><PrimaryButton onClick={props.onConfirm}>Delete record</PrimaryButton></div>
    </div>
  </Overlay>;
}
