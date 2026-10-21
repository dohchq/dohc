import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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

export type OwnedFileRead =
  | { readonly status: "read"; readonly content: string }
  | { readonly status: "missing" | "not-file" | "other-owner" | "too-large" };

/**
 * Read one file of this computer's state whose content changes what dohc
 * does, such as settings, and trust it only if this user owns the file. The
 * file is opened once without following a link at its name, and its kind,
 * owner and size are checked on that same handle before it is read, so a
 * folder or path swapped meanwhile changes nothing: another local user can't
 * make a file this user owns. That is the only protection. A file that came
 * from a zip, a git checkout or a sync app belongs to this user and is read.
 * Windows reports no owner, so there the owner is not checked.
 */
export async function readOwnedFile(path: string, maxBytes: number): Promise<OwnedFileRead> {
  // Windows has neither flag, so there a link at the name is refused first.
  const noFollow: number | undefined = constants.O_NOFOLLOW;
  const nonBlock: number | undefined = constants.O_NONBLOCK;
  if (noFollow === undefined) {
    const named = await lstat(path).catch(() => null);
    if (named?.isSymbolicLink()) return { status: "not-file" };
  }
  // O_NONBLOCK keeps a FIFO at the name from holding the open.
  const flags = constants.O_RDONLY | (noFollow ?? 0) | (nonBlock ?? 0);
  const handle = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing" as const;
    if (error.code === "ELOOP" || error.code === "EISDIR") return "not-file" as const;
    throw error;
  });
  if (typeof handle === "string") return { status: handle };
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { status: "not-file" };
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) return { status: "other-owner" };
    // Read one byte past the cap, so a file that grew since the check is
    // still refused instead of cut short.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { status: "too-large" };
    return { status: "read", content: buffer.toString("utf8", 0, length) };
  } finally {
    await handle.close();
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
