import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// `.dohc/local` holds what belongs to this computer rather than the
// workspace, such as its layout. Only the engine creates it: each open that
// writes makes it private and, on a Mac, keeps it out of iCloud Drive before
// anything is written in it. A writer that created the folder itself would
// leave it syncing, so writers get it only from localStateDir.

export interface LocalStateWorkspace {
  readonly workspaceId: string;
  readonly rootPath: string;
}

export type LocalStateRefusal = "not-opened" | "not-excluded";

const REFUSAL_WORDS: Record<LocalStateRefusal, string> = {
  "not-opened": "dohc has not finished opening this workspace. Try again when it opens.",
  "not-excluded": "dohc could not keep this workspace's .dohc/local out of iCloud Drive, so it saves nothing there. Restart dohc to try again.",
};

/** dohc won't write this computer's state for a workspace. */
export class LocalStateUnavailableError extends Error {
  constructor(readonly refusal: LocalStateRefusal) {
    super(REFUSAL_WORDS[refusal]);
    this.name = "LocalStateUnavailableError";
  }
}

// What each workspace's latest engine open reported, by workspace id.
const opens = new Map<string, { rootPath: string; ready: boolean }>();

/** Records whether an engine open of the workspace prepared `.dohc/local`. */
export function recordLocalStateOpen(workspace: LocalStateWorkspace, ready: boolean): void {
  opens.set(workspace.workspaceId, { rootPath: workspace.rootPath, ready });
}

/**
 * The workspace's `.dohc/local`, for a writer. Refuses with
 * LocalStateUnavailableError unless the latest engine open of the workspace
 * at this root prepared it and it is still a real folder in the workspace.
 * Never creates anything.
 */
export async function localStateDir(workspace: LocalStateWorkspace): Promise<string> {
  const open = opens.get(workspace.workspaceId);
  if (open?.rootPath !== workspace.rootPath) throw new LocalStateUnavailableError("not-opened");
  if (!open.ready) throw new LocalStateUnavailableError("not-excluded");
  const dir = await existingLocalStateDir(workspace.rootPath);
  if (dir === null) throw new LocalStateUnavailableError("not-opened");
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
