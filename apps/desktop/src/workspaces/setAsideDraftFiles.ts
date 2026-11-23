import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { atomicWriteFile } from "../atomicReplaceFile";
import type { SetAsideDraftChange, SetAsideDraftFile } from "../ipc/bridgeContract";
import type { PendingTreeChange } from "../renderer/workbench/file-tree-optimistic";
import { movedSetAsideDraft } from "./movedSetAsideDraft";

const DRAFT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const UNFINISHED_WRITE = /^[0-9a-f-]{36}\.json\.tmp-(\d+)-/;

function tracked(path: string): boolean {
  return classifyEngineFilePathForRead(path, process.platform).kind === "tracked";
}

function tracksPath(raw: string): boolean {
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    return false;
  }
  return (
    typeof row === "object" &&
    row !== null &&
    "path" in row &&
    typeof row.path === "string" &&
    tracked(row.path)
  );
}

export function setAsideDraftFiles(
  directory: string,
  changed: (change: SetAsideDraftChange) => void,
) {
  const work = new Map<string, Promise<unknown>>();
  let moving: Promise<unknown> = Promise.resolve();
  const onFile = <T>(key: string, step: () => Promise<T>): Promise<T> => {
    const result = Promise.all([work.get(key), moving]).then(step, step);
    const settled = result.catch(() => undefined);
    work.set(key, settled);
    void settled.then(() => {
      if (work.get(key) === settled) work.delete(key);
    });
    return result;
  };
  const file = (key: string) => join(directory, `${key}.json`);
  const read = (key: string) =>
    readFile(file(key), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const names = () =>
    readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  return {
    async list(): Promise<SetAsideDraftFile[]> {
      const files: SetAsideDraftFile[] = [];
      for (const name of await names()) {
        const unfinished = UNFINISHED_WRITE.exec(name);
        if (unfinished && Number(unfinished[1]) !== process.pid) {
          await rm(join(directory, name), { force: true });
          continue;
        }
        const key = DRAFT_FILE.exec(name)?.[1];
        if (key === undefined) continue;
        const raw = await onFile(key, () => read(key));
        if (raw !== null) files.push({ key, raw });
      }
      return files;
    },
    write(key: string, raw: string, ifCurrent: string | null): Promise<boolean> {
      if (!tracksPath(raw)) throw new Error("This path cannot enter set-aside drafts.");
      return onFile(key, async () => {
        if ((await read(key)) !== ifCurrent) return false;
        await mkdir(directory, { recursive: true });
        await atomicWriteFile(file(key), raw);
        changed({ key, raw });
        return true;
      });
    },
    remove(key: string, ifCurrent: string): Promise<boolean> {
      return onFile(key, async () => {
        if ((await read(key)) !== ifCurrent) return false;
        await rm(file(key), { force: true });
        changed({ key, raw: null });
        return true;
      });
    },
    move(workspaceId: string, changes: readonly PendingTreeChange[]): Promise<null> {
      const result = Promise.all([moving, ...work.values()]).then(async () => {
        for (const name of await names()) {
          const key = DRAFT_FILE.exec(name)?.[1];
          const raw = key === undefined ? null : await read(key);
          const moved = raw === null ? null : movedSetAsideDraft(raw, workspaceId, changes);
          if (key === undefined || moved === null) continue;
          if (tracked(moved.path)) {
            await atomicWriteFile(file(key), moved.raw);
            changed({ key, raw: moved.raw });
          } else {
            await rm(file(key), { force: true });
            changed({ key, raw: null });
          }
        }
        return null;
      });
      moving = result.catch(() => undefined);
      return result;
    },
  };
}
