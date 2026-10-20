import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// Main-side store for per-workspace UI state (.dohc/ui-state.json). It lives
// under .dohc by design: the watcher/tree/history ignore .dohc at any depth,
// so workbench state never lands in the timeline and never syncs as user
// content — and the renderer cannot write here through writeWorkspaceText
// (reserved path), so this narrow main-owned pair is the only writer. The metadata dir resolves
// through resolveWorkspaceMetadataDir, so a symlinked .dohc in a malicious
// attached workspace can never route these writes outside the workspace.

const UI_STATE_FILE = "ui-state.json";
const writeQueues = new Map<string, Promise<void>>();

// The known WorkspaceUiState fields bound a legitimate file to a few KB; this
// cap (with margin) only exists so a foreign multi-hundred-MB ui-state.json
// can't be read + JSON.parsed wholesale in main before zod ever runs.
export const MAX_UI_STATE_FILE_BYTES = 256 * 1024;

// Tolerant read: a missing, corrupt, oversized, or escape-y file is "no saved
// state", never an error. Returns the raw parsed JSON — the IPC handler
// validates the shape with the WorkspaceUiState zod contract before it
// reaches the renderer.
export async function readUiStateFile(rootPath: string): Promise<unknown> {
  try {
    const path = join(await resolveWorkspaceMetadataDir(rootPath), UI_STATE_FILE);
    // lstat-cap before reading: zod can only bound what already sits in memory.
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) return null;
    if (fileStats.size > MAX_UI_STATE_FILE_BYTES) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeUiStateFileNow(
  rootPath: string,
  state: unknown,
): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), UI_STATE_FILE);
  // Atomic temp+rename so a crash mid-write never truncates the state file
  // (the unique suffix keeps concurrent writers apart).
  await atomicReplaceFile(path, (tmp) => writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`));
}

export function writeUiStateFile(
  rootPath: string,
  state: unknown,
): Promise<void> {
  // Renderer activity can emit several IPC writes in the same frame. Keep a
  // per-workspace FIFO so Windows never has multiple rename-over-destination
  // operations racing against the same ui-state.json file.
  const previous = writeQueues.get(rootPath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeUiStateFileNow(rootPath, state));
  writeQueues.set(rootPath, current);

  return current.finally(() => {
    if (writeQueues.get(rootPath) === current) writeQueues.delete(rootPath);
  });
}
