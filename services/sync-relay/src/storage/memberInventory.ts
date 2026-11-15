import { visibleSharePath, type ShareAccess } from "@dohc/security-contract/share-selector";
import { accessRuleFolder } from "@dohc/security-contract/access-rules";
import { createReceivedIdentity } from "../receivedIdentity";
import { authorizeShareAction } from "../shareAuthorization";
import { fileSideOf, isWorkspaceSelector } from "../shareFilter";
import { notFound } from "../errors";
import type { StorageContext } from "./context";

export interface MemberInventory {
  watermark: number;
  revision: string;
  folders: Array<{ path: string; level: ShareAccess }>;
  rootLevel: ShareAccess | null;
  files: Array<{ objectToken: string; path: string; blob_sha256: string; content_kind: string }>;
  objects: string[];
}

export function memberInventory(
  storage: StorageContext,
  shareId: string,
  userId: string,
  key: string | Uint8Array,
): MemberInventory {
  return storage.readShareTx(() => {
    const authorized = authorizeShareAction({
      storage,
      shareId,
      actorUserId: userId,
      action: "read",
    });
    if (!authorized.ok || !isWorkspaceSelector(authorized.effectiveSelector)) throw notFound();
    const selector = authorized.effectiveSelector,
      reach = selector.reach!;
    const files = fileSideOf(selector)!;
    const workspace = authorized.share.workspaceId;
    const identity = createReceivedIdentity(key),
      recipient = ["user", userId] as const;
    const folders = new Set([""]);
    const current = storage.db
      .prepare(`SELECT m.object_id, f.path, f.blob_sha256, f.content_kind FROM sync_relay_current_files f
      JOIN sync_relay_object_moments m ON m.workspace_id = f.workspace_id AND m.version_id = f.version_id
        AND m.path = f.path AND m.relay_seq = f.state_relay_seq
      WHERE f.workspace_id = ? AND f.version_id = 'main' ORDER BY f.path`)
      .all(workspace);
    for (const row of current) {
      let folder = accessRuleFolder(String(row.path));
      while (folder) {
        folders.add(folder);
        folder = accessRuleFolder(folder);
      }
    }
    const objects = storage.db
      .prepare(`SELECT DISTINCT object_id FROM sync_relay_object_moments
      WHERE workspace_id = ? AND version_id = 'main' ORDER BY object_id`)
      .all(workspace)
      .filter((row) => reach.objectVisible(String(row.object_id)))
      .map((row) => identity.object(recipient, workspace, String(row.object_id))!);
    return {
      watermark: Number(
        storage.db
          .prepare("SELECT MAX(relay_seq) AS seq FROM sync_relay_log WHERE workspace_id = ?")
          .get(workspace)?.seq ?? 0,
      ),
      revision: reach.revision,
      rootLevel: reach.folderLevel(""),
      folders: [...folders].sort().flatMap((path) => {
        const level = reach.folderLevel(path);
        return level === null ? [] : [{ path, level }];
      }),
      files: current
        .filter(
          (row) =>
            visibleSharePath(files, String(row.path)) !== null &&
            reach.objectVisible(String(row.object_id)),
        )
        .map((row) => ({
          objectToken: identity.object(recipient, workspace, String(row.object_id))!,
          path: String(row.path),
          blob_sha256: String(row.blob_sha256),
          content_kind: String(row.content_kind),
        })),
      objects,
    };
  });
}
