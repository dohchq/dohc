import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Whether a workspace ever synced or opened as a share, kept in its own
// .dohc folder. Forgetting the workspace removes its registry entry, and
// reattaching the folder keeps its workspace id, so only the folder can
// still say it synced. A workspace runs its schedules on this computer
// alone only when this record says it never synced.

export type SyncHistory = "never-synced" | "synced" | "unknown";

const historyPath = (rootPath: string) => join(rootPath, ".dohc", "sync-history.json");
const historyText = (synced: boolean) => `${JSON.stringify({ version: 1, synced })}\n`;

/** A new workspace that has not synced. An existing record stays. */
export async function recordNeverSynced(rootPath: string): Promise<void> {
  try {
    await writeFile(historyPath(rootPath), historyText(false), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** The workspace synced or opened as a share. The record never goes back. */
export function recordSynced(rootPath: string): void {
  mkdirSync(join(rootPath, ".dohc"), { recursive: true });
  writeFileSync(historyPath(rootPath), historyText(true));
}

/** What the workspace's record says; "unknown" when it has none dohc can read. */
export async function readSyncHistory(rootPath: string): Promise<SyncHistory> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(historyPath(rootPath), "utf8"));
  } catch {
    return "unknown";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  const { version, synced } = parsed as { version?: unknown; synced?: unknown };
  if (version !== 1) return "unknown";
  return synced === false ? "never-synced" : synced === true ? "synced" : "unknown";
}
