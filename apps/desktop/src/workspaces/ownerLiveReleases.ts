import {createHash} from "node:crypto";
import {constants} from "node:fs";
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
 *
 * `retry` is false once the engine no longer holds that release, or when the
 * record could not be read whole: then only Save recovery copy remains.
 */
export type UnwrittenRelease = {workspaceId: string; objectId: string; path: string; reason: string; binding: LiveObjectBinding | null; retry: boolean};

export interface UnwrittenReleases {
  list(workspaceId: string): Promise<UnwrittenRelease[]>;
  /**
   * Writes the queue's recovery package, then the record. Refuses while the
   * document keeps a record of another release, so its package stays.
   */
  put(release: UnwrittenRelease, recovery: string): Promise<void>;
  /** The recovery package saved before the release. */
  recovery(workspaceId: string, objectId: string): Promise<string | null>;
  /** The engine no longer holds this release: keep the record and its package, without Try again. */
  endRetry(workspaceId: string, objectId: string, binding: LiveObjectBinding): Promise<void>;
  /** Removes the document's record only while it is still the record of this binding. */
  remove(workspaceId: string, objectId: string, binding: LiveObjectBinding | null): Promise<void>;
}

export const sameBinding = (a: LiveObjectBinding | null, b: LiveObjectBinding | null) =>
  a === null || b === null ? a === b : JSON.stringify(parseLiveObjectBinding(a)) === JSON.stringify(parseLiveObjectBinding(b));

const UnwrittenReleaseRow = z.object({
  workspaceId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), reason: z.string().min(1),
  binding: z.unknown().transform(value => value === null ? null : parseLiveObjectBinding(value)), retry: z.boolean(),
}).strict().refine(row => row.binding !== null || !row.retry);
// What a damaged row still says: enough to find and save its stored package.
const KeptReleaseRow = z.object({workspaceId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), reason: z.unknown()});

function parseRow(value: unknown): {row: UnwrittenRelease; whole: boolean} | null {
  try {return {row: UnwrittenReleaseRow.parse(value), whole: true};} catch {/* Read what it still says. */}
  const kept = KeptReleaseRow.safeParse(value);
  if (!kept.success) return null;
  const {workspaceId, objectId, path, reason} = kept.data;
  return {row: {workspaceId, objectId, path, reason: typeof reason === "string" && reason ? reason : "unreadable-record", binding: null, retry: false}, whole: false};
}

/** One file on this computer, written durably, so the notice survives a restart. */
export function createUnwrittenReleases(filePath: () => string): UnwrittenReleases {
  let rows: UnwrittenRelease[] | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  // Beside the records, so the directory sync that publishes a package needs no new folder.
  const recoveryPath = (workspaceId: string, objectId: string) => join(dirname(filePath()),
    `owner-live-recovery-${createHash("sha256").update(`${workspaceId}\0${objectId}`).digest("hex")}.dohc-recovery.json`);
  // A damaged row is kept without Try again, with the file it came from set aside once per content.
  const read = async (): Promise<UnwrittenRelease[]> => {
    const text = await readFile(filePath(), "utf8").catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
    if (text === null) return [];
    let values: unknown;
    try {values = JSON.parse(text);} catch {values = null;}
    const parsed = Array.isArray(values) ? values.map(parseRow) : [null];
    const kept = parsed.filter(row => row !== null);
    if (kept.length !== parsed.length || kept.some(row => !row.whole)) {
      const aside = `${filePath()}.unreadable-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
      await copyFile(filePath(), aside, constants.COPYFILE_EXCL).then(
        () => console.error(`[desktop] skipped ${parsed.length - kept.length} and kept ${kept.filter(row => !row.whole).length} damaged live edit records; the file is kept at ${aside}`),
        (error: NodeJS.ErrnoException) => {if (error.code !== "EEXIST") console.error(`[desktop] could not keep the unreadable live edit records at ${aside}:`, error);});
    }
    return kept.map(row => row.row);
  };
  const load = async (): Promise<UnwrittenRelease[]> => rows ??= await read();
  const change = (edit: (current: UnwrittenRelease[]) => UnwrittenRelease[], before?: (current: UnwrittenRelease[]) => Promise<void>, after?: () => Promise<void>): Promise<void> => {
    const next = queue.then(async () => {
      const current = await load();
      await before?.(current);
      const updated = edit(current);
      if (updated.length !== current.length || updated.some((row, index) => row !== current[index])) {
        await atomicWriteFile(filePath(), JSON.stringify(updated));
        rows = updated;
        await after?.();
      }
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const isRecord = (row: UnwrittenRelease, workspaceId: string, objectId: string) => row.workspaceId === workspaceId && row.objectId === objectId;
  return {
    async list(workspaceId) {
      await queue;
      return (await load()).filter(row => row.workspaceId === workspaceId);
    },
    put: (release, recovery) => change(current => [...current.filter(row => !isRecord(row, release.workspaceId, release.objectId)), release],
      async current => {
        const earlier = current.find(row => isRecord(row, release.workspaceId, release.objectId));
        if (earlier && !(earlier.retry && sameBinding(earlier.binding, release.binding))) {
          throw new Error(`dohc still keeps earlier edits for ${earlier.path} that it could not write to the file. Save a recovery copy of ${earlier.path} first.`);
        }
        await atomicWriteFile(recoveryPath(release.workspaceId, release.objectId), recovery);
      }),
    async recovery(workspaceId, objectId) {
      await queue;
      return readFile(recoveryPath(workspaceId, objectId), "utf8").catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
    },
    endRetry: (workspaceId, objectId, binding) => change(current => current.map(row =>
      isRecord(row, workspaceId, objectId) && row.retry && sameBinding(row.binding, binding) ? {...row, retry: false} : row)),
    // The record is the notice; a package left behind holds nothing the file still needs.
    remove: (workspaceId, objectId, binding) => change(current => current.filter(row => !isRecord(row, workspaceId, objectId) || !sameBinding(row.binding, binding)),
      undefined, () => rm(recoveryPath(workspaceId, objectId), {force: true})
        .catch((error: unknown) => console.error("[desktop] could not remove a written live recovery package:", error))),
  };
}
