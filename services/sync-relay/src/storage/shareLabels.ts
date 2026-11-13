import {normalizeShareLabel, type ShareLabels} from "@dohc/security-contract/share-labels";
import type {StorageContext} from "./context";
import {shareLabelFor, type ShareLabelReader} from "../shareFilter";
// The label is stored as the owner wrote it and withheld as it is read, so
// a label stored before a link was withheld reads the same way.
export function getShareLabels(storage: StorageContext, shareId: string, reader: ShareLabelReader): ShareLabels {
  const row = storage.db.prepare(`SELECT l.subject_name, s.selector_json FROM sync_relay_share_labels l
    JOIN sync_relay_shares s ON s.share_id = l.share_id WHERE l.share_id = ?`).get(shareId);
  const stored = normalizeShareLabel(row?.subject_name);
  return {subjectName: normalizeShareLabel(shareLabelFor(String(row?.selector_json), stored, reader))};
}
export function setShareLabels(storage: StorageContext, shareId: string, labels: ShareLabels, updatedAtMs: number): void {
  storage.db.prepare(`INSERT INTO sync_relay_share_labels (share_id, subject_name, updated_at_ms)
    VALUES (?, ?, ?) ON CONFLICT (share_id) DO UPDATE SET subject_name = excluded.subject_name,
    updated_at_ms = excluded.updated_at_ms`)
    .run(shareId, normalizeShareLabel(labels.subjectName), Math.trunc(updatedAtMs));
}
