import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { atomicWriteFile } from "../atomicReplaceFile";
import type { SetAsideDraftChange, SetAsideDraftFile } from "../ipc/bridgeContract";

const DRAFT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const UNFINISHED_WRITE = /^[0-9a-f-]{36}\.json\.tmp-(\d+)-/;

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
    classifyEngineFilePathForRead(row.path, process.platform).kind === "tracked"
  );
}

/**
 * The set-aside drafts of every window, one file each. A write or removal
 * applies only while the file holds what the caller last saw, and answers
 * true once the change is on disk. `changed` hears each change first.
 */
export function setAsideDraftFiles(
  directory: string,
  changed: (change: SetAsideDraftChange) => void,
) {
  const work = new Map<string, Promise<unknown>>();
  const onFile = <T>(key: string, step: () => Promise<T>): Promise<T> => {
    const result = (work.get(key) ?? Promise.resolve()).then(step, step);
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
  return {
    async list(): Promise<SetAsideDraftFile[]> {
      const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const files: SetAsideDraftFile[] = [];
      for (const name of names) {
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
  };
}
