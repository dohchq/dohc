import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import type { YdocContentKind } from "@dohc/workspace-engine-client";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";

export type LiveDraft = {
  path: string;
  objectId: string;
  update: Uint8Array;
} & ({ remoteWorkspaceId: string; text?: never } | { text: string; remoteWorkspaceId?: never });

/** Exact CRDT recovery complements the renderer's user-visible set-aside text. */
export async function preserveLiveDraft(directory: string, workspaceId: string, draft: LiveDraft): Promise<void> {
  if (classifyEngineFilePathForRead(draft.path, process.platform).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
  const content = JSON.stringify({ version: 1, workspaceId, path: draft.path, objectId: draft.objectId,
    ...(draft.remoteWorkspaceId !== undefined ? { remoteWorkspaceId: draft.remoteWorkspaceId } : { text: draft.text }),
    updateBase64: Buffer.from(draft.update).toString("base64") });
  const digest = createHash("sha256").update(content).digest("hex");
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${digest}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", flush: true });
    await rename(temporary, join(directory, `${digest}.json`));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function preserveUnsentLiveDraft(directory: string, workspaceId: string, input: {
  path: string; objectId: string; contentKind: YdocContentKind; doc: Y.Doc;
}): Promise<void> {
  const update = Y.encodeStateAsUpdate(input.doc);
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, update);
    let text: string;
    if (input.contentKind === "plaintext") text = snapshot.getText("plainText").toString();
    else if (input.contentKind === "richdoc") text = (await import("@dohc/ydoc-projection")).yDocToMarkdown(snapshot);
    else throw new Error("This document format cannot enter text draft recovery.");
    await preserveLiveDraft(directory, workspaceId, { path: input.path, objectId: input.objectId, text, update });
  } finally { snapshot.destroy(); }
}
