import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";
import {
  existingLocalStateDir,
  localStateDir,
  LocalStateUnavailableError,
  readOwnedLocalState,
  type LocalStateWorkspace,
} from "./workspaceLocalState";

// Main-side store for per-workspace UI state (.dohc/local/ui-state.json). The
// layout belongs to this computer, so it lives in `.dohc/local`, which
// file-provider services on a Mac, such as iCloud Drive, skip. The watcher,
// tree and history ignore .dohc at any depth, and the renderer cannot write
// there through writeWorkspaceText (reserved path), so this narrow main-owned
// pair is the only writer. A write waits for nothing: unless the engine's
// current open of the workspace prepared `.dohc/local`, it is refused.

const UI_STATE_FILE = "ui-state.json";
const writeQueues = new Map<string, Promise<void>>();

// The known WorkspaceUiState fields bound a legitimate file to a few KB; this
// cap (with margin) only exists so a foreign multi-hundred-MB ui-state.json
// can't be read + JSON.parsed wholesale in main before zod ever runs.
export const MAX_UI_STATE_FILE_BYTES = 256 * 1024;

// Tolerant read: a missing, corrupt, oversized, or escape-y file is "no saved
// state", never an error. On Windows, a read the engine's open doesn't hold
// `.dohc/local` throughout is refused instead, so the renderer saves no
// defaults over a file it couldn't read. Returns the raw parsed JSON — the
// IPC handler validates the shape with the WorkspaceUiState zod contract
// before it reaches the renderer.
export async function readUiStateFile(rootPath: string): Promise<unknown> {
  try {
    return await (process.platform === "win32"
      ? readOwnedLocalState(rootPath, uiStateIn)
      : uiStateIn(await existingLocalStateDir(rootPath)));
  } catch (error) {
    if (error instanceof LocalStateUnavailableError) throw error;
    return null;
  }
}

async function uiStateIn(dir: string | null): Promise<unknown> {
  if (dir === null) return null;
  const path = join(dir, UI_STATE_FILE);
  // lstat-cap before reading: zod can only bound what already sits in memory.
  const fileStats = await lstat(path);
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) return null;
  if (fileStats.size > MAX_UI_STATE_FILE_BYTES) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeUiStateFileNow(
  workspace: LocalStateWorkspace,
  state: unknown,
): Promise<void> {
  const path = join(await localStateDir(workspace), UI_STATE_FILE);
  // Atomic temp+rename so a crash mid-write never truncates the state file
  // (the unique suffix keeps concurrent writers apart).
  await atomicReplaceFile(path, (tmp) => writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`));
}

export function writeUiStateFile(
  workspace: LocalStateWorkspace,
  state: unknown,
): Promise<void> {
  // Renderer activity can emit several IPC writes in the same frame. Keep a
  // per-workspace FIFO so Windows never has multiple rename-over-destination
  // operations racing against the same ui-state.json file.
  const key = workspace.rootPath;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeUiStateFileNow(workspace, state));
  writeQueues.set(key, current);

  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
}
