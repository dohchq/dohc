import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import type { YdocContentKind } from "@dohc/workspace-engine-client";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";

export type LiveDraft = {
  path: string;
  objectId: string;
  update: Uint8Array;
} & (
  { remoteWorkspaceId: string; text?: never; contentKind?: never } |
  { text: string; contentKind: "plaintext" | "richdoc"; remoteWorkspaceId?: never } |
  { contentKind: "scene"; text?: never; remoteWorkspaceId?: never }
);

const activeTemporaryDrafts = new Set<string>();

const STALE_TEMPORARY_DRAFT_MS = 24 * 60 * 60 * 1000;

async function recoveryRecords(directory: string): Promise<{file: string; record: Record<string, unknown>}[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return []; throw error;});
  const rows: {file: string; record: Record<string, unknown>}[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) && !name.endsWith(".tmp")) continue;
    let file = join(directory, name);
    let raw: string;
    try {raw = await readFile(file, "utf8");} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error;}
    let record: Record<string, unknown>;
    try {const value: unknown = JSON.parse(raw); record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};}
    catch {const match = /"workspaceId"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw); record = match ? {workspaceId: JSON.parse(match[1]!)} : {};}
    if (name.endsWith(".tmp") && !activeTemporaryDrafts.has(file) && Date.now() - (await stat(file)).mtimeMs >= STALE_TEMPORARY_DRAFT_MS) {
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
  }
  return rows;
}

export async function hasRetainedLiveDraft(directory: string, workspaceId: string, path: string, objectId: string): Promise<boolean> {
  for (const {record} of await recoveryRecords(directory)) {
    if (typeof record.workspaceId === "string" && record.workspaceId !== workspaceId) continue;
    if (record.workspaceId !== workspaceId) throw new Error("Saved live draft cannot be attributed to a workspace.");
    if (typeof record.path !== "string" || typeof record.objectId !== "string") throw new Error("Invalid saved live draft.");
    if (record.objectId === objectId || record.path === path) return true;
  }
  return false;
}

export async function removeLiveDraftCopies(directory: string, workspaceId: string, objectId: string, snapshotSha256: string, throughMs: number): Promise<void> {
  for (const row of await recoveryRecords(directory)) {
    if (row.record.workspaceId !== workspaceId || row.record.objectId !== objectId || typeof row.record.updateBase64 !== "string" || activeTemporaryDrafts.has(row.file)) continue;
    if (createHash("sha256").update(Buffer.from(row.record.updateBase64, "base64")).digest("hex") !== snapshotSha256) continue;
    const modified = await stat(row.file).catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
    if (modified && modified.mtimeMs <= throughMs) await rm(row.file, {force: true});
  }
}

/** Exact CRDT recovery complements the renderer's user-visible set-aside text. */
export async function preserveLiveDraft(directory: string, workspaceId: string, draft: LiveDraft): Promise<void> {
  if (classifyEngineFilePathForRead(draft.path, process.platform).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
  const content = JSON.stringify({ version: 1, workspaceId, path: draft.path, objectId: draft.objectId,
    ...(draft.remoteWorkspaceId !== undefined ? { remoteWorkspaceId: draft.remoteWorkspaceId } : { contentKind: draft.contentKind, text: draft.text }),
    updateBase64: Buffer.from(draft.update).toString("base64") });
  const digest = createHash("sha256").update(content).digest("hex");
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${digest}.${randomUUID()}.tmp`);
  activeTemporaryDrafts.add(temporary);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
    await rename(temporary, join(directory, `${digest}.json`));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    activeTemporaryDrafts.delete(temporary);
  }
}

export async function preserveUnsentLiveDraft(directory: string, workspaceId: string, input: {
  path: string; objectId: string; contentKind: YdocContentKind; doc: Y.Doc;
}): Promise<void> {
  const update = Y.encodeStateAsUpdate(input.doc);
  if (input.contentKind === "scene") {
    await preserveLiveDraft(directory, workspaceId, {path: input.path, objectId: input.objectId, contentKind: "scene", update});
    return;
  }
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, update);
    let text: string;
    if (input.contentKind === "plaintext") text = snapshot.getText("plainText").toString();
    else if (input.contentKind === "richdoc") text = (await import("@dohc/ydoc-projection")).yDocToMarkdown(snapshot);
    else throw new Error("This document format cannot enter text draft recovery.");
    await preserveLiveDraft(directory, workspaceId, { path: input.path, objectId: input.objectId, contentKind: input.contentKind, text, update });
  } finally { snapshot.destroy(); }
}

export async function removeWorkspaceLiveDrafts(directory: string, workspaceId: string): Promise<void> {
  for (const row of await recoveryRecords(directory)) {
    if (row.record.workspaceId === workspaceId && !activeTemporaryDrafts.has(row.file)) {
      await rm(row.file, {force: true});
    }
  }
}
