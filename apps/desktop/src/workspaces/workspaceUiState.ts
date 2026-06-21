import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// Main-side store for per-workspace UI state (.dohc/ui-state.json), the same
// pattern as AgentIntegration's agent-runs.json. It lives under .dohc by
// design: the watcher/tree/history ignore .dohc at any depth, so workbench
// state never lands in the timeline and never syncs as user content — and the
// renderer CANNOT write here through writeWorkspaceText (reserved path), so
// this narrow main-owned pair is the only writer. The metadata dir resolves
// through resolveWorkspaceMetadataDir, so a symlinked .dohc in a malicious
// attached workspace can never route these writes outside the workspace.

const UI_STATE_FILE = "ui-state.json";

// The known WorkspaceUiState fields bound a LEGITIMATE file to a few KB; this
// cap (with margin) only exists so a foreign multi-hundred-MB ui-state.json
// can't be read + JSON.parsed wholesale in main before zod ever runs.
export const MAX_UI_STATE_FILE_BYTES = 256 * 1024;

// Tolerant read: a missing, corrupt, oversized, or escape-y file is "no saved
// state", never an error. Returns the raw parsed JSON — the IPC handler
// validates the SHAPE with the WorkspaceUiState zod contract before it
// reaches the renderer.
export async function readUiStateFile(rootPath: string): Promise<unknown> {
  try {
    const path = join(await resolveWorkspaceMetadataDir(rootPath), UI_STATE_FILE);
    // lstat-cap BEFORE reading: zod can only bound what already sits in memory.
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) return null;
    if (fileStats.size > MAX_UI_STATE_FILE_BYTES) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function writeUiStateFile(
  rootPath: string,
  state: unknown,
): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), UI_STATE_FILE);
  // Atomic temp+rename so a crash mid-write never truncates the state file
  // (agent-runs.json idiom; the unique suffix keeps concurrent writers apart).
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}
