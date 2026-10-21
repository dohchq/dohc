import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { notARealFolderRefusal, notOnlyYoursRefusal, outsideWorkspaceRefusal, type DohcPathGuard } from "@dohc/workspace-core";
import { isInside } from "../security/pathContainment";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// `.dohc/local` holds what belongs to this computer rather than the
// workspace, such as its layout. Only the engine creates it: each open that
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

/**
 * The workspace's `.dohc/local` for a reader of state that changes what dohc
 * does, such as settings, or null when it or `.dohc` is not there. Both
 * folders are checked on every read, before any file in them: a link at
 * either one would be followed by the file's open. Throws
 * LocalStateFolderError when either is not a folder this user owns or can't
 * be looked at, and the metadata resolver's refusal
 * when `.dohc` leads out of the workspace, which only a mount can do. Does
 * not wait for the engine, and creates nothing.
 */
export async function ownedLocalStateDir(rootPath: string): Promise<string | null> {
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
 * missing. Refuses as localStateDir does, and in `guard`'s words when what is
 * at `name` is not a folder in the workspace that only this user can change.
 * Never creates `.dohc/local`.
 */
export async function localStateFolder(workspace: LocalStateWorkspace, name: string, guard: DohcPathGuard): Promise<string> {
  const dir = join(await localStateDir(workspace), name);
  // Something else at the path fails mkdir with a raw errno, and the checks
  // below name it. Two writers can both find it missing.
  await mkdir(dir, { mode: 0o700 }).catch(async (error: unknown) => {
    if ((await lstat(dir).catch(() => null)) === null) throw error;
  });
  const stats = await lstat(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(notARealFolderRefusal(guard, stats));
  if (changeableByOthers(stats)) throw new Error(notOnlyYoursRefusal(guard));
  // With `.dohc` and `.dohc/local` real folders, only a mount leads out.
  if (!isInside(await realpath(workspace.rootPath), await realpath(dir))) throw new Error(outsideWorkspaceRefusal(guard));
  return dir;
}

/**
 * A folder in `.dohc/local` for a reader that trusts what it finds there:
 * null when it, `.dohc/local` or `.dohc` is missing, and "unusable" when it is
 * not a folder in the workspace that only this user can change. Throws as
 * ownedLocalStateDir does. Does not wait for the engine, and creates nothing.
 */
export async function existingLocalStateFolder(rootPath: string, name: string): Promise<string | null | "unusable"> {
  const local = await ownedLocalStateDir(rootPath);
  if (local === null) return null;
  const dir = join(local, name);
  const stats = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isDirectory() || changeableByOthers(stats)) return "unusable";
  return isInside(await realpath(rootPath), await realpath(dir)) ? dir : "unusable";
}
