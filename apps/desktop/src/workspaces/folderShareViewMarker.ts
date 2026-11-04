import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicCreateFile } from "../atomicReplaceFile";
import type { ShareViewIdentity } from "./registryStore";
import type { ShareViewSelector } from "./shareViewInfo";
import { recordedShareSelector } from "./shareViewRecords";
import { isValidShareId } from "./syncCode";
import { receivedReferencePin, type ReceivedReferencePin } from "./workspaceFileReferenceScopes";
import { existingLocalStateDir, localStateDir, localStateOpened, type LocalStateWorkspace } from "./workspaceLocalState";

// The folder's copy of a share view's marker, at `.dohc/local/share-view.json`.
// Forget removes the registry entry and keeps the folder, so this copy is what
// lets Open folder register the folder as the share again.
//
// It grants nothing. It names the share, the server and the account that
// opened it, so a refresh asks that server as that account, and the server
// decides. It holds no token, and no names, so a planted copy cannot show a
// false "Shared by". `.dohc` is outside capture, sync and the file tree, and
// the engine keeps `.dohc/local` out of iCloud Drive.
//
// dohc writes it once, as the last step of opening a share, and nothing
// removes it.

const MARKER_FILE = "share-view.json";
// Far above anything dohc writes: one path for each shared path.
const MAX_MARKER_BYTES = 1024 * 1024;

export interface FolderShareViewMarker {
  version: 1;
  // The folder's manifest id when the share opened.
  workspaceId: string;
  shareId: string;
  recipientUserId: string;
  relayUrl: string;
  grantedSelector: ShareViewSelector;
  granterUserId?: string;
  receivedIdentity?: ReceivedReferencePin;
}

// What the registry keeps for a folder whose marker dohc can't read: a share
// view, so restricted, with nothing to refresh. The summary shows it damaged.
const DAMAGED_SHARE_VIEW = {} as ShareViewIdentity;

/** Writes the marker of a share that just opened. Refuses to replace one. */
export async function writeFolderShareViewMarker(
  workspace: LocalStateWorkspace,
  marker: Omit<FolderShareViewMarker, "version">,
): Promise<void> {
  await localStateOpened(workspace);
  const path = join(await localStateDir(workspace), MARKER_FILE);
  const recorded: FolderShareViewMarker = {
    version: 1,
    workspaceId: marker.workspaceId,
    shareId: marker.shareId,
    recipientUserId: marker.recipientUserId,
    relayUrl: marker.relayUrl,
    grantedSelector: marker.grantedSelector,
    ...(marker.granterUserId ? { granterUserId: marker.granterUserId } : {}),
    ...(marker.receivedIdentity ? { receivedIdentity: marker.receivedIdentity } : {}),
  };
  if (!(await atomicCreateFile(path, `${JSON.stringify(recorded, null, 2)}\n`, 0o600))) {
    throw new Error("This folder already holds a share's record.");
  }
}

/**
 * The share view to register for a folder Open folder chose: none when the
 * folder has no marker, or a marker for another workspace; a damaged one when
 * dohc can't read it. Names stay null and every file on disk is kept until a
 * refresh, which runs only for the same account on the same server.
 */
export async function shareViewFromFolderMarker(
  workspace: { readonly workspaceId: string; readonly rootPath: string },
): Promise<ShareViewIdentity | undefined> {
  const marker = await readFolderShareViewMarker(workspace.rootPath);
  if (marker === "absent") return undefined;
  if (marker === "damaged") return { ...DAMAGED_SHARE_VIEW };
  // A marker copied from another workspace's folder says nothing about this
  // one: the manifest is the folder's identity.
  if (marker.workspaceId !== workspace.workspaceId) return undefined;
  return {
    shareId: marker.shareId,
    ...(marker.granterUserId ? { granterUserId: marker.granterUserId } : {}),
    granterEmail: null,
    subjectName: null,
    sharerName: null,
    genericChatWritable: false,
    grantedSelector: marker.grantedSelector,
    ...(marker.receivedIdentity ? { receivedIdentity: marker.receivedIdentity } : {}),
    relayUrl: marker.relayUrl,
    recipientUserId: marker.recipientUserId,
    unsavedPaths: null,
  };
}

async function readFolderShareViewMarker(rootPath: string): Promise<FolderShareViewMarker | "absent" | "damaged"> {
  // A read writes nothing, so it does not wait for the engine, which has not
  // opened a folder Open folder just chose.
  const dir = await existingLocalStateDir(rootPath);
  if (dir === null) return "absent";
  const path = join(dir, MARKER_FILE);
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : error);
  if (stats === null) return "absent";
  if (stats instanceof Error || !stats.isFile() || stats.size > MAX_MARKER_BYTES) return "damaged";
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return "damaged";
  }
  return parseFolderShareViewMarker(parsed) ?? "damaged";
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export function parseFolderShareViewMarker(value: unknown): FolderShareViewMarker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const grantedSelector = recordedShareSelector(raw.grantedSelector);
  const receivedIdentity = raw.receivedIdentity === undefined ? undefined : receivedReferencePin(raw.receivedIdentity);
  if (raw.version !== 1 || !boundedString(raw.workspaceId, 200) || typeof raw.shareId !== "string" ||
    !isValidShareId(raw.shareId) || !boundedString(raw.recipientUserId, 200) || !boundedString(raw.relayUrl, 2048) ||
    grantedSelector === null || (raw.granterUserId !== undefined && !boundedString(raw.granterUserId, 200)) ||
    (raw.receivedIdentity !== undefined && receivedIdentity === undefined)) {
    return null;
  }
  return {
    version: 1,
    workspaceId: raw.workspaceId,
    shareId: raw.shareId,
    recipientUserId: raw.recipientUserId,
    relayUrl: raw.relayUrl,
    grantedSelector,
    ...(typeof raw.granterUserId === "string" ? { granterUserId: raw.granterUserId } : {}),
    ...(receivedIdentity ? { receivedIdentity } : {}),
  };
}
