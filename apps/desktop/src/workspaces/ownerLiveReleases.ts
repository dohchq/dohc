import {readFile} from "node:fs/promises";
import {z} from "zod";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/workspace-engine-client";
import {atomicWriteFile} from "../atomicReplaceFile";

/**
 * A Stop that took a document's refused edits out of their queue and into the
 * document, but has not written them to its file. Once the release commits,
 * the queue is gone, so only this record says the file still needs them.
 */
export type UnwrittenRelease = {workspaceId: string; objectId: string; path: string; reason: string; binding: LiveObjectBinding};

export interface UnwrittenReleases {
  list(workspaceId: string): Promise<UnwrittenRelease[]>;
  put(release: UnwrittenRelease): Promise<void>;
  remove(workspaceId: string, match: {objectId: string} | {path: string}): Promise<void>;
}

const UnwrittenReleaseRow = z.object({
  workspaceId: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1), reason: z.string().min(1),
  binding: z.unknown().transform(value => parseLiveObjectBinding(value)),
}).strict();

/** One file on this computer, written durably, so the notice survives a restart. */
export function createUnwrittenReleases(filePath: () => string): UnwrittenReleases {
  let rows: UnwrittenRelease[] | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<UnwrittenRelease[]> => rows ??= await readFile(filePath(), "utf8").then(
    text => z.array(UnwrittenReleaseRow).parse(JSON.parse(text)),
    (error: NodeJS.ErrnoException) => {if (error.code === "ENOENT") return []; throw error;});
  const change = (edit: (current: UnwrittenRelease[]) => UnwrittenRelease[]): Promise<void> => {
    const next = queue.then(async () => {
      const current = await load(), updated = edit(current);
      if (updated.length === current.length && updated.every((row, index) => row === current[index])) return;
      await atomicWriteFile(filePath(), JSON.stringify(updated));
      rows = updated;
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const matches = (row: UnwrittenRelease, workspaceId: string, match: {objectId: string} | {path: string}) =>
    row.workspaceId === workspaceId && ("objectId" in match ? row.objectId === match.objectId : row.path === match.path);
  return {
    async list(workspaceId) {
      await queue;
      return (await load()).filter(row => row.workspaceId === workspaceId);
    },
    put: release => change(current => [...current.filter(row => !matches(row, release.workspaceId, release)), release]),
    remove: (workspaceId, match) => change(current => current.filter(row => !matches(row, workspaceId, match))),
  };
}
