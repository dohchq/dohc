import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "./ui/ConfirmDialog";

export function DeleteCollectionRecordDialog(props: { collectionName: string; recordId: string | number; onCancel(): void; onConfirm(): void }) {
  return <ConfirmDialog intent="danger" icon={Trash2} title={`Delete record from ${props.collectionName}?`} confirmLabel="Delete record"
    testId="delete-collection-record" cancelTestId="delete-collection-record-cancel" confirmTestId="delete-collection-record-confirm"
    onCancel={props.onCancel} onConfirm={props.onConfirm}>
    <p>This deletes record <span className="font-mono text-[12px]">{props.recordId}</span>. You cannot undo this deletion in dohc.</p>
  </ConfirmDialog>;
}
