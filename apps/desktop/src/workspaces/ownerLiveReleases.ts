import {createHash} from "node:crypto";
import {copyFile, readFile, rm} from "node:fs/promises";
import {dirname, join} from "node:path";
import {z} from "zod";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/workspace-engine-client";
import {atomicWriteFile} from "../atomicReplaceFile";

/**
 * A Stop that took a document's refused edits out of their queue and into the
 * document, but has not written them to its file. Once the release commits,
 * the queue is gone, so only this record says the file still needs them, and
 * the recovery package saved before the release still holds them.
 */
export type UnwrittenRelease = {workspaceId: string; objectId: string; path: string; reason: string; binding: LiveObjectBinding};

export interface UnwrittenReleases {
  list(workspaceId: string): Promise<UnwrittenRelease[]>;
  /** Writes the queue's recovery package, then the record. */
  put(release: UnwrittenRelease, recovery: string): Promise<void>;
  /** The recovery package saved before the release. */
  recovery(workspaceId: string, objectId: string): Promise<string | null>;
  remove(workspaceId: string, objectId: string): Promise<void>;
}

const UnwrittenReleaseRow = z.object({
  workspaceId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), reason: z.string().min(1),
  binding: z.unknown().transform(value => parseLiveObjectBinding(value)),
}).strict();

function parseRow(value: unknown): UnwrittenRelease | null {
  try {return UnwrittenReleaseRow.parse(value);} catch {return null;}
}

/** One file on this computer, written durably, so the notice survives a restart. */
export function createUnwrittenReleases(filePath: () => string): UnwrittenReleases {
  let rows: UnwrittenRelease[] | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  // Beside the records, so the directory sync that publishes a package needs no new folder.
  const recoveryPath = (workspaceId: string, objectId: string) => join(dirname(filePath()),
    `owner-live-recovery-${createHash("sha256").update(`${workspaceId}\0${objectId}`).digest("hex")}.dohc-recovery.json`);
  // One unreadable row is set aside with the file it came from; the others still count.
  const read = async (): Promise<UnwrittenRelease[]> => {
    const text = await readFile(filePath(), "utf8").catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
    if (text === null) return [];
    let values: unknown;
    try {values = JSON.parse(text);} catch {values = null;}
    const parsed = Array.isArray(values) ? values.map(parseRow) : [null];
    const valid = parsed.filter((row): row is UnwrittenRelease => row !== null);
    if (valid.length !== parsed.length) {
      const aside = `${filePath()}.unreadable-${Date.now()}`;
      await copyFile(filePath(), aside);
      console.error(`[desktop] skipped ${parsed.length - valid.length} unreadable live edit records; the file is kept at ${aside}`);
    }
    return valid;
  };
  const load = async (): Promise<UnwrittenRelease[]> => rows ??= await read();
  const change = (edit: (current: UnwrittenRelease[]) => UnwrittenRelease[], before?: () => Promise<void>, after?: () => Promise<void>): Promise<void> => {
    const next = queue.then(async () => {
      await before?.();
      const current = await load(), updated = edit(current);
      if (updated.length !== current.length || updated.some((row, index) => row !== current[index])) {
        await atomicWriteFile(filePath(), JSON.stringify(updated));
        rows = updated;
      }
      await after?.();
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    async list(workspaceId) {
      await queue;
      return (await load()).filter(row => row.workspaceId === workspaceId);
    },
    put: (release, recovery) => change(current => [...current.filter(row => row.workspaceId !== release.workspaceId || row.objectId !== release.objectId), release],
      () => atomicWriteFile(recoveryPath(release.workspaceId, release.objectId), recovery)),
    async recovery(workspaceId, objectId) {
      await queue;
      return readFile(recoveryPath(workspaceId, objectId), "utf8").catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
    },
    remove: (workspaceId, objectId) => change(current => current.filter(row => row.workspaceId !== workspaceId || row.objectId !== objectId),
      undefined, () => rm(recoveryPath(workspaceId, objectId), {force: true})),
  };
}
