import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { notARealFolderRefusal, notOnlyYoursRefusal, outsideWorkspaceRefusal, type DohcPathGuard } from "@dohc/workspace-core";
import { ownedFileRefusal } from "@dohc/workspace-core/owned-file";
import { isInside } from "../security/pathContainment";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// `.dohc/local` holds what belongs to this computer rather than the
// workspace, such as its layout, and the Collections when this computer
// keeps them. It is not a cache: some of it is the only copy, so nothing
// removes the folder as a whole. Only the engine creates it: each open that
// writes makes it private and, on a Mac, marks it so that file-provider
// services such as iCloud Drive skip it, before anything is written in it.
// A writer that created the folder itself would leave it unmarked, so
// writers get it only from localStateDir.

export interface LocalStateWorkspace {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly attachmentId?: symbol;
}

/** What the engine's current open of a workspace said about `.dohc/local`. */
export interface LocalStateBindings {
  currentBinding(workspace: LocalStateWorkspace): { readonly localStateReady: boolean } | null;
  /** The engine open of the workspace already under way, or null. Never starts one. */
  openInProgress?(workspace: LocalStateWorkspace): Promise<unknown> | null;
  /**
   * The current open of a workspace at `rootPath` that prepared
   * `.dohc/local`, once an open under way settles, or null, for a reader that
   * knows only the root. Never starts an open.
   */
  localStateOpenAt(rootPath: string): Promise<LocalStateOpen | null>;
}

/** An engine open that prepared `.dohc/local`. */
export interface LocalStateOpen {
  /** Whether it is still the workspace's current open, and so has held the folder since. */
  current(): boolean;
}

export type LocalStateRefusal = "not-opened" | "not-excluded";

const REFUSAL_WORDS: Record<LocalStateRefusal, string> = {
  "not-opened": "dohc has not finished opening this workspace. Try again when it opens.",
  "not-excluded": "dohc could not keep this workspace's .dohc/local out of iCloud Drive, so it saves nothing there. Restart dohc to try again.",
};

/**
 * dohc won't write this computer's state for a workspace. A writer whose
 * refusal a person sees gives words that name what it did not save.
 */
export class LocalStateUnavailableError extends Error {
  constructor(readonly refusal: LocalStateRefusal, message = REFUSAL_WORDS[refusal]) {
    super(message);
    this.name = "LocalStateUnavailableError";
  }
}

let bindings: LocalStateBindings | null = null;

/** The engine sessions set this once; readiness lives and ends with their bindings. */
export function readLocalStateFrom(source: LocalStateBindings | null): void {
  bindings = source;
}

function currentBinding(workspace: LocalStateWorkspace) {
  try {
    return bindings?.currentBinding(workspace) ?? null;
  } catch {
    return null;
  }
}

/**
 * The workspace's `.dohc/local`, for a writer. Refuses with
 * LocalStateUnavailableError unless the engine's current open of the
 * workspace prepared it, still does once dohc has looked at the folder, and
 * the folder is a real folder in the workspace. Never creates anything.
 */
export async function localStateDir(workspace: LocalStateWorkspace): Promise<string> {
  const binding = currentBinding(workspace);
  if (binding === null) throw new LocalStateUnavailableError("not-opened");
  if (!binding.localStateReady) throw new LocalStateUnavailableError("not-excluded");
  const dir = await existingLocalStateDir(workspace.rootPath);
  // A close, a rebind or a new open while dohc looked ends this open's word.
  if (currentBinding(workspace) !== binding || dir === null) {
    throw new LocalStateUnavailableError("not-opened");
  }
  return dir;
}

/**
 * Waits for an engine open of the workspace that is already under way, so a
 * writer refused during it can ask again. Starts no open and waits for no
 * close: the caller may be inside an engine run, and a close waits for runs.
 * Returns at once when no open is under way, and when `signal` aborts.
 */
export async function localStateOpened(workspace: LocalStateWorkspace, signal?: AbortSignal): Promise<void> {
  let opening: Promise<unknown> | null = null;
  try {
    opening = bindings?.openInProgress?.(workspace) ?? null;
  } catch {
    return;
  }
  if (opening === null || signal?.aborted) return;
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await Promise.race([opening.then(() => undefined, () => undefined), stopped]);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * The workspace's `.dohc/local` for a reader, or null when it is not a real
 * folder in the workspace. A read writes nothing, so it does not wait for
 * the engine.
 */
export async function existingLocalStateDir(rootPath: string): Promise<string | null> {
  const metadata = await resolveWorkspaceMetadataDir(rootPath, { create: false }).catch(() => null);
  if (metadata === null) return null;
  const dir = join(metadata, "local");
  const stats = await lstat(dir).catch(() => null);
  return stats?.isDirectory() ? dir : null;
}

/** What keeps dohc from trusting `.dohc` or `.dohc/local` itself. */
export type LocalFolderProblem = "link" | "not-folder" | "other-owner" | "unreadable";

// In the words the engine's open refuses the workspace with. Each names its
// own way out, because replacing a file in the folder can't fix the folder.
export const LOCAL_FOLDER_WORDS: Record<LocalFolderProblem, readonly [fact: string, fix: string]> = {
  link: ["is a link", "Put what it links to in its place, then try again."],
  "not-folder": ["is not a folder", "Rename or move it, then try again."],
  "other-owner": ["belongs to another user", "Make it and everything in it yours again, then try again."],
  unreadable: ["can't be read", "Make sure you can open it, then try again."],
};

/** `.dohc` or `.dohc/local` is not a folder this user owns, so dohc trusts nothing in it. */
export class LocalStateFolderError extends Error {
  constructor(readonly shown: ".dohc" | ".dohc/local", readonly problem: LocalFolderProblem) {
    const [fact, fix] = LOCAL_FOLDER_WORDS[problem];
    super(`This workspace's ${shown} ${fact}. ${fix}`);
    this.name = "LocalStateFolderError";
  }
}

// Null for a folder of this user's. Only a path that is not there is missing:
// a folder dohc can't look at may still hold what protects a person's work.
async function folderProblem(path: string): Promise<LocalFolderProblem | "missing" | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  if (stats.isSymbolicLink()) return "link";
  if (!stats.isDirectory()) return "not-folder";
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid !== uid ? "other-owner" : null;
}

// Node can't see who may change a folder on Windows. There dohc trusts
// `.dohc/local` only while the engine's current open of a workspace at this
// root holds it: that open made it private and keeps it the folder it
// checked.
async function engineOpenAt(rootPath: string): Promise<LocalStateOpen | null> {
  try {
    return (await bindings?.localStateOpenAt(rootPath)) ?? null;
  } catch {
    return null;
  }
}

function stillCurrent(open: LocalStateOpen): boolean {
  try {
    return open.current();
  } catch {
    return false;
  }
}

/**
 * The engine's current open of the workspace that prepared `.dohc/local`, or
 * null, for a writer that goes on using what it opened in the folder. Its
 * `current` says whether that open is still the workspace's current one, so
 * it has held the folder since.
 */
export function currentLocalStateOpen(workspace: LocalStateWorkspace): LocalStateOpen | null {
  const binding = currentBinding(workspace);
  return binding?.localStateReady ? { current: () => currentBinding(workspace) === binding } : null;
}

/**
 * Reads the workspace's `.dohc/local` with `read`, for state that changes
 * what dohc does, such as settings, and returns what `read` returned. `read`
 * gets the folder, or null when it or `.dohc` is not there. Both folders are
 * checked on every read, before `read` opens a file in them: a link at
 * either one would be followed by the file's open. Throws
 * LocalStateFolderError when either is not a folder this user owns or can't
 * be looked at, and the metadata resolver's refusal when `.dohc` leads out of
 * the workspace, which only a mount can do.
 *
 * On Windows, when the folder is there, waits for an open already under
 * way, then throws LocalStateUnavailableError unless an engine open of the
 * workspace holds the folder from then until `read` returns. If that open
 * closed in between, what `read` found is dropped. Otherwise does not wait
 * for the engine. Creates nothing.
 */
export async function readOwnedLocalState<T>(rootPath: string, read: (dir: string | null) => Promise<T>): Promise<T> {
  const dir = await ownedLocalStateDir(rootPath);
  if (process.platform !== "win32" || dir === null) return read(dir);
  // An open that holds the folder now made private the folder at its path,
  // and keeps using it while it stays current.
  const open = await engineOpenAt(rootPath);
  if (open === null) throw new LocalStateUnavailableError("not-opened");
  const found = await read(dir);
  if (!stillCurrent(open)) throw new LocalStateUnavailableError("not-opened");
  return found;
}

// The folder for readOwnedLocalState.
async function ownedLocalStateDir(rootPath: string): Promise<string | null> {
  const dohc = await folderProblem(join(rootPath, ".dohc"));
  if (dohc === "missing") return null;
  if (dohc) throw new LocalStateFolderError(".dohc", dohc);
  const metadata = await resolveWorkspaceMetadataDir(rootPath, { create: false });
  // `.dohc` was just there, so the resolver lost sight of it.
  if (metadata === null) throw new LocalStateFolderError(".dohc", "unreadable");
  const dir = join(metadata, "local");
  const local = await folderProblem(dir);
  if (local === "missing") return null;
  if (local) throw new LocalStateFolderError(".dohc/local", local);
  return dir;
}

// Another user who owns the folder, or can write in it, can replace what dohc
// keeps there. Windows reports no owner or mode.
function changeableByOthers(stats: Stats): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && (stats.uid !== uid || (stats.mode & 0o022) !== 0);
}

/**
 * A folder in the workspace's `.dohc/local`, for a writer, made 0700 when
 * missing, with each folder on the way: `name` can be a path such as
 * `datasets/workers`. Refuses as localStateDir does, and in `guard`'s words,
 * naming the first folder on the way that is wrong, when what is at the path
 * is not a folder in the workspace that only this user can change. Never
 * creates `.dohc/local`.
 */
export async function localStateFolder(workspace: LocalStateWorkspace, name: string, guard: DohcPathGuard): Promise<string> {
  const parts = name.split("/");
  const shown = guard.path.split("/");
  let dir = await localStateDir(workspace);
  for (const [index, part] of parts.entries()) {
    dir = join(dir, part);
    const partGuard = { ...guard, path: shown.slice(0, shown.length - (parts.length - 1 - index)).join("/") };
    // Something else at the path fails mkdir with a raw errno, and the checks
    // below name it. Two writers can both find it missing.
    await mkdir(dir, { mode: 0o700 }).catch(async (error: unknown) => {
      if ((await lstat(dir).catch(() => null)) === null) throw error;
    });
    const stats = await lstat(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(notARealFolderRefusal(partGuard, stats));
    if (changeableByOthers(stats)) throw new Error(notOnlyYoursRefusal(partGuard));
  }
  // With `.dohc` and `.dohc/local` real folders, only a mount leads out.
  if (!isInside(await realpath(workspace.rootPath), await realpath(dir))) throw new Error(outsideWorkspaceRefusal(guard));
  return dir;
}

/**
 * Whether dohc can open the SQLite database `name` in `folder` and trust what
 * it says: the database and its -wal, -shm and -journal files are each
 * missing, or a file this user owns, that no other user can write, with one
 * name. `folder` must be one only this user can change, such as one from
 * localStateFolder, so a check by name holds until the database opens.
 */
export async function ownedSqliteFiles(folder: string, name: string): Promise<boolean> {
  for (const file of [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]) {
    const stats = await lstat(join(folder, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stats && ownedFileRefusal(stats) !== null) return false;
  }
  return true;
}

/**
 * Reads a folder in `.dohc/local` with `read`, for a reader that trusts what
 * it finds there, where `name` can be a path such as `datasets/exports`.
 * `read` gets the folder, null when it, a folder on the way, `.dohc/local`
 * or `.dohc` is missing, and "unusable" when any of them is not a folder in
 * the workspace that only this user can change. Throws, and on Windows waits,
 * as readOwnedLocalState does. Creates nothing.
 */
export function readOwnedLocalStateFolder<T>(
  rootPath: string, name: string, read: (dir: string | null | "unusable") => Promise<T>,
): Promise<T> {
  return readOwnedLocalState(rootPath, async (local) => read(local === null ? null : await folderIn(rootPath, local, name)));
}

async function folderIn(rootPath: string, local: string, name: string): Promise<string | null | "unusable"> {
  let dir = local;
  for (const part of name.split("/")) {
    dir = join(dir, part);
    const stats = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stats === null) return null;
    if (stats.isSymbolicLink() || !stats.isDirectory() || changeableByOthers(stats)) return "unusable";
  }
  return isInside(await realpath(rootPath), await realpath(dir)) ? dir : "unusable";
}
