import { lstat } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Whether a reader of state that changes what dohc does, such as settings,
 * can use the workspace's `.dohc/local`: this user owns it, or the engine's
 * current open of the workspace prepared it. The engine refuses another
 * user's folder on a local volume, and takes a network share's owners as the
 * server gives them, so its open answers for a share. A read never waits for
 * the engine. Windows reports no owner, so there the folder is used as is.
 */
export function readsLocalState(workspace: LocalStateWorkspace, folder: { readonly uid: number }): boolean {
  const uid = process.getuid?.();
  return uid === undefined || folder.uid === uid || currentBinding(workspace) !== null;
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
