import {normalizeShareLabel, type ShareLabels} from "@dohc/security-contract/share-labels";
import type {StorageContext} from "./context";
export function getShareLabels(storage: StorageContext, shareId: string): ShareLabels {
  const row = storage.db.prepare("SELECT subject_name FROM sync_relay_share_labels WHERE share_id = ?").get(shareId);
  return {subjectName: normalizeShareLabel(row?.subject_name)};
}
export function setShareLabels(storage: StorageContext, shareId: string, labels: ShareLabels, updatedAtMs: number): void {
  storage.db.prepare(`INSERT INTO sync_relay_share_labels (share_id, subject_name, updated_at_ms)
    VALUES (?, ?, ?) ON CONFLICT (share_id) DO UPDATE SET subject_name = excluded.subject_name,
    updated_at_ms = excluded.updated_at_ms`)
    .run(shareId, normalizeShareLabel(labels.subjectName), Math.trunc(updatedAtMs));
}
