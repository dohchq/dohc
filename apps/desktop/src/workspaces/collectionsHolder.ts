import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DOHC_COLLECTIONS_GUARD, type DohcPathGuard } from "@dohc/workspace-core";
import { COLLECTIONS_REFUSAL_CODE, KEEP_COLLECTIONS_HERE, type CollectionsRefusalKind } from "../ipc/errorWords";
import { atomicWriteFile } from "../atomicReplaceFile";
import { computerOf, guardedFileExists, parseObject, readGuardedFile, type Computer } from "./syncHistory";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// Which installation of dohc keeps a workspace's Collections, recorded in
// .dohc/collections.json. Their store, .dohc/datasets/state.sqlite with its
// -wal and -shm, is the only copy of their records, files, approvals and
// History. iCloud Drive, Dropbox or a copied folder carries those files to
// other computers one by one, so a computer could open an older copy, or
// write its own, and changes would be lost. So only the installation the
// record names opens the store. Every other one refuses, creates nothing,
// and says which computer keeps the Collections.
//
// The record also names the store by a random id that the store keeps in
// local_dataset_store. The holder opens only the store with that id, so a
// copy from another computer, or a backup, that took its place is refused.
//
// A new workspace names the installation that made it, with no store id
// until that installation first creates the store. A workspace from before
// the record has none, and no computer opens or creates its store until a
// person keeps the Collections on one. dohc never claims them by itself: a
// synced folder can bring the record or the store late, after another
// computer already keeps them. A record dohc cannot read blocks the same way.
//
// The record sits beside manifest.json, so a synced folder carries it, and
// outside .dohc/datasets, which opening the store creates, and .dohc/local,
// which iCloud Drive skips. .dohc resolves through resolveWorkspaceMetadataDir,
// and a link or folder at the record's name is refused, never followed.
//
// A workspace that syncs through a server, or opened as a share, does not
// use the record.

/** The record: who keeps the Collections, and the id of their store once made. */
export interface CollectionsHolder {
  computer: Computer;
  storeId: string | null;
}

/** Why this installation cannot use the workspace's Collections store. */
export type CollectionsRefusal =
  /** No record names a computer. */
  | { kind: "unclaimed" }
  /** Another installation keeps them. */
  | { kind: "elsewhere"; computer: Computer; sameName: boolean }
  /** dohc cannot read the record, or it is not a file. */
  | { kind: "unreadable"; words: string }
  /** This installation keeps them, but their store is not there. */
  | { kind: "missing" }
  /** This installation keeps them, but another store took their store's place. */
  | { kind: "replaced" };

const RECORD = "collections.json";
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STORE_PATH = ".dohc/datasets/state.sqlite";
const UNREADABLE = `${DOHC_COLLECTIONS_GUARD.lead} Restore ${DOHC_COLLECTIONS_GUARD.path}, or update dohc. Then retry.`;

/** The words for a refusal, as a person, an agent and the CLI read them. */
function collectionsRefusalMessage(refusal: CollectionsRefusal): string {
  switch (refusal.kind) {
    case "unclaimed":
      return `dohc doesn't know which computer keeps this workspace's Collections. If it's this one, choose ${KEEP_COLLECTIONS_HERE}.`;
    case "elsewhere": {
      const where = refusal.sameName
        ? `${refusal.computer.label}, another installation of dohc with this computer's name`
        : refusal.computer.label;
      return `These Collections are on ${where}. Open this workspace there to use them, or to move them to a server.`;
    }
    case "unreadable":
      return refusal.words;
    case "missing":
      return `This computer keeps this workspace's Collections, but ${STORE_PATH} is not there. Restore it from a backup, then try again.`;
    case "replaced":
      return `This computer keeps this workspace's Collections, but another copy replaced ${STORE_PATH}. Restore this computer's copy from a backup, then try again.`;
  }
}

/**
 * A typed refusal. Nothing opened or created a store. Its code crosses IPC,
 * so the desktop can offer what fits; its message is the same words for
 * every caller.
 */
export class CollectionsRefusalError extends Error {
  override name = "CollectionsRefusalError";
  readonly refusal: CollectionsRefusal;
  readonly code: `${typeof COLLECTIONS_REFUSAL_CODE}${CollectionsRefusalKind}`;

  constructor(refusal: CollectionsRefusal) {
    super(collectionsRefusalMessage(refusal));
    this.refusal = refusal;
    this.code = `${COLLECTIONS_REFUSAL_CODE}${refusal.kind}`;
  }
}

/** Whether a workspace's Collections need a holder, and who this installation is. */
export interface CollectionsHolderCheck {
  here(): Computer;
  /** False while the workspace syncs through a server, even paused, or opened as a share. */
  required(): boolean;
}

/**
 * Whether a workspace's Collections need a holder: it does not sync through
 * a server, even paused, and did not open as a share. A workspace the
 * registry does not list needs one.
 */
export function collectionsHolderRequired(entry: { remote?: unknown; pausedRemote?: unknown; shareView?: unknown } | null | undefined): boolean {
  return entry?.remote === undefined && entry?.pausedRemote === undefined && entry?.shareView === undefined;
}

type RecordRead = { kind: "absent" } | { kind: "holder"; holder: CollectionsHolder };

const refused = (refusal: CollectionsRefusal) => new CollectionsRefusalError(refusal);

// Exactly these five fields, each well formed, for this workspace. Anything
// else may be a record dohc cannot understand, so it names nobody.
function parseRecord(text: string, workspaceId: string): CollectionsHolder | null {
  const parsed = parseObject(text);
  if (parsed === null || Object.keys(parsed).length !== 5) return null;
  const { version, workspaceId: recorded, installId, label, storeId } = parsed;
  const computer = computerOf({ installId, label });
  if (version !== 1 || recorded !== workspaceId || computer === null) return null;
  if (storeId !== null && (typeof storeId !== "string" || !STORE_ID.test(storeId))) return null;
  return { computer, storeId };
}

// A guard's own refusal, which says what to remove, or the general words.
function wordsOf(error: unknown, guard: DohcPathGuard): string {
  return error instanceof Error && error.message.startsWith(guard.lead) ? error.message : UNREADABLE;
}

async function recordPath(rootPath: string): Promise<string | null> {
  try {
    const metadata = await resolveWorkspaceMetadataDir(rootPath, { create: false });
    return metadata === null ? null : join(metadata, RECORD);
  } catch (error) {
    throw refused({ kind: "unreadable", words: error instanceof Error ? error.message : UNREADABLE });
  }
}

async function readRecord(rootPath: string, workspaceId: string): Promise<RecordRead> {
  const path = await recordPath(rootPath);
  if (path === null) return { kind: "absent" };
  const read = await readGuardedFile(path, DOHC_COLLECTIONS_GUARD);
  if (read.kind === "absent") return read;
  if (read.kind === "failed") throw refused({ kind: "unreadable", words: wordsOf(read.error, DOHC_COLLECTIONS_GUARD) });
  const holder = parseRecord(read.text, workspaceId);
  if (holder === null) throw refused({ kind: "unreadable", words: UNREADABLE });
  return { kind: "holder", holder };
}

function recordText(workspaceId: string, { computer, storeId }: CollectionsHolder): string {
  return `${JSON.stringify({ version: 1, workspaceId, installId: computer.installId, label: computer.label, storeId })}\n`;
}

async function writeRecord(rootPath: string, workspaceId: string, holder: CollectionsHolder): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), RECORD);
  // Refuse a link or a folder before replacing the record.
  await guardedFileExists(path, DOHC_COLLECTIONS_GUARD);
  await atomicWriteFile(path, recordText(workspaceId, holder));
}

/** Whether any file of a Collections store is in the workspace. Checking creates nothing. */
async function collectionsStorePresent(rootPath: string): Promise<boolean> {
  const store = join(rootPath, STORE_PATH);
  const present = await Promise.all([store, `${store}-wal`, `${store}-shm`].map((path) =>
    lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    })));
  return present.includes(true);
}

/**
 * A new workspace's Collections belong to `here`, which has no store for
 * them yet. A record already there stays.
 */
export async function recordNewCollectionsHolder(rootPath: string, workspaceId: string, here: Computer): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), RECORD);
  // Whole or not at all: a record cut short would block the Collections.
  if (!(await guardedFileExists(path, DOHC_COLLECTIONS_GUARD))) await atomicWriteFile(path, recordText(workspaceId, { computer: here, storeId: null }));
}

/**
 * The record names this installation, or this throws why not. Given the id
 * an open store keeps, or null when it keeps none, the record must name
 * that store.
 */
export async function heldHere(rootPath: string, workspaceId: string, here: Computer, openStoreId?: string | null): Promise<CollectionsHolder> {
  const read = await readRecord(rootPath, workspaceId);
  if (read.kind === "absent") throw refused({ kind: "unclaimed" });
  const { computer, storeId } = read.holder;
  if (computer.installId !== here.installId) throw refused({ kind: "elsewhere", computer, sameName: computer.label === here.label });
  if (openStoreId === undefined) return read.holder;
  // An open store the record does not name yet may be another computer's.
  if (storeId === null) throw refused({ kind: "unclaimed" });
  if (storeId !== openStoreId) throw refused({ kind: "replaced" });
  return read.holder;
}

/**
 * What this installation may do with the workspace's Collections store:
 * create it, open the one with `storeId`, or either as before when no
 * holder is required. Otherwise this throws a CollectionsRefusalError
 * before anything is created.
 */
export type CollectionsAdmission =
  | { kind: "unguarded" }
  | { kind: "create"; storeId: string }
  | { kind: "open"; storeId: string };

export async function admitCollectionsStore(rootPath: string, workspaceId: string, check: CollectionsHolderCheck): Promise<CollectionsAdmission> {
  if (!check.required()) return { kind: "unguarded" };
  const { storeId } = await heldHere(rootPath, workspaceId, check.here());
  if (storeId === null) {
    // A store the record never named may be another computer's.
    if (await collectionsStorePresent(rootPath)) throw refused({ kind: "unclaimed" });
    return { kind: "create", storeId: randomUUID() };
  }
  const store = await lstat(join(rootPath, STORE_PATH)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (store === null) throw refused({ kind: "missing" });
  return { kind: "open", storeId };
}

/**
 * The store with `storeId` was just created here, so the record names it
 * from now on. Throws when the record no longer names this installation
 * without a store.
 */
export async function recordCollectionsStore(rootPath: string, workspaceId: string, here: Computer, storeId: string): Promise<void> {
  if ((await heldHere(rootPath, workspaceId, here)).storeId !== null) throw refused({ kind: "replaced" });
  await writeRecord(rootPath, workspaceId, { computer: here, storeId });
}

/**
 * A person chose to keep the workspace's Collections on this computer. Only
 * Collections that no record names can be kept: another computer's stay
 * there. `adoptStore` writes a new id into a store already here, before the
 * record names it.
 */
export async function keepCollectionsHere(
  rootPath: string,
  workspaceId: string,
  here: Computer,
  adoptStore: (storeId: string) => Promise<void>,
): Promise<void> {
  const read = await readRecord(rootPath, workspaceId);
  if (read.kind === "holder") {
    const { computer, storeId } = read.holder;
    if (computer.installId !== here.installId) throw refused({ kind: "elsewhere", computer, sameName: computer.label === here.label });
    if (storeId !== null) return;
  }
  if (!(await collectionsStorePresent(rootPath))) {
    await writeRecord(rootPath, workspaceId, { computer: here, storeId: null });
    return;
  }
  const storeId = randomUUID();
  await adoptStore(storeId);
  await writeRecord(rootPath, workspaceId, { computer: here, storeId });
}
