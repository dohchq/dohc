import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Main-side store for per-workspace UI state (.dohc/ui-state.json), the same
// pattern as AgentIntegration's agent-runs.json. It lives under .dohc by
// design: the watcher/tree/history ignore .dohc at any depth, so workbench
// state never lands in the timeline and never syncs as user content — and the
// renderer CANNOT write here through writeWorkspaceText (reserved path), so
// this narrow main-owned pair is the only writer.

const UI_STATE_FILE = ".dohc/ui-state.json";

// Tolerant read: a missing or corrupt file is "no saved state", never an
// error. Returns the raw parsed JSON — the IPC handler validates the SHAPE
// with the WorkspaceUiState zod contract before it reaches the renderer.
export async function readUiStateFile(rootPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(rootPath, UI_STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

export async function writeUiStateFile(
  rootPath: string,
  state: unknown,
): Promise<void> {
  const path = join(rootPath, UI_STATE_FILE);
  await mkdir(join(rootPath, ".dohc"), { recursive: true });
  // Atomic temp+rename so a crash mid-write never truncates the state file
  // (agent-runs.json idiom; the unique suffix keeps concurrent writers apart).
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}
