import { datasetBaseFolder, DATASET_METADATA_MAX_BYTES, parseDatasetRevision } from "@dohc/security-contract/dataset";
import { MAIN_VERSION_ID } from "../shareFilter";
import type { StorageContext } from "./context";
import { currentObjectPath } from "./currentFiles";

// Another relay process can share the database without clearing this
// process's answers, so each answer also expires.
const PRESENCE_TTL_MS = 2_000;
const MAX_WORKSPACES = 256;
const MAX_FOLLOWED_FILES = 8;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const remembered = new WeakMap<StorageContext, Map<string, Map<string, { present: boolean; expiresAtMs: number }>>>();

/** Call when the workspace's main files change: a push or a reset can delete or restore a dataset.json. */
export function forgetCollectionFilePresence(storage: StorageContext, workspaceId: string): void {
  remembered.get(storage)?.delete(workspaceId);
}

/**
 * Whether the server's copy of the workspace still has the Collection's
 * dataset.json: the file in the approved folder names the Collection or names
 * none, or a file that was there moved and still names it.
 */
export function collectionFilePresent(storage: StorageContext, workspaceId: string, datasetId: string, nowMs: number): boolean {
  let workspaces = remembered.get(storage);
  if (!workspaces) remembered.set(storage, workspaces = new Map());
  let datasets = workspaces.get(workspaceId);
  const cached = datasets?.get(datasetId);
  if (cached && cached.expiresAtMs > nowMs) return cached.present;
  const present = readPresence(storage, workspaceId, datasetId);
  if (!datasets) {
    if (workspaces.size >= MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value!);
    workspaces.set(workspaceId, datasets = new Map());
  }
  datasets.set(datasetId, { present, expiresAtMs: nowMs + PRESENCE_TTL_MS });
  return present;
}

function readPresence(storage: StorageContext, workspaceId: string, datasetId: string): boolean {
  const approved = storage.db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(workspaceId, datasetId);
  // The capability check already refuses a Collection this server doesn't keep.
  if (!approved) return true;
  const folder = datasetBaseFolder(parseDatasetRevision(JSON.parse(String(approved.revision_json))).definition);
  const path = folder === "." ? "dataset.json" : `${folder}/dataset.json`;
  const named = namedCollection(storage, workspaceId, path);
  if (named === null || named === datasetId) return true;
  // Moving a folder keeps its files' objects, so follow the files that were here,
  // whatever now sits at this path.
  const objects = storage.db.prepare(`SELECT object_id FROM sync_relay_object_moments
    WHERE workspace_id=? AND version_id=? AND path=? GROUP BY object_id ORDER BY MAX(relay_seq) DESC LIMIT ${MAX_FOLLOWED_FILES}`)
    .all(workspaceId, MAIN_VERSION_ID, path);
  return objects.some(({ object_id }) => {
    const moved = currentObjectPath(storage, { workspaceId, versionId: MAIN_VERSION_ID, objectId: String(object_id) });
    return !!moved && (moved === "dataset.json" || moved.endsWith("/dataset.json")) && namedCollection(storage, workspaceId, moved) === datasetId;
  });
}

/** The Collection a main dataset.json names: undefined with no file there, null when it names none. */
function namedCollection(storage: StorageContext, workspaceId: string, path: string): string | null | undefined {
  const file = storage.db.prepare(`SELECT f.blob_sha256, b.byte_length FROM sync_relay_current_files f
    LEFT JOIN sync_relay_blobs b ON b.workspace_id=f.workspace_id AND b.sha256=f.blob_sha256
    WHERE f.workspace_id=? AND f.version_id=? AND f.path=?`).get(workspaceId, MAIN_VERSION_ID, path);
  if (!file) return undefined;
  if (Number(file.byte_length) > DATASET_METADATA_MAX_BYTES) return null;
  try {
    const bytes = storage.getBlob(workspaceId, String(file.blob_sha256));
    const value: unknown = bytes && JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value && typeof value === "object" && "datasetId" in value && typeof value.datasetId === "string" && uuid.test(value.datasetId) ? value.datasetId : null;
  } catch { return null; }
}
