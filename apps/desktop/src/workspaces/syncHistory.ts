import { AUTOMATION_COMPUTER_LABEL_MAX_CHARS, AUTOMATION_INSTALL_ID_MAX_CHARS, isNoticeLine } from "@dohc/workspace-contracts/relay";
import { DOHC_SYNC_HISTORY_GUARD, notAFileRefusal, notARealFolderRefusal, type DohcPathGuard } from "@dohc/workspace-core";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicCreateFile, atomicWriteFile } from "../atomicReplaceFile";
import type { RegistryEntry } from "./registryStore";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

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
// in. A record from before dohc kept received shares has no `receivedShare`.
// One from before these marks may say `synced` or `receivedShare` itself:
// the first read that sees it records the mark, so a stale copy cannot
// take it back after.
//
// .dohc resolves through resolveWorkspaceMetadataDir, and .dohc/sync-history
// must be a real folder, so a planted link cannot send a write outside the
// workspace.

// "absent" when the folder has no record, as one made before dohc kept it;
// "unknown" when it has one dohc cannot read or parse, which may say synced.
export type SyncHistory = "never-synced" | "synced" | "absent" | "unknown";

/** An installation of dohc, by its install id, with its computer's name. */
export interface Computer {
  installId: string;
  label: string;
}

/** Who runs a never-synced workspace's schedules, or why dohc cannot say. */
export type ScheduleComputer = { kind: "computer"; computer: Computer } | { kind: "unreadable"; error: unknown };

interface HistoryRecord {
  synced: boolean;
  // Null in a record from before dohc kept it.
  receivedShare: boolean | null;
  // The installation that made the workspace; null in a record from before dohc kept it.
  host: Computer | null;
}

type Mark = "synced" | "received-share";
type FileRead = { kind: "text"; text: string } | { kind: "absent" } | { kind: "failed"; error: unknown };

// A sync-history path, as a refusal names it.
const at = (path: string): DohcPathGuard => ({ ...DOHC_SYNC_HISTORY_GUARD, path });

const computerText = ({ installId, label }: Computer) => `${JSON.stringify({ version: 1, installId, label })}\n`;

/**
 * A new workspace that has not synced, whose schedules run on `computer`.
 * Existing records stay.
 */
export async function recordNeverSynced(rootPath: string, computer: Computer): Promise<void> {
  const metadata = await resolveWorkspaceMetadataDir(rootPath);
  await createGuardedFileOnce(join(metadata, "sync-history.json"), at(".dohc/sync-history.json"), `${JSON.stringify({ version: 1, synced: false, receivedShare: false, host: computer })}\n`);
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

// A mark that a link or folder stands in for counts as there, so it can
// never make a workspace look never synced. Writing one refuses it.
async function mark(rootPath: string, name: Mark): Promise<void> {
  const path = join(await marksFolder(rootPath), name);
  await createGuardedFileOnce(path, at(`.dohc/sync-history/${name}`), "");
}

// .dohc/sync-history, made when it is missing. A workspace folder that is
// gone stays gone.
async function marksFolder(rootPath: string): Promise<string> {
  const folder = join(await resolveWorkspaceMetadataDir(rootPath), "sync-history");
  try {
    await mkdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Something other than a real folder there could lead outside the workspace.
  const stats = await lstat(folder);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(notARealFolderRefusal(DOHC_SYNC_HISTORY_GUARD, stats));
  return folder;
}


// Windows can follow a dangling file link even with "wx". Inspect the entry
// itself before reading or writing; only an absent entry is a missing record.
export async function guardedFileExists(path: string, guard: DohcPathGuard): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error(notAFileRefusal(guard, stats));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createGuardedFileOnce(path: string, guard: DohcPathGuard, text: string): Promise<void> {
  if (await guardedFileExists(path, guard)) return;
  if (!await atomicCreateFile(path, text, 0o666, { renameAfter: () => true })) {
    await guardedFileExists(path, guard);
  }
}

export async function readGuardedFile(path: string, guard: DohcPathGuard): Promise<FileRead> {
  try {
    if (!await guardedFileExists(path, guard)) return { kind: "absent" };
    return { kind: "text", text: await readFile(path, "utf8") };
  } catch (error) {
    return { kind: "failed", error };
  }
}

// True when anything is at the mark's name, false when nothing is, and null
// when dohc cannot tell. Only a missing entry is no mark: any other error
// may hide one. lstat, so a link that leads nowhere still counts.
async function marked(marks: string, name: Mark): Promise<boolean | null> {
  try {
    await lstat(join(marks, name));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
}

export function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

export function computerOf(value: unknown): Computer | null {
  if (!value || typeof value !== "object") return null;
  const { installId, label } = value as Record<string, unknown>;
  return isNoticeLine(installId, AUTOMATION_INSTALL_ID_MAX_CHARS) && isNoticeLine(label, AUTOMATION_COMPUTER_LABEL_MAX_CHARS)
    ? { installId, label }
    : null;
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

interface History {
  history: SyncHistory;
  // The record, when the history says the workspace never synced.
  record: HistoryRecord | null;
  // Whether the received-share mark is there, or null when dohc cannot tell.
  receivedShare: boolean | null;
  // .dohc/sync-history, which may not exist yet.
  marks: string | null;
}

async function readHistory(rootPath: string): Promise<History> {
  let metadata: string | null;
  try {
    metadata = await resolveWorkspaceMetadataDir(rootPath, { create: false });
  } catch {
    // A .dohc that is not a real folder inside the workspace proves nothing.
    return { history: "unknown", record: null, receivedShare: null, marks: null };
  }
  if (metadata === null) return { history: "absent", record: null, receivedShare: false, marks: null };
  const marks = join(metadata, "sync-history");
  const stats = await lstat(marks).catch(() => null);
  // Nor does a marks folder that is a link or a file.
  if (stats !== null && (stats.isSymbolicLink() || !stats.isDirectory())) {
    return { history: "unknown", record: null, receivedShare: null, marks: null };
  }
  const [file, synced, shared] = await Promise.all([
    readGuardedFile(join(metadata, "sync-history.json"), at(".dohc/sync-history.json")), marked(marks, "synced"), marked(marks, "received-share"),
  ]);
  const record = file.kind === "text" ? parseRecord(file.text) : null;
  const receivedShare = shared === false && record?.receivedShare === true ? await keep(rootPath, "received-share") : shared;
  const answer = (history: SyncHistory, never: HistoryRecord | null = null): History => ({ history, record: never, receivedShare, marks });
  if (synced === null) return answer("unknown");
  if (synced || record?.synced) {
    if (!synced) await keep(rootPath, "synced");
    return answer("synced");
  }
  if (file.kind === "absent") return answer("absent");
  return record === null ? answer("unknown") : answer("never-synced", record);
}

// A record from before the marks says this: mark it, so a stale copy of
// the record cannot take it back. The record says it either way, so a mark
// that cannot be written is tried again at the next read.
async function keep(rootPath: string, name: Mark): Promise<true> {
  await mark(rootPath, name).catch(() => undefined);
  return true;
}

/**
 * The installation that made the workspace, as its record says, or null
 * when the record names none or dohc cannot read it. A synced workspace
 * made by dohc still has one.
 */
export async function workspaceMadeBy(rootPath: string): Promise<Computer | null> {
  const metadata = await resolveWorkspaceMetadataDir(rootPath, { create: false }).catch(() => null);
  if (metadata === null) return null;
  const read = await readGuardedFile(join(metadata, "sync-history.json"), at(".dohc/sync-history.json"));
  return read.kind === "text" ? parseRecord(read.text)?.host ?? null : null;
}

/** What the workspace's history says. */
export async function readSyncHistory(rootPath: string): Promise<SyncHistory> {
  return (await readHistory(rootPath)).history;
}

/**
 * The computer that runs a workspace's schedules when it never synced, or
 * null when it synced or its history cannot say. "unreadable" when the
 * schedules record cannot be read: no computer runs them until one takes
 * over. A record from before dohc named a host belongs to the first
 * computer that reads it, so its only computer keeps running its schedules.
 */
export async function scheduleComputer(rootPath: string, here: Computer): Promise<ScheduleComputer | null> {
  const { record, marks } = await readHistory(rootPath);
  if (record === null || marks === null) return null;
  const path = join(marks, "schedules.json");
  const read = await readGuardedFile(path, at(".dohc/sync-history/schedules.json"));
  if (read.kind !== "absent") return scheduleComputerOf(read);
  if (record.host !== null) return { kind: "computer", computer: record.host };
  try {
    if (await atomicCreateFile(join(await marksFolder(rootPath), "schedules.json"), computerText(here), 0o666, { renameAfter: () => true })) {
      return { kind: "computer", computer: here };
    }
    // Another reader recorded one first: read it, once.
    const again = await readGuardedFile(path, at(".dohc/sync-history/schedules.json"));
    return again.kind === "absent"
      ? { kind: "unreadable", error: new Error("The schedules record disappeared after creation.") }
      : scheduleComputerOf(again);
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

function scheduleComputerOf(read: Exclude<FileRead, { kind: "absent" }>): ScheduleComputer {
  if (read.kind === "failed") return { kind: "unreadable", error: read.error };
  const parsed = parseObject(read.text);
  const computer = parsed?.version === 1 ? computerOf(parsed) : null;
  return computer === null
    ? { kind: "unreadable", error: new Error("The file .dohc/sync-history/schedules.json does not name a computer.") }
    : { kind: "computer", computer };
}

/**
 * The person chose to run a never-synced workspace's schedules on `here`.
 * Every other computer stops at its next read. False when the workspace
 * synced, or its history cannot say, so this computer cannot run them.
 */
export async function runSchedulesOn(rootPath: string, here: Computer): Promise<boolean> {
  if ((await readHistory(rootPath)).record === null) return false;
  const path = join(await marksFolder(rootPath), "schedules.json");
  // Refuse a non-file entry before replacing the schedules record.
  await guardedFileExists(path, at(".dohc/sync-history/schedules.json"));
  await atomicWriteFile(path, computerText(here));
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
  const { record, receivedShare } = await readHistory(entry.rootPath);
  if (record?.receivedShare !== false || receivedShare !== false) return false;
  return (await remoteChangesApplied()) === 0;
}
