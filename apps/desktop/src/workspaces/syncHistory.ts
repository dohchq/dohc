import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryEntry } from "./registryStore";

// Whether a workspace ever synced or opened as a share, kept in its own
// .dohc folder. Forgetting the workspace removes its registry entry, and
// reattaching the folder keeps its workspace id, so only the folder can
// still say it synced. A workspace runs its schedules on this computer
// alone only when this record says it never synced.
//
// The record also keeps that a received share was mounted in the workspace,
// or a shared Group or direct message joined into its chats. Neither makes
// the workspace sync, so schedules still run here, but the workspace is no
// longer one nobody else ever had a part in. A record from before dohc
// kept this has no `receivedShare`, so it cannot say either way.

export type SyncHistory = "never-synced" | "synced" | "unknown";

interface HistoryRecord {
  synced: boolean;
  // Null in a record from before dohc kept it.
  receivedShare: boolean | null;
}

const historyPath = (rootPath: string) => join(rootPath, ".dohc", "sync-history.json");
const historyText = (synced: boolean, receivedShare?: boolean) =>
  `${JSON.stringify({ version: 1, synced, ...(receivedShare === undefined ? {} : { receivedShare }) })}\n`;

/** A new workspace that has not synced. An existing record stays. */
export async function recordNeverSynced(rootPath: string): Promise<void> {
  try {
    await writeFile(historyPath(rootPath), historyText(false, false), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** The workspace synced or opened as a share. The record never goes back. */
export function recordSynced(rootPath: string): void {
  mkdirSync(join(rootPath, ".dohc"), { recursive: true });
  writeFileSync(historyPath(rootPath), historyText(true));
}

/**
 * A received share or a shared chat came into a workspace that never synced.
 * The record never goes back. A missing record, or one that says the
 * workspace synced or that dohc cannot parse, already proves nothing, so it
 * stays as it is. Throws when the record cannot be read or written, so the
 * share is not kept without it.
 */
export function recordReceivedShare(rootPath: string): void {
  let text: string;
  try {
    text = readFileSync(historyPath(rootPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const record = parseRecord(text);
  if (record === null || record.synced || record.receivedShare === true) return;
  writeFileSync(historyPath(rootPath), historyText(false, true));
}

function parseRecord(text: string): HistoryRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { version, synced, receivedShare } = parsed as { version?: unknown; synced?: unknown; receivedShare?: unknown };
  if (version !== 1 || typeof synced !== "boolean") return null;
  if (receivedShare !== undefined && typeof receivedShare !== "boolean") return null;
  return { synced, receivedShare: receivedShare ?? null };
}

async function readRecord(rootPath: string): Promise<HistoryRecord | null> {
  try {
    return parseRecord(await readFile(historyPath(rootPath), "utf8"));
  } catch {
    return null;
  }
}

/** What the workspace's record says; "unknown" when it has none dohc can read. */
export async function readSyncHistory(rootPath: string): Promise<SyncHistory> {
  const record = await readRecord(rootPath);
  return record === null ? "unknown" : record.synced ? "synced" : "never-synced";
}

/**
 * Whether nobody but this computer's person ever had a part in the
 * workspace, so only they could have written its automations. Every piece
 * of evidence must agree: the registry has no server connection, received
 * share, joined chat, or mount for it; the folder's record says it never
 * synced and never took in a share; and the engine applied no change from
 * another computer. A record dohc cannot read, one from before dohc kept
 * received shares, or an engine that does not answer, proves nothing. A
 * count of zero proves nothing alone either: a store made before the count
 * existed starts at zero.
 */
export async function provedNeverShared(
  entry: RegistryEntry,
  remoteChangesApplied: () => Promise<number | null>,
): Promise<boolean> {
  if (entry.remote || entry.shareView || entry.sharedChannels?.length || entry.shareMounts?.length) return false;
  const record = await readRecord(entry.rootPath);
  if (record === null || record.synced || record.receivedShare !== false) return false;
  return (await remoteChangesApplied()) === 0;
}
