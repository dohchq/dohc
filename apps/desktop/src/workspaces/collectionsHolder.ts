import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DOHC_COLLECTIONS_GUARD, DOHC_METADATA_GUARD, notAFileRefusal, notARealFolderRefusal, type DohcPathGuard } from "@dohc/workspace-core";
import { COLLECTIONS_REFUSAL_CODE, USE_THIS_COMPUTER, collectionsElsewhereWords, type CollectionsRefusalKind } from "../ipc/errorWords";
import { atomicWriteFile } from "../atomicReplaceFile";
import { computerOf, guardedFileExists, parseObject, readGuardedFile, type Computer } from "./syncHistory";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { OLD_STORE_PATH, STORE_PATH } from "./localDatasetFolders";

// Which installation of dohc keeps a workspace's Collections, recorded in
// .dohc/collections.json. Their store, .dohc/local/datasets/state.sqlite with
// its -wal and -shm, is the only copy of their records, files, approvals and
// History. iCloud Drive skips .dohc/local, but Dropbox or a copied folder can
// carry those files to other computers one by one, and the store was in
// .dohc/datasets, which iCloud Drive syncs, before .dohc/local. A computer
// could open an older copy, or write its own, and changes would be lost. So
// only the installation the record names opens the store, and only it moves
// a store from .dohc/datasets. Every other one refuses, creates nothing, and
// says which computer keeps the Collections. It can still use the ones moved
// to its signed-in server, which it asks without opening a store.
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
// outside .dohc/local, which iCloud Drive skips. .dohc resolves through
// resolveWorkspaceMetadataDir, and a link or folder at the record's name is
// refused, never followed.
//
// Claims, adoptions and new stores run one at a time per workspace in this
// process, and each checks just before it writes that the record is still
// the one it read. That gives no exclusion across computers: two computers
// that keep the Collections at once through iCloud Drive can both write.
// Then the store id catches the one whose record lost, as "elsewhere" or
// "replaced", and it stops.
//
// An open store reads the record before each piece of work, so a record that
// names another computer or store stops the next write, with no wait between.
//
// A server's sync never carries .dohc, so a workspace that syncs through a
// server keeps the record too. Only a received share does not use it.

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
  /** This installation keeps them, but another store took their store's place at `path`. */
  | { kind: "replaced"; path: string }
  /** The record changed between reading it and writing it. */
  | { kind: "changed" };

const RECORD = "collections.json";
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNREADABLE = `${DOHC_COLLECTIONS_GUARD.lead} Restore ${DOHC_COLLECTIONS_GUARD.path}, or update dohc. Then retry.`;

/** The words for a refusal, as a person, an agent and the CLI read them. */
function collectionsRefusalMessage(refusal: CollectionsRefusal): string {
  switch (refusal.kind) {
    case "unclaimed":
      return `dohc doesn't know which computer keeps this workspace's Collections. To keep them on this computer, choose ${USE_THIS_COMPUTER} in dohc.`;
    case "elsewhere":
      return collectionsElsewhereWords({ label: refusal.computer.label, sameName: refusal.sameName });
    case "unreadable":
      return refusal.words;
    case "missing":
      return `This computer keeps this workspace's Collections, but ${STORE_PATH} is not there. Restore it from a backup, then try again.`;
    case "replaced":
      return `This computer keeps this workspace's Collections, but another copy replaced ${refusal.path}. Restore this computer's copy from a backup, then try again.`;
    case "changed":
      return `dohc did not record which computer keeps this workspace's Collections, because ${DOHC_COLLECTIONS_GUARD.path} changed meanwhile. Try again.`;
  }
}

/**
 * A typed refusal. Nothing opened or created a store. Its code, and the
 * name of the computer that keeps the Collections, cross IPC, so the desktop
 * can offer what fits; its message is the same words for every caller.
 */
export class CollectionsRefusalError extends Error {
  override name = "CollectionsRefusalError";
  readonly refusal: CollectionsRefusal;
  readonly code: `${typeof COLLECTIONS_REFUSAL_CODE}${CollectionsRefusalKind}`;
  readonly computerLabel: string | null;

  constructor(refusal: CollectionsRefusal) {
    super(collectionsRefusalMessage(refusal));
    this.refusal = refusal;
    this.code = `${COLLECTIONS_REFUSAL_CODE}${refusal.kind}`;
    this.computerLabel = refusal.kind === "elsewhere" ? refusal.computer.label : null;
  }
}

/** Whether a workspace's Collections need a holder, and who this installation is. */
export interface CollectionsHolderCheck {
  here(): Computer;
  /** False for a workspace that opened as a share. */
  required(): boolean;
}

/**
 * Whether a workspace's Collections need a holder: every workspace of the
 * person's own does, whether or not it syncs through a server. A received
 * share does not.
 */
export function collectionsHolderRequired(entry: { shareView?: unknown } | null | undefined): boolean {
  return entry?.shareView === undefined;
}

type RecordRead = { kind: "absent" } | { kind: "holder"; holder: CollectionsHolder; text: string };

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
  return { kind: "holder", holder, text: read.text };
}

function recordText(workspaceId: string, { computer, storeId }: CollectionsHolder): string {
  return `${JSON.stringify({ version: 1, workspaceId, installId: computer.installId, label: computer.label, storeId })}\n`;
}

// Refuses when the record is no longer the one read as `seen`.
async function assertUnchanged(rootPath: string, workspaceId: string, seen: RecordRead): Promise<void> {
  const now = await readRecord(rootPath, workspaceId).catch(() => null);
  const same = now !== null && (now.kind === "absent" ? seen.kind === "absent" : seen.kind === "holder" && now.text === seen.text);
  if (!same) throw refused({ kind: "changed" });
}

// Replaces the record read as `seen`, or refuses when it changed since.
async function replaceRecord(rootPath: string, workspaceId: string, seen: RecordRead, holder: CollectionsHolder): Promise<void> {
  await assertUnchanged(rootPath, workspaceId, seen);
  const path = join(await resolveWorkspaceMetadataDir(rootPath), RECORD);
  // Refuse a link or a folder before replacing the record.
  await guardedFileExists(path, DOHC_COLLECTIONS_GUARD);
  await atomicWriteFile(path, recordText(workspaceId, holder));
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `work` after every claim, adoption or new store in the workspace
 * that this process started before it.
 */
export function holderWork<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(workspaceId) ?? Promise.resolve()).then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(workspaceId, settled);
  void settled.then(() => { if (queues.get(workspaceId) === settled) queues.delete(workspaceId); });
  return run;
}

const present = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
  throw error;
});

/**
 * Whether any file of a Collections store is in the workspace, in
 * .dohc/local or where stores were before it. A copy there may be another
 * computer's, until iCloud Drive removes it. Checking creates nothing.
 */
async function collectionsStorePresent(rootPath: string): Promise<boolean> {
  const files = [STORE_PATH, OLD_STORE_PATH].flatMap((store) => [store, `${store}-wal`, `${store}-shm`]);
  return (await Promise.all(files.map((file) => present(join(rootPath, file))))).includes(true);
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

type Elsewhere = Extract<CollectionsRefusal, { kind: "elsewhere" }>;
const elsewhereOf = (computer: Computer, here: Computer): Elsewhere => ({ kind: "elsewhere", computer, sameName: computer.label === here.label });

function heldBy(read: RecordRead, here: Computer): CollectionsHolder {
  if (read.kind === "absent") throw refused({ kind: "unclaimed" });
  const { computer } = read.holder;
  if (computer.installId !== here.installId) throw refused(elsewhereOf(computer, here));
  return read.holder;
}

/**
 * Whether the record names another installation, which keeps the
 * Collections, read from the record alone. Null for anything else: this
 * installation keeps them, no computer does yet, the workspace needs no
 * holder, or dohc cannot read the record. Those still take the store's own
 * admission, which refuses as before.
 */
export async function collectionsKeptElsewhere(rootPath: string, workspaceId: string, check: CollectionsHolderCheck): Promise<Elsewhere | null> {
  if (!check.required()) return null;
  const read = await readRecord(rootPath, workspaceId).catch(() => null);
  if (read?.kind !== "holder") return null;
  const here = check.here();
  return read.holder.computer.installId === here.installId ? null : elsewhereOf(read.holder.computer, here);
}

/**
 * What this installation may do with the workspace's Collections store:
 * create it, open the one with `storeId`, or either as before when no
 * holder is required. `seen` is the record read. Otherwise this throws a
 * CollectionsRefusalError before anything is created.
 */
export type CollectionsAdmission =
  | { kind: "unguarded" }
  | { kind: "create"; storeId: string; seen: RecordRead }
  | { kind: "open"; storeId: string };

export async function admitCollectionsStore(rootPath: string, workspaceId: string, check: CollectionsHolderCheck): Promise<CollectionsAdmission> {
  if (!check.required()) return { kind: "unguarded" };
  const seen = await readRecord(rootPath, workspaceId);
  const { storeId } = heldBy(seen, check.here());
  if (storeId === null) {
    // A store the record never named may be another computer's.
    if (await collectionsStorePresent(rootPath)) throw refused({ kind: "unclaimed" });
    return { kind: "create", storeId: randomUUID(), seen };
  }
  // A store still where stores were before .dohc/local is moved when it opens.
  if (!(await present(join(rootPath, STORE_PATH))) && !(await present(join(rootPath, OLD_STORE_PATH)))) throw refused({ kind: "missing" });
  return { kind: "open", storeId };
}

/**
 * The store with `storeId` was just created here, so the record names it
 * from now on. Refuses when the record changed since admission read it.
 */
export async function recordCollectionsStore(rootPath: string, workspaceId: string, here: Computer, storeId: string, seen: RecordRead): Promise<void> {
  await replaceRecord(rootPath, workspaceId, seen, { computer: here, storeId });
}

/**
 * The check an open store makes before each piece of work, with nothing
 * awaited: the record still names this installation and the store's id.
 * File times and sizes cannot prove that the record is unchanged.
 * Throws a CollectionsRefusalError when it no longer holds the store.
 */
export function createHoldingCheck(rootPath: string, workspaceId: string, check: CollectionsHolderCheck, storeId: () => string | null): () => void {
  const metadata = join(rootPath, ".dohc"), path = join(metadata, RECORD);
  return () => {
    if (!check.required()) return;
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stats === undefined) throw refused({ kind: "unclaimed" });
    const folder = lstatSync(metadata);
    if (folder.isSymbolicLink() || !folder.isDirectory()) throw refused({ kind: "unreadable", words: notARealFolderRefusal(DOHC_METADATA_GUARD, folder) });
    if (!stats.isFile()) throw refused({ kind: "unreadable", words: notAFileRefusal(DOHC_COLLECTIONS_GUARD, stats) });
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { throw refused({ kind: "unreadable", words: UNREADABLE }); }
    const holder = parseRecord(text, workspaceId);
    if (holder === null) throw refused({ kind: "unreadable", words: UNREADABLE });
    heldBy({ kind: "holder", holder, text }, check.here());
    // An open store the record does not name yet may be another computer's.
    if (holder.storeId === null) throw refused({ kind: "unclaimed" });
    if (holder.storeId !== storeId()) throw refused({ kind: "replaced", path: STORE_PATH });
  };
}

/** What a person confirms before dohc keeps the Collections here. */
export type KeepQuestion =
  /** Another computer made the workspace, so its Collections may still be syncing. */
  | { kind: "made-elsewhere"; computer: Computer }
  /** The record names another installation, which may be this computer before dohc was set up again. */
  | { kind: "earlier-installation"; computer: Computer };

/** The question's words: a title, and what the person weighs. */
export function keepQuestionWords(question: KeepQuestion): { message: string; detail: string } {
  const { label } = question.computer;
  const message = "Use this computer for these Collections?";
  return question.kind === "made-elsewhere"
    ? { message, detail: `${label} made this workspace. Its Collections may still be syncing from there. If you keep them here before they arrive, this computer can replace ${label}'s Collections.` }
    : { message, detail: `${label} keeps these Collections. If ${label} was this computer before dohc was set up again, keep them here. If ${label} is another computer that still uses them, don't, or its changes can be lost.` };
}

export interface KeepSteps {
  /** Writes a new id into the store here, refusing a store with nothing in it. */
  adoptStore(storeId: string): Promise<void>;
  /** The id the store here keeps, or null when there is none. Creates nothing. */
  storeIdHere(): Promise<string | null>;
  /** The installation that made the workspace, as its sync history records it, or null. */
  madeBy(): Promise<Computer | null>;
  /** Asks the person; false when they did not confirm. */
  confirm(question: KeepQuestion): Promise<boolean>;
}

/**
 * A person chose to keep the workspace's Collections on this computer.
 * False when they did not confirm a question this asked first.
 *
 * - No record, or one naming this computer without a store id: a store
 *   here takes a new id, then the record names it. When another computer
 *   made the workspace, the person confirms first, since its Collections
 *   may still be syncing. Without that, a store here with no record naming
 *   it is one a creation cut short left.
 * - A record naming another installation: this computer may be that one
 *   before dohc was set up again. The person confirms, and only the store
 *   the record names, here, is kept: the record changes installation and
 *   label, never the store id. A record naming no store yet can be kept
 *   only where there is no store, since no store here could match it.
 */
export async function keepCollectionsHere(rootPath: string, workspaceId: string, here: Computer, steps: KeepSteps): Promise<boolean> {
  const seen = await readRecord(rootPath, workspaceId);
  const elsewhere = seen.kind === "holder" && seen.holder.computer.installId !== here.installId ? seen.holder : null;
  if (seen.kind === "holder" && elsewhere === null && seen.holder.storeId !== null) return true;
  const refuseElsewhere = (holder: CollectionsHolder) => refused(elsewhereOf(holder.computer, here));
  let question: KeepQuestion | null = null;
  if (elsewhere !== null) {
    if (elsewhere.storeId === null && await collectionsStorePresent(rootPath)) throw refuseElsewhere(elsewhere);
    question = { kind: "earlier-installation", computer: elsewhere.computer };
  } else {
    const madeBy = await steps.madeBy();
    if (madeBy !== null && madeBy.installId !== here.installId) question = { kind: "made-elsewhere", computer: madeBy };
  }
  if (question !== null && !(await steps.confirm(question))) return false;
  return holderWork(workspaceId, async () => {
    await assertUnchanged(rootPath, workspaceId, seen);
    const present = await collectionsStorePresent(rootPath);
    if (elsewhere !== null) {
      if (elsewhere.storeId === null) {
        if (present) throw refuseElsewhere(elsewhere);
        await replaceRecord(rootPath, workspaceId, seen, { computer: here, storeId: null });
        return true;
      }
      if ((await steps.storeIdHere()) !== elsewhere.storeId) throw new Error(`This computer doesn't have ${elsewhere.computer.label}'s copy of the Collections.`);
      await replaceRecord(rootPath, workspaceId, seen, { computer: here, storeId: elsewhere.storeId });
      return true;
    }
    if (!present) {
      await replaceRecord(rootPath, workspaceId, seen, { computer: here, storeId: null });
      return true;
    }
    const storeId = randomUUID();
    await steps.adoptStore(storeId);
    await replaceRecord(rootPath, workspaceId, seen, { computer: here, storeId });
    return true;
  });
}
