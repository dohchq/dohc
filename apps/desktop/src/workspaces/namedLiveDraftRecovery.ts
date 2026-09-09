import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";

export interface NamedLiveDraft {
  path: string;
  objectId: string;
  remoteWorkspaceId: string;
  update: Uint8Array;
}

/** Exact CRDT recovery complements the renderer's user-visible set-aside text. */
export async function preserveNamedLiveDraft(directory: string, workspaceId: string, draft: NamedLiveDraft): Promise<void> {
  if (classifyEngineFilePathForRead(draft.path).kind !== "tracked") throw new Error("This path cannot enter draft recovery.");
  const content = JSON.stringify({ version: 1, workspaceId, path: draft.path, objectId: draft.objectId,
    remoteWorkspaceId: draft.remoteWorkspaceId, updateBase64: Buffer.from(draft.update).toString("base64") });
  const digest = createHash("sha256").update(content).digest("hex");
  await mkdir(directory, { recursive: true });
  // Each complete snapshot has its own name. A failed write is retried; it
  // never replaces a different recovery or permits the provider to close.
  await writeFile(join(directory, `${digest}.json`), content, { encoding: "utf8", flush: true });
}
