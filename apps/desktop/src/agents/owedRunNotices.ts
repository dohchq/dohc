import { mkdir, readFile, rename } from "node:fs/promises";
import { atomicWriteFile, type DurableFileOperations } from "../atomicReplaceFile";
import { dirname } from "node:path";

// The agent runs whose notice is owed: each is added before the run's end
// is saved and removed once the notice for how it ended is posted. A file
// keeps them, so a crash between the two cannot lose a notice.
export interface OwedRunNotices {
  add(workspaceId: string, runId: string): Promise<void>;
  remove(workspaceId: string, runId: string): Promise<void>;
  list(workspaceId: string): Promise<string[]>;
}

// Past this many, the oldest go. Only notices that cannot be posted for a
// long time pile up.
const OWED_RUN_NOTICES_LIMIT = 1_000;

type Owed = Array<[workspaceId: string, runId: string]>;

export function createOwedRunNotices(path: () => string, fileOperations?: DurableFileOperations): OwedRunNotices {
  let loaded: Promise<Owed> | null = null;
  const pending: Array<{ update(owed: Owed): Owed | null; resolve(): void; reject(error: unknown): void }> = [];
  let writing = false;
  const load = () => (loaded ??= read(path()).catch((error: unknown) => {
    loaded = null;
    throw error;
  }));
  // A change reaches memory only once the file holds it, so a failed write
  // leaves both as they were and the caller can try again.
  const change = (update: (owed: Owed) => Owed | null): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      pending.push({ update, resolve, reject });
      if (!writing) {
        writing = true;
        queueMicrotask(() => { void drain(); });
      }
    });
  };
  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const batch = pending.splice(0);
      try {
        const owed = await load();
        let next = owed;
        for (const job of batch) next = job.update(next) ?? next;
        if (next !== owed) {
          await write(path(), next, fileOperations);
          owed.splice(0, owed.length, ...next);
        }
        for (const job of batch) job.resolve();
      } catch (error) {
        for (const job of batch) job.reject(error);
      }
    }
    writing = false;
  }
  const owes = (workspaceId: string, runId: string) =>
    ([workspace, run]: [string, string]) => workspace === workspaceId && run === runId;
  return {
    add: (workspaceId, runId) => change((owed) =>
      owed.some(owes(workspaceId, runId))
        ? null
        : [...owed, [workspaceId, runId] as [string, string]].slice(-OWED_RUN_NOTICES_LIMIT)),
    remove: (workspaceId, runId) => change((owed) =>
      owed.some(owes(workspaceId, runId))
        ? owed.filter((entry) => !owes(workspaceId, runId)(entry))
        : null),
    list: async (workspaceId) =>
      (await load()).filter(([workspace]) => workspace === workspaceId).map(([, run]) => run),
  };
}

// A missing file owes nothing. A damaged one is set aside, as the notice
// store does, so it does not stop every later notice.
async function read(path: string): Promise<Owed> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      Array.isArray(value) &&
      value.every((entry) =>
        Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"))
    ) {
      return value as Owed;
    }
  } catch {
    // Set aside below.
  }
  await rename(path, `${path}.damaged`);
  return [];
}

async function write(path: string, owed: Owed, fileOperations?: DurableFileOperations): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(owed), fileOperations);
}
