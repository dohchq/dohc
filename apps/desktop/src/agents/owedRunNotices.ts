import { mkdir, readFile, rename } from "node:fs/promises";
import { atomicWriteFile, type DurableFileOperations } from "../atomicReplaceFile";
import { dirname } from "node:path";

// The agent runs whose notice is owed: each is added before the run's end
// is saved and removed once the notice for how it ended is posted.
// The file lets recovery find runs whose notices have not been posted.
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
  let writes: Promise<unknown> = Promise.resolve();
  const load = () => (loaded ??= read(path()).catch((error: unknown) => {
    loaded = null;
    throw error;
  }));
  // Memory changes after a successful save. A failed replacement clears
  // the cache because the rename may have succeeded before directory sync failed.
  const change = (update: (owed: Owed) => Owed | null): Promise<void> => {
    const next = writes.then(async () => {
      const owed = await load();
      const changed = update(owed);
      if (changed === null) return;
      const destination = path();
      await mkdir(dirname(destination), { recursive: true });
      try {
        await atomicWriteFile(destination, JSON.stringify(changed), fileOperations);
      } catch (error) {
        loaded = null;
        throw error;
      }
      owed.splice(0, owed.length, ...changed);
    });
    writes = next.catch(() => undefined);
    return next;
  };
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
