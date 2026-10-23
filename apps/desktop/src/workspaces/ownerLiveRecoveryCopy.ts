import {createHash} from "node:crypto";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import type {OwnerYDocOutboxEntry, OwnerYDocOutboxPending} from "@dohc/workspace-engine-client";

export const LIVE_RECOVERY_FORMAT = "dohc.live-recovery";

/** The queue being saved: which file it belongs to, why it waits, and where it is kept. */
export type LiveRecoverySource = {path: string; reason: string; storedOn: "this-computer"};

/** Workspace-relative paths of what Save recovery copy wrote. */
export type LiveRecoveryFiles = {copyPath: string | null; packagePath: string};

/** Creates one new file and returns once it is on disk. An existing path refuses with EEXIST. */
export type CreateDurableFile = (relativePath: string, text: string) => Promise<string>;

const MAX_NAME_ATTEMPTS = 100;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

function author(entry: OwnerYDocOutboxEntry) {
  if (entry.agentDeclaration) return {kind: "agent", declaration: entry.agentDeclaration};
  if (entry.automationDeclaration) return {kind: "automation", declaration: entry.automationDeclaration};
  return entry.personEdit ? {kind: "person"} : null;
}

/** The queued edits as Markdown, or null when they cannot all be applied. */
function readableCopy(pending: OwnerYDocOutboxPending): string | null {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, pending.baseUpdate);
    for (const entry of pending.entries) Y.applyUpdate(doc, entry.update);
    // An update missing what it depends on would leave its edit out of the copy.
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return null;
    return yDocToMarkdown(doc);
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

function recoveredName(path: string, attempt: number, extension?: string): string {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  return `${stem} (recovered${attempt === 1 ? "" : ` ${attempt}`})${extension ?? ext}`;
}

async function createFirstFree(create: CreateDurableFile, name: (attempt: number) => string, text: string, from = 1): Promise<{path: string; attempt: number}> {
  for (let attempt = from; attempt < from + MAX_NAME_ATTEMPTS; attempt += 1) {
    try {return {path: await create(name(attempt), text), attempt};}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;}
  }
  throw new Error("dohc could not find a free name for the recovery copy. Rename older recovery copies, then try again.");
}

/**
 * Saves a refused queue next to its file and leaves the queue as it is.
 *
 * The package is written first and always: it holds the original bytes, so a
 * person or an agent can rebuild the document even when no readable copy can
 * be made. Apply `base`, then each of `updates` in order, as Yjs v1 updates to
 * an empty Y.Doc. Each `sha256` is the hex SHA-256 of the decoded bytes.
 */
export async function saveLiveRecoveryCopy(pending: OwnerYDocOutboxPending, source: LiveRecoverySource,
  create: CreateDurableFile, now = Date.now()): Promise<LiveRecoveryFiles> {
  if (sha256(pending.baseUpdate) !== pending.baseUpdateDigest || pending.entries.some(entry => sha256(entry.update) !== entry.updateDigest)) {
    throw new Error("dohc could not read your kept edits completely. Try again.");
  }
  const packageText = JSON.stringify({
    format: LIVE_RECOVERY_FORMAT, version: 1,
    open: "Apply base, then each update in order, as Yjs v1 updates to an empty Y.Doc. Each sha256 is the hex SHA-256 of the decoded bytes.",
    savedAt: new Date(now).toISOString(), path: source.path, reason: source.reason, storedOn: source.storedOn,
    outboxId: pending.outboxId, binding: pending.binding,
    base: {sha256: pending.baseUpdateDigest, byteLength: pending.baseUpdate.byteLength, base64: base64(pending.baseUpdate)},
    updates: pending.entries.map(entry => ({sequence: entry.sequence, deliveryId: entry.deliveryId, appendKey: entry.appendKey,
      createdAtMs: entry.createdAtMs, sha256: entry.updateDigest, byteLength: entry.byteLength, author: author(entry), base64: base64(entry.update)})),
  }, null, 2);
  const markdown = readableCopy(pending);
  const packageFile = await createFirstFree(create, attempt => recoveredName(source.path, attempt, ".dohc-recovery.json"), packageText);
  if (markdown === null) return {copyPath: null, packagePath: packageFile.path};
  const copy = await createFirstFree(create, attempt => recoveredName(source.path, attempt), markdown, packageFile.attempt);
  return {copyPath: copy.path, packagePath: packageFile.path};
}
