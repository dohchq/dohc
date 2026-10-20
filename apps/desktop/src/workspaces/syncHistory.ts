import { AUTOMATION_COMPUTER_LABEL_MAX_CHARS, AUTOMATION_INSTALL_ID_MAX_CHARS, isNoticeLine } from "@dohc/workspace-contracts/relay";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../atomicReplaceFile";
import type { RegistryEntry } from "./registryStore";

// Whether a workspace ever synced or opened as a share, kept in its own
// .dohc folder. Forgetting the workspace removes its registry entry, and
// reattaching the folder keeps its workspace id, so only the folder can
// still say it synced. A workspace runs its schedules on one computer, with
// no relay to choose it, only when this history says it never synced.
//
// iCloud Drive, Dropbox, or a copy carries the folder to other computers,
// and a stale copy can replace any file another computer rewrote. So each
// fact lives where a stale copy cannot undo it:
//
//   sync-history.json            written once when dohc makes a workspace
//                                that has not synced, naming the installation
//                                that made it, which runs its schedules
//   sync-history/synced          present once it synced or opened as a share
//   sync-history/received-share  present once a received share was mounted
//                                in it, or a shared chat joined it
//   sync-history/schedules.json  the installation chosen since to run them
//
// The two marks are never written with anything to undo, and nothing removes
// them. The schedules record is the only file rewritten: the last computer
// chosen keeps the schedules, and every other computer reads that it does
// not. The first host travels inside the record, so a computer that gets
// the record before the schedules file does not take it for an old record
// and claim the schedules.
//
// A received share or chat does not make the workspace sync, so schedules
// still run, but the workspace is no longer one nobody else ever had a part
// in. A record from before dohc kept received shares has no `receivedShare`,
// and one from before these marks may say `synced` itself.

// "absent" when the folder has no record, as one made before dohc kept it;
// "unknown" when it has one dohc cannot read or parse, which may say synced.
export type SyncHistory = "never-synced" | "synced" | "absent" | "unknown";

/** An installation of dohc, by its install id, with its computer's name. */
export interface Computer {
  installId: string;
  label: string;
}

interface HistoryRecord {
  synced: boolean;
  // Null in a record from before dohc kept it.
  receivedShare: boolean | null;
  // The installation that made the workspace; null in a record from before dohc kept it.
  host: Computer | null;
}

const historyPath = (rootPath: string) => join(rootPath, ".dohc", "sync-history.json");
const marksPath = (rootPath: string) => join(rootPath, ".dohc", "sync-history");
const schedulesPath = (rootPath: string) => join(marksPath(rootPath), "schedules.json");
const computerText = ({ installId, label }: Computer) => `${JSON.stringify({ version: 1, installId, label })}\n`;

/**
 * A new workspace that has not synced, whose schedules run on `computer`.
 * Existing records stay.
 */
export function recordNeverSynced(rootPath: string, computer: Computer): Promise<void> {
  return createOnce(historyPath(rootPath), `${JSON.stringify({ version: 1, synced: false, receivedShare: false, host: computer })}\n`);
}

/** The workspace synced or opened as a share. Nothing undoes it. */
export function recordSynced(rootPath: string): Promise<void> {
  return mark(rootPath, "synced");
}

/**
 * A received share or a shared chat came into the workspace. Nothing undoes
 * it. Rejects when it cannot be recorded, so the share is not kept without it.
 */
export function recordReceivedShare(rootPath: string): Promise<void> {
  return mark(rootPath, "received-share");
}

async function mark(rootPath: string, name: "synced" | "received-share"): Promise<void> {
  await makeMarksFolder(rootPath);
  await createOnce(join(marksPath(rootPath), name), "");
}

// Within .dohc only: a workspace folder that is gone stays gone.
async function makeMarksFolder(rootPath: string): Promise<void> {
  try {
    await mkdir(marksPath(rootPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function createOnce(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

// True when the mark is there, false when it is not, and null when dohc
// cannot tell. Only a missing file is no mark: any other error may hide one.
async function marked(rootPath: string, name: "synced" | "received-share"): Promise<boolean | null> {
  try {
    await stat(join(marksPath(rootPath), name));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
}

function parseRecord(text: string): HistoryRecord | null {
  const parsed = parseObject(text);
  if (parsed === null) return null;
  const { version, synced, receivedShare, host } = parsed;
  if (version !== 1 || typeof synced !== "boolean") return null;
  if (receivedShare !== undefined && typeof receivedShare !== "boolean") return null;
  const computer = host === undefined ? null : computerOf(host);
  if (host !== undefined && computer === null) return null;
  return { synced, receivedShare: receivedShare ?? null, host: computer };
}

function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function computerOf(value: unknown): Computer | null {
  if (!value || typeof value !== "object") return null;
  const { installId, label } = value as Record<string, unknown>;
  return isNoticeLine(installId, AUTOMATION_INSTALL_ID_MAX_CHARS) && isNoticeLine(label, AUTOMATION_COMPUTER_LABEL_MAX_CHARS)
    ? { installId, label }
    : null;
}

// The file's text, "absent" when there is none, or null when dohc cannot
// read it.
async function readText(path: string): Promise<string | "absent" | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
}

/** What the workspace's history says. */
export async function readSyncHistory(rootPath: string): Promise<SyncHistory> {
  return (await readHistory(rootPath)).history;
}

// The history, with the record when it says the workspace never synced.
async function readHistory(rootPath: string): Promise<{ history: SyncHistory; record: HistoryRecord | null }> {
  const [text, synced] = await Promise.all([readText(historyPath(rootPath)), marked(rootPath, "synced")]);
  if (synced !== false) return { history: synced ? "synced" : "unknown", record: null };
  if (text === "absent") return { history: "absent", record: null };
  const record = text === null ? null : parseRecord(text);
  if (record === null) return { history: "unknown", record: null };
  return record.synced ? { history: "synced", record: null } : { history: "never-synced", record };
}

/**
 * The computer that runs a workspace's schedules when it never synced, or
 * null when it synced or its history cannot say. "unreadable" when the
 * schedules record cannot be read: no computer runs them until one is
 * chosen. A record from before dohc named a host belongs to the first
 * computer that reads it, so its only computer keeps running its schedules.
 */
export async function scheduleComputer(rootPath: string, here: Computer): Promise<Computer | "unreadable" | null> {
  const { record } = await readHistory(rootPath);
  if (record === null) return null;
  for (;;) {
    const text = await readText(schedulesPath(rootPath));
    if (text === null) return "unreadable";
    if (text !== "absent") {
      const parsed = parseObject(text);
      return (parsed?.version === 1 ? computerOf(parsed) : null) ?? "unreadable";
    }
    if (record.host !== null) return record.host;
    await makeMarksFolder(rootPath);
    try {
      await writeFile(schedulesPath(rootPath), computerText(here), { flag: "wx" });
      return here;
    } catch (error) {
      // Another reader recorded one first: read it.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * The person chose to run a never-synced workspace's schedules on `here`.
 * Every other computer stops at its next read. False when the workspace
 * synced, or its history cannot say, so this computer cannot run them.
 */
export async function runSchedulesOn(rootPath: string, here: Computer): Promise<boolean> {
  if ((await readHistory(rootPath)).record === null) return false;
  await makeMarksFolder(rootPath);
  await atomicWriteFile(schedulesPath(rootPath), computerText(here));
  return true;
}

/**
 * Whether nobody but this computer's person ever had a part in the
 * workspace, so only they could have written its automations. Every piece
 * of evidence must agree: the registry has no server connection, received
 * share, joined chat, or mount for it; the folder's history says it never
 * synced and never took in a share; and the engine applied no change from
 * another computer. A history dohc cannot read, a record from before dohc
 * kept received shares, or an engine that does not answer, proves nothing.
 * A count of zero proves nothing alone either: a store made before the
 * count existed starts at zero.
 */
export async function provedNeverShared(
  entry: RegistryEntry,
  remoteChangesApplied: () => Promise<number | null>,
): Promise<boolean> {
  if (entry.remote || entry.shareView || entry.sharedChannels?.length || entry.shareMounts?.length) return false;
  const [{ record }, shared] = await Promise.all([readHistory(entry.rootPath), marked(entry.rootPath, "received-share")]);
  if (record?.receivedShare !== false || shared !== false) return false;
  return (await remoteChangesApplied()) === 0;
}
