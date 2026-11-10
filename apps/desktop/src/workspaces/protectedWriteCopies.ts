import { randomUUID } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomicReplaceFile";
import { localStateFolder, type LocalStateWorkspace } from "./workspaceLocalState";

// Text of a protected file that a sync was about to replace and History did
// not hold. It stays on this computer: `.dohc` is never captured, synced,
// shared or exported, and dohc's file tools refuse to read it. A copy stays
// until Restore or Discard.
export const PROTECTED_COPIES_PATH = ".dohc/local/protected-copies";
// The engine's MAX_SECRET_FILE_BYTES: protected History holds nothing larger.
export const MAX_PROTECTED_HISTORY_BYTES = 1024 * 1024;
const guard = { path: PROTECTED_COPIES_PATH, lead: "dohc could not keep a copy of a protected file, so it left the file as it was." };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COPY_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
// atomicWriteFile's temp name, left behind when dohc stopped mid-write.
const TEMPORARY = /^[0-9a-f-]{36}\.json\.tmp-\d+-[0-9a-f-]{36}$/;
const KeptText = z.object({
  path: z.string(),
  id: z.string().regex(ID),
  versionId: z.string(),
  createdAtMs: z.number(),
  text: z.string(),
}).strict();
export type ProtectedCopy = z.infer<typeof KeptText>;
type CopyFacts = Omit<ProtectedCopy, "text">;
export type ProtectedCopyRow = [path: string, id: string, keptAtMs: number];

// Names the file only. JSON.parse and zod messages can quote the text.
export class ProtectedCopyReadError extends Error {
  override name = "ProtectedCopyReadError";
  constructor(readonly path: string) {
    super(`Could not read ${path}`);
  }
}

export class ProtectedCopyIdError extends Error {
  override name = "ProtectedCopyIdError";
  constructor() {
    super("That kept copy id is not valid.");
  }
}

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";

function ignoreMissing(error: unknown): undefined {
  if (isErrno(error) && error.code === "ENOENT") return undefined;
  throw error;
}

function checkedId(id: string): string {
  if (!ID.test(id)) throw new ProtectedCopyIdError();
  return id;
}

async function readCopy(dir: string, name: string): Promise<ProtectedCopy> {
  const shown = `${PROTECTED_COPIES_PATH}/${name}`;
  const text = await readFile(join(dir, name), "utf8");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ProtectedCopyReadError(shown); }
  const parsed = KeptText.safeParse(value);
  if (!parsed.success || `${parsed.data.id}.json` !== name) throw new ProtectedCopyReadError(shown);
  return parsed.data;
}

export function protectedWriteCopies(workspace: LocalStateWorkspace) {
  let pending = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(task);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  const directory = () => localStateFolder(workspace, "protected-copies", guard);
  // Facts by file name, so a poll rereads no text. Each name is written once.
  const known = new Map<string, CopyFacts>();
  async function load(onReadError: (error: unknown) => void): Promise<CopyFacts[]> {
    const dir = await directory();
    const present = new Set<string>();
    for (const name of await readdir(dir)) {
      if (TEMPORARY.test(name)) {
        await unlink(join(dir, name)).catch(ignoreMissing);
        continue;
      }
      if (!COPY_FILE.test(name)) continue;
      present.add(name);
      if (known.has(name)) continue;
      try {
        const copy = await readCopy(dir, name);
        known.set(name, { path: copy.path, id: copy.id, versionId: copy.versionId, createdAtMs: copy.createdAtMs });
      } catch (error) {
        onReadError(error);
      }
    }
    for (const name of known.keys()) if (!present.has(name)) known.delete(name);
    return [...known.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  return {
    list(onReadError: (error: unknown) => void = () => undefined): Promise<ProtectedCopyRow[]> {
      return enqueue(async () => (await load(onReadError)).map(copy => [copy.path, copy.id, copy.createdAtMs]));
    },
    // False when a copy of this path and version already holds this text.
    keep(path: string, text: string, versionId: string): Promise<boolean> {
      return enqueue(async () => {
        const dir = await directory();
        // An unreadable copy is reported by list; it never blocks a new one.
        for (const copy of await load(() => undefined)) {
          if (copy.path !== path || copy.versionId !== versionId) continue;
          const saved = await readCopy(dir, `${copy.id}.json`).catch(() => null);
          if (saved?.text === text) return false;
        }
        const id = randomUUID();
        const createdAtMs = Date.now();
        // Written whole or not at all, at 0600, before the file is replaced.
        await atomicWriteFile(join(dir, `${id}.json`), JSON.stringify({ path, id, versionId, createdAtMs, text }));
        known.set(`${id}.json`, { path, id, versionId, createdAtMs });
        return true;
      });
    },
    read(id: string): Promise<ProtectedCopy | null> {
      return enqueue(async () => {
        const dir = await directory();
        return await readCopy(dir, `${checkedId(id)}.json`).catch(ignoreMissing) ?? null;
      });
    },
    // False when no copy has this id.
    remove(id: string): Promise<boolean> {
      return enqueue(async () => {
        const name = `${checkedId(id)}.json`;
        const removed = await unlink(join(await directory(), name)).then(() => true, (error: unknown) => ignoreMissing(error) ?? false);
        known.delete(name);
        return removed;
      });
    },
  };
}

export type ProtectedWriteCopies = ReturnType<typeof protectedWriteCopies>;
