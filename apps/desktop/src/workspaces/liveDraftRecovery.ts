import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    const path = join(directory, name);
    if (name.endsWith(".tmp")) {
      // Interrupted writes cannot identify their workspace; leave current writes alone.
      if (!activeTemporaryDrafts.has(path)) await rm(path, { force: true });
      continue;
    }
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let record: unknown;
    try {
      record = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (typeof record === "object" && record !== null && "workspaceId" in record && record.workspaceId === workspaceId) {
      await rm(path, { force: true });
    }
  }
}
