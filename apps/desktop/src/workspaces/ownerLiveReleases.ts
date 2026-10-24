import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {copyFile, readFile, rm} from "node:fs/promises";
import {dirname, join} from "node:path";
import {z} from "zod";
import {parseLiveObjectBinding, type LiveObjectBinding, type OwnerYDocOutboxRecovery} from "@dohc/workspace-engine-client";
import {atomicWriteFile} from "../atomicReplaceFile";

/**
 * A Stop that took a document's refused edits out of their queue and into the
 * document, but has not written them to its file. Once the release commits,
 * the queue is gone, so only this record says the file still needs them, and
 * the recovery package saved before the release still holds them.
 *
 * `headDeliveryId` names the refused queue the package came from, and
 * `snapshot` the edits it holds: a queue rebuilt under the same binding, or
 * restored from an earlier engine state with the same head but other edits,
 * is another. `retry` is false once the engine no longer holds that release,
 * or when the record could not be read whole: then only Save recovery copy
 * remains. Only Save, or a release that wrote the file while the engine's Stop
 * still named this snapshot, ends a record.
 */
export type UnwrittenRelease = {workspaceId: string; objectId: string; path: string; reason: string;
  binding: LiveObjectBinding | null; headDeliveryId: string | null; snapshot: string | null; retry: boolean};
type QueueIdentity = Pick<UnwrittenRelease, "binding" | "headDeliveryId">;
type ReleaseIdentity = QueueIdentity & Pick<UnwrittenRelease, "snapshot">;

export interface UnwrittenReleases {
  list(workspaceId: string): Promise<UnwrittenRelease[]>;
  /**
   * Writes the queue's recovery package, then the record. Refuses while the
   * document keeps a record of another release or other edits, so its package
   * stays. A record of these same edits keeps the package it already has.
   */
  put(release: UnwrittenRelease & {binding: LiveObjectBinding; headDeliveryId: string; snapshot: string}, recovery: string): Promise<void>;
  /** The recovery package saved before the release. */
  recovery(workspaceId: string, objectId: string): Promise<string | null>;
  /** The engine no longer holds this release: keep the record and its package, without Try again. */
  endRetry(workspaceId: string, objectId: string, binding: LiveObjectBinding): Promise<void>;
  /**
   * A release wrote the file: ends the record of the edits it took, which the
   * engine's Stop names by their snapshot. A release of another Stop under the
   * same binding, restored from an earlier engine state, ends nothing.
   */
  written(workspaceId: string, objectId: string, release: {binding: LiveObjectBinding; snapshot: string | null}): Promise<void>;
  /** Removes the document's record only while it is still the record of this binding, queue and edits. */
  remove(workspaceId: string, objectId: string, record: ReleaseIdentity): Promise<void>;
}

export const sameBinding = (a: LiveObjectBinding | null, b: LiveObjectBinding | null) =>
  a === null || b === null ? a === b : JSON.stringify(parseLiveObjectBinding(a)) === JSON.stringify(parseLiveObjectBinding(b));
const sameQueue = (row: QueueIdentity, record: QueueIdentity) =>
  row.headDeliveryId === record.headDeliveryId && sameBinding(row.binding, record.binding);
/** Whether a record's stored package holds exactly this queue's edits. */
export const sameRelease = (row: ReleaseIdentity, record: ReleaseIdentity) => row.snapshot === record.snapshot && sameQueue(row, record);

/**
 * Which refused edits a queue holds, as one digest: its binding, base and
 * every pending update with its recorded author. When it was read or saved is
 * not part of it, nor is the accepted checkpoint, which moves as the server
 * accepts other edits: a Stop whose release failed keeps the same edits.
 */
export function recoverySnapshot(queue: OwnerYDocOutboxRecovery): string {
  return createHash("sha256").update(JSON.stringify([queue.outboxId, parseLiveObjectBinding(queue.binding), queue.baseUpdateDigest,
    queue.entries.map(({update: _update, ...entry}) => entry)])).digest("hex");
}

/**
 * The record a package of this release must not replace: one of another
 * release or queue, one the engine no longer holds, or one whose package
 * holds other edits. Before the queue is read, pass no snapshot: only the
 * first two can show.
 */
export const keptEarlierRelease = (records: readonly UnwrittenRelease[],
  release: Pick<UnwrittenRelease, "workspaceId" | "objectId"> & QueueIdentity & {snapshot?: string}) =>
  records.find(row => row.workspaceId === release.workspaceId && row.objectId === release.objectId &&
    !(row.retry && sameQueue(row, release) && (release.snapshot === undefined || row.snapshot === release.snapshot)));
export const keptEarlierError = (path: string) =>
  new Error(`dohc still keeps earlier edits for ${path} that it could not write to the file. Save a recovery copy of ${path} first.`);

const UnwrittenReleaseRow = z.object({
  workspaceId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), reason: z.string().min(1),
  binding: z.unknown().transform(value => value === null ? null : parseLiveObjectBinding(value)),
  headDeliveryId: z.string().min(1).nullable(), snapshot: z.string().regex(/^[0-9a-f]{64}$/).nullable(), retry: z.boolean(),
}).strict().refine(row => (row.binding !== null && row.headDeliveryId !== null && row.snapshot !== null) || !row.retry);
// What a damaged row still says: enough to find and save its stored package.
// It names no edits, so no queue's row can stand in for it.
const KeptReleaseRow = z.object({workspaceId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1),
  reason: z.unknown().optional(), headDeliveryId: z.unknown().optional()});

function parseRow(value: unknown): {row: UnwrittenRelease; whole: boolean} | null {
  try {return {row: UnwrittenReleaseRow.parse(value), whole: true};} catch {/* Read what it still says. */}
  const kept = KeptReleaseRow.safeParse(value);
  if (!kept.success) return null;
  const {workspaceId, objectId, path, reason, headDeliveryId} = kept.data;
  const text = (field: unknown) => typeof field === "string" && field ? field : null;
  return {row: {workspaceId, objectId, path, reason: text(reason) ?? "unreadable-record", binding: null,
    headDeliveryId: text(headDeliveryId), snapshot: null, retry: false}, whole: false};
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
  // The record is the notice; a package left behind holds nothing the file still needs.
  const ended = (workspaceId: string, objectId: string, keep: (row: UnwrittenRelease) => boolean) =>
    change(current => current.filter(row => !isRecord(row, workspaceId, objectId) || keep(row)),
      undefined, () => rm(recoveryPath(workspaceId, objectId), {force: true})
        .catch((error: unknown) => console.error("[desktop] could not remove a written live recovery package:", error)));
  return {
    async list(workspaceId) {
      await queue;
      return (await load()).filter(row => row.workspaceId === workspaceId);
    },
    put: (release, recovery) => change(current => [...current.filter(row => !isRecord(row, release.workspaceId, release.objectId)), release],
      async current => {
        const earlier = keptEarlierRelease(current, release);
        if (earlier) throw keptEarlierError(earlier.path);
        // The package already saved for these edits stays: another read of them may carry an older checkpoint, or none.
        if (current.some(row => isRecord(row, release.workspaceId, release.objectId) && sameRelease(row, release))) return;
        await atomicWriteFile(recoveryPath(release.workspaceId, release.objectId), recovery);
      }),
    async recovery(workspaceId, objectId) {
      await queue;
      return readFile(recoveryPath(workspaceId, objectId), "utf8").catch((error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return null; throw error;});
    },
    endRetry: (workspaceId, objectId, binding) => change(current => current.map(row =>
      isRecord(row, workspaceId, objectId) && row.retry && sameBinding(row.binding, binding) ? {...row, retry: false} : row)),
    written: (workspaceId, objectId, {binding, snapshot}) =>
      ended(workspaceId, objectId, row => !row.retry || snapshot === null || row.snapshot !== snapshot || !sameBinding(row.binding, binding)),
    remove: (workspaceId, objectId, record) => ended(workspaceId, objectId, row => !sameRelease(row, record)),
  };
}
