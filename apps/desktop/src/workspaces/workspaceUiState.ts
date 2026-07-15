import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const writeQueues = new Map<string, Promise<void>>();
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 5 || !WINDOWS_RENAME_RETRY_CODES.has(errorCode(error) ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 8 * 2 ** attempt));
    }
  }
}

async function writeUiStateFileNow(
  rootPath: string,
  state: unknown,
): Promise<void> {
  const path = join(await resolveWorkspaceMetadataDir(rootPath), UI_STATE_FILE);
  // Atomic temp+rename so a crash mid-write never truncates the state file
  // (agent-runs.json idiom; the unique suffix keeps concurrent writers apart).
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await renameWithRetry(tmp, path);
  } finally {
    // Failed rename attempts must not accumulate metadata temp files forever.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
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
