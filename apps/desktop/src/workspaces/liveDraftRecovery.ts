import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as Y from "yjs";
import type { YdocContentKind } from "@dohc/workspace-engine-client";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { LiveDraftRecoveryRecord } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import { sendToWorkspaceWindows } from "../ipc/workspaceActivityBroadcast";

// `reason` "deleted": the text of a file deleted outside dohc.
export type LiveDraft = {
  path: string;
  objectId: string;
  update: Uint8Array;
  reason?: "deleted";
} & (
  { remoteWorkspaceId: string; text?: never; contentKind?: never } |
  { text: string; contentKind: "plaintext" | "richdoc"; remoteWorkspaceId?: never } |
  { contentKind: "scene"; text?: never; remoteWorkspaceId?: never }
);

const activeTemporaryDrafts = new Set<string>();

const STALE_TEMPORARY_DRAFT_MS = 24 * 60 * 60 * 1000;
type RecoveryRow = {file: string; record: Record<string, unknown>};

async function recoveryRecords(directory: string): Promise<RecoveryRow[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return []; throw error;});
  const rows: RecoveryRow[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) && !name.endsWith(".tmp")) continue;
    let file = join(directory, name);
    if (activeTemporaryDrafts.has(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      let record: Record<string, unknown>;
      try {const value: unknown = JSON.parse(raw); record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};}
      catch {
        const match = /"workspaceId"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
        try {record = match ? {workspaceId: JSON.parse(match[1]!)} : {};} catch {record = {};}
      }
      if (name.endsWith(".tmp") && Date.now() - (await stat(file)).mtimeMs >= STALE_TEMPORARY_DRAFT_MS) {
        if (createHash("sha256").update(raw).digest("hex") === name.slice(0, 64) && typeof record.workspaceId === "string" && typeof record.path === "string" && typeof record.objectId === "string" && typeof record.updateBase64 === "string") {
          const recovered = join(directory, `${name.slice(0,64)}.json`);
          await rename(file, recovered).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;}); file = recovered;
        } else {
          await mkdir(join(directory, "quarantine"), {recursive: true});
          await rename(file, join(directory, "quarantine", name)).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;});
          continue;
        }
      }
      rows.push({file, record});
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  }
  return rows;
}

export async function hasRetainedLiveDraft(directory: string, workspaceId: string, path: string, objectId: string): Promise<boolean> {
  // Pending typing also protects History Restore, but is not a set-aside draft.
  return (await readableRecoveryRecords(await recoveryRecords(directory), workspaceId, {objectId, path}, true)).length > 0;
}

export async function listLiveDraftRecovery(directory: string, workspaceId: string, target?: {objectId: string; path: string}): Promise<LiveDraftRecoveryRecord[]> {
  return readableRecoveryRecords(await recoveryRecords(directory), workspaceId, target);
}

async function readableRecoveryRecords(rows: readonly RecoveryRow[], workspaceId: string, target?: {objectId: string; path: string}, includeTypingCheckpoints = false): Promise<LiveDraftRecoveryRecord[]> {
  const result: LiveDraftRecoveryRecord[] = [];
  for (const {file, record} of rows) {
    if (record.version !== 1 && !(includeTypingCheckpoints && record.version === 2)) continue;
    if (record.workspaceId !== workspaceId) continue;
    if (target && record.objectId !== target.objectId && record.path !== target.path) continue;
    const parsed = LiveDraftRecoveryRecord.safeParse({recordId: basename(file).slice(0, 64), path: record.path, objectId: record.objectId, updateBase64: record.updateBase64, text: record.text === undefined ? "" : record.text,
      ...(record.reason === undefined ? {} : {reason: record.reason})});
    if (!parsed.success || classifyEngineFilePathForRead(parsed.data.path, process.platform).kind !== "tracked") continue;
    let text = parsed.data.text;
    if (record.text === undefined) {
      const doc = new Y.Doc();
      try {
        try {Y.applyUpdate(doc, Buffer.from(parsed.data.updateBase64, "base64"));} catch {continue;}
        const project = record.contentKind === "scene"
          ? (await import("@dohc/excalidraw-scene")).exportPortableScene
          : (await import("@dohc/ydoc-projection")).yDocToArtifactMarkdown;
        try {text = project(doc);} catch {continue;}
      } finally { doc.destroy(); }
    }
    result.push({...parsed.data, text});
  }
  return result;
}

// A draft's file name is the hash of its content, so writing the same text
// again writes the same file. Each write gets a number this process never
// gives again, and its handle names the file and the number. A removal
// deletes the file only while it holds that write, so an old handle never
// deletes text written again. Writes and removals of one file, a dismissal's
// included, wait for each other.
let writesSoFar = 0;
const draftWrites = new Map<string, number>();
const draftFileWork = new Map<string, Promise<unknown>>();

function onDraftFile<T>(file: string, work: () => Promise<T>): Promise<T> {
  const result = (draftFileWork.get(file) ?? Promise.resolve()).then(work, work);
  const settled = result.catch(() => undefined);
  draftFileWork.set(file, settled);
  void settled.then(() => {
    if (draftFileWork.get(file) === settled) draftFileWork.delete(file);
  });
  return result;
}

export async function removeLiveDraftCopies(directory: string, workspaceId: string, objectId: string, snapshotSha256: string, throughMs: number, path: string, recordId?: string): Promise<LiveDraftRecoveryRecord[]> {
  const rows = await recoveryRecords(directory);
  const before = await readableRecoveryRecords(rows, workspaceId, {objectId, path});
  const removed = new Set<string>();
  for (const row of rows) {
    if (row.record.version !== 1) continue;
    if (row.record.workspaceId !== workspaceId || row.record.objectId !== objectId || typeof row.record.updateBase64 !== "string" || activeTemporaryDrafts.has(row.file)) continue;
    if (recordId !== undefined && basename(row.file).slice(0, 64) !== recordId) continue;
    if (createHash("sha256").update(Buffer.from(row.record.updateBase64, "base64")).digest("hex") !== snapshotSha256) continue;
    // The check and the removal run as one step, so a draft written again
    // after the person saw it stays.
    await onDraftFile(row.file, async () => {
      const modified = await stat(row.file).catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
      if (modified && modified.mtimeMs <= throughMs) {
        await rm(row.file, {force: true});
        draftWrites.delete(row.file);
        removed.add(basename(row.file).slice(0, 64));
      }
    });
  }
  try {return await listLiveDraftRecovery(directory, workspaceId, {objectId, path});}
  catch {return before.filter(record => !removed.has(record.recordId));}
}

/** Exact CRDT recovery complements the renderer's user-visible set-aside text. Answers a handle to this write. */
export async function preserveLiveDraft(directory: string, workspaceId: string, draft: LiveDraft): Promise<string> {
  if (classifyEngineFilePathForRead(draft.path, process.platform).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
  const content = JSON.stringify({ version: 1, workspaceId, path: draft.path, objectId: draft.objectId,
    ...(draft.remoteWorkspaceId !== undefined ? { remoteWorkspaceId: draft.remoteWorkspaceId } : { contentKind: draft.contentKind, text: draft.text }),
    ...(draft.reason ? { reason: draft.reason } : {}),
    updateBase64: Buffer.from(draft.update).toString("base64") });
  const digest = createHash("sha256").update(content).digest("hex");
  const file = join(directory, `${digest}.json`);
  return await onDraftFile(file, async () => {
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${digest}.${randomUUID()}.tmp`);
    activeTemporaryDrafts.add(temporary);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      activeTemporaryDrafts.delete(temporary);
    }
    const write = ++writesSoFar;
    draftWrites.set(file, write);
    return `${digest}:${write}`;
  });
}

/** Removes the draft one write left, unless a later write wrote it again. Answers whether it removed it. */
export async function removeLiveDraft(directory: string, handle: string): Promise<boolean> {
  const parsed = /^([a-f0-9]{64}):([1-9][0-9]*)$/.exec(handle);
  if (!parsed) throw new Error("This is not a draft handle.");
  const file = join(directory, `${parsed[1]}.json`);
  return await onDraftFile(file, async () => {
    if (draftWrites.get(file) !== Number(parsed[2])) return false;
    await rm(file, { force: true });
    draftWrites.delete(file);
    return true;
  });
}

/**
 * The draft calls a workspace's capture makes. After each write, and each
 * removal that removed a draft, the windows showing the workspace hear of it.
 */
export function workspaceDraftStore<Contents extends { isDestroyed(): boolean; send(channel: string, payload: unknown): void }>(
  directory: string,
  workspaceId: string,
  windows: { all(): Iterable<{ webContents: Contents }>; workspaceIdOf(webContents: Contents): string | undefined },
) {
  const changed = () => sendToWorkspaceWindows({
    windows: windows.all(), workspaceIdOf: windows.workspaceIdOf, channel: CHANNELS.liveDraftRecoveryChanged, event: { workspaceId },
  });
  return {
    preserveUnsentState: async (draft: Parameters<typeof preserveUnsentLiveDraft>[2]): Promise<string> => {
      const handle = await preserveUnsentLiveDraft(directory, workspaceId, draft);
      changed();
      return handle;
    },
    discardUnsentState: async (handle: string): Promise<void> => {
      if (await removeLiveDraft(directory, handle)) changed();
    },
  };
}

export async function preserveUnsentLiveDraft(directory: string, workspaceId: string, input: {
  path: string; objectId: string; contentKind: YdocContentKind; doc: Y.Doc; reason?: "deleted";
}): Promise<string> {
  const update = Y.encodeStateAsUpdate(input.doc);
  const reason = input.reason ? { reason: input.reason } : {};
  if (input.contentKind === "scene") {
    return await preserveLiveDraft(directory, workspaceId, {path: input.path, objectId: input.objectId, contentKind: "scene", update, ...reason});
  }
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, update);
    let text: string;
    if (input.contentKind === "plaintext") text = snapshot.getText("plainText").toString();
    else if (input.contentKind === "richdoc") text = (await import("@dohc/ydoc-projection")).yDocToArtifactMarkdown(snapshot);
    else throw new Error("This document format cannot enter text draft recovery.");
    return await preserveLiveDraft(directory, workspaceId, { path: input.path, objectId: input.objectId, contentKind: input.contentKind, text, update, ...reason });
  } finally { snapshot.destroy(); }
}

export async function hasWorkspaceLiveDrafts(directory: string, workspaceId: string): Promise<boolean> {
  return (await recoveryRecords(directory)).some(row => row.record.workspaceId === workspaceId);
}

export async function removeWorkspaceLiveDrafts(directory: string, workspaceId: string): Promise<void> {
  for (const row of await recoveryRecords(directory)) {
    if (row.record.workspaceId === workspaceId && !activeTemporaryDrafts.has(row.file)) {
      await rm(row.file, {force: true});
    }
  }
}
