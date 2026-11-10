import { Directory, File, Paths } from "expo-file-system";

// The read cache's copy on disk, so that after a relaunch the phone shows what it read last while it reads again. Each
// scope, a server, account and workspace, has one file in the app's Caches folder, named for a hash of the scope so
// no name holds an account detail. iOS doesn't back up Caches and may empty it, which costs only a read.
//
// A file holds its format, the scope it was written for, and each view's value, cursor and staleness. A file of
// another format or scope, one that doesn't parse, and one that can't be read count as absent, and are deleted.
//
// A write waits until the scopes stop changing for WRITE_DELAY_MS, and at most WRITE_MAX_DELAY_MS after the first
// change, then saves every changed scope. Each goes to a temporary file that then replaces the scope's file, so a read
// never finds half a file. A scope keeps the views that fit in SCOPE_MAX_BYTES and leaves out the rest. The files
// together stay within TOTAL_MAX_BYTES: the scopes used least recently go first. Writes and deletes run one at a
// time, in order, so a delete lands after any write it raced, and no file comes back after a sign-out. A write that
// fails is dropped without a word: the next change writes again.

/** One view as a scope's file keeps it. */
export interface SavedView {
  readonly id: string;
  readonly value: unknown;
  readonly cursor: string;
  readonly stale: boolean;
}

export interface CacheFiles {
  /** The scope's saved views, or none. It never rejects. */
  read(scope: string): Promise<readonly SavedView[]>;
  /** Saves the scope soon, with the views `views` answers then. */
  write(scope: string, views: () => readonly SavedView[]): void;
  /** Saves now every scope that waits to be saved. */
  flush(): Promise<void>;
  /** Deletes the scope's file, and drops a write of it that hasn't landed. */
  remove(scope: string): Promise<void>;
  /** Deletes every file, and drops every write that hasn't landed. */
  removeAll(): Promise<void>;
}

/** Raise it when a file's layout, or the shape of a view's value, changes: older files are then deleted unread. */
export const CACHE_FORMAT = 1;
export const WRITE_DELAY_MS = 1000;
export const WRITE_MAX_DELAY_MS = 5000;
export const SCOPE_MAX_BYTES = 10 * 1024 * 1024;
export const TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export const CACHE_FOLDER = "dohc-read-cache";

export function createCacheFiles(options: {
  readonly folder?: Directory;
  readonly scopeMaxBytes?: number;
  readonly totalMaxBytes?: number;
  readonly now?: () => number;
} = {}): CacheFiles {
  const folder = options.folder ?? new Directory(Paths.cache, CACHE_FOLDER);
  const scopeMaxBytes = options.scopeMaxBytes ?? SCOPE_MAX_BYTES;
  const totalMaxBytes = options.totalMaxBytes ?? TOTAL_MAX_BYTES;
  const now = options.now ?? Date.now;

  // A delete moves a scope's version on, so a read or write that began before it lands nothing.
  let epoch = 0;
  const removals = new Map<string, number>();
  const version = (scope: string) => `${epoch}.${removals.get(scope) ?? 0}`;

  /** When each file was last written or read, by name, this run. Other files go by when they were last written. */
  const used = new Map<string, number>();
  const pending = new Map<string, () => readonly SavedView[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstChange: number | null = null;

  let queue: Promise<void> = Promise.resolve();
  function serial(run: () => Promise<void> | void): Promise<void> {
    queue = queue.then(run).catch(() => undefined);
    return queue;
  }

  const fileOf = (name: string, extension: "json" | "tmp") => new File(folder, `${name}.${extension}`);

  function deleteFile(name: string) {
    const file = fileOf(name, "json");
    if (file.exists) file.delete();
  }

  async function save(scope: string, views: () => readonly SavedView[], expected: string) {
    if (version(scope) !== expected) return;
    const name = fileName(scope);
    const text = serialize(scope, views(), scopeMaxBytes);
    const temp = fileOf(name, "tmp");
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      await temp.write(text);
      if (version(scope) !== expected) return temp.delete();
      await temp.move(fileOf(name, "json"), { overwrite: true });
      used.set(name, now());
    } catch {
      try { if (temp.exists) temp.delete(); } catch { /* the next batch deletes it */ }
    }
  }

  /** Deletes temporary files a closed app left, then the least recently used scopes past the cap. */
  function trim() {
    if (!folder.exists) return;
    const saved: { file: File; size: number; usedAt: number }[] = [];
    for (const item of folder.list()) {
      if (!(item instanceof File)) continue;
      if (!item.name.endsWith(".json")) {
        item.delete();
        continue;
      }
      saved.push({ file: item, size: item.size, usedAt: used.get(item.name.slice(0, -".json".length)) ?? item.modificationTime ?? 0 });
    }
    let total = saved.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of saved.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= totalMaxBytes) break;
      entry.file.delete();
      used.delete(entry.file.name.slice(0, -".json".length));
      total -= entry.size;
    }
  }

  function flush(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    firstChange = null;
    const batch = [...pending].map(([scope, views]) => ({ scope, views, expected: version(scope) }));
    pending.clear();
    if (batch.length === 0) return queue;
    return serial(async () => {
      for (const job of batch) await save(job.scope, job.views, job.expected);
      trim();
    });
  }

  return {
    async read(scope) {
      const expected = version(scope);
      const name = fileName(scope);
      let saved: readonly SavedView[] | null = null;
      try {
        const file = fileOf(name, "json");
        if (!file.exists) return [];
        saved = parse(await file.text(), scope);
      } catch {
        saved = null;
      }
      if (version(scope) !== expected) return [];
      if (saved === null) {
        void serial(() => deleteFile(name));
        return [];
      }
      used.set(name, now());
      return saved;
    },

    write(scope, views) {
      pending.set(scope, views);
      const at = now();
      firstChange ??= at;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush(), Math.max(0, Math.min(WRITE_DELAY_MS, firstChange + WRITE_MAX_DELAY_MS - at)));
    },

    flush,

    remove(scope) {
      removals.set(scope, (removals.get(scope) ?? 0) + 1);
      pending.delete(scope);
      const name = fileName(scope);
      used.delete(name);
      return serial(() => deleteFile(name));
    },

    removeAll() {
      epoch += 1;
      pending.clear();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstChange = null;
      used.clear();
      return serial(() => {
        if (folder.exists) folder.delete();
      });
    },
  };
}

/** The scope's file name: 64 bits of cyrb53's hash, the same on every run. Two scopes that share one overwrite each
 * other's file, and each read checks the scope inside. */
export function fileName(scope: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < scope.length; i++) {
    const code = scope.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The scope's file, with each view that still fits under `maxBytes` in UTF-8, in the order given. */
function serialize(scope: string, views: readonly SavedView[], maxBytes: number): string {
  const head = `{"format":${CACHE_FORMAT},"scope":${JSON.stringify(scope)},"views":[`;
  let bytes = utf8Bytes(head) + 2;
  const parts: string[] = [];
  for (const view of views) {
    const part = JSON.stringify({ id: view.id, value: view.value, cursor: view.cursor, stale: view.stale });
    const size = utf8Bytes(part) + (parts.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) continue;
    parts.push(part);
    bytes += size;
  }
  return `${head}${parts.join(",")}]}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The views a file holds for `scope`, or null when it's of another format or scope, or isn't a file this wrote. */
function parse(text: string, scope: string): readonly SavedView[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== CACHE_FORMAT || data.scope !== scope || !Array.isArray(data.views)) return null;
  const views: SavedView[] = [];
  for (const item of data.views as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.cursor !== "string" || typeof item.stale !== "boolean" ||
      item.value === undefined || item.value === null) return null;
    views.push({ id: item.id, value: item.value, cursor: item.cursor, stale: item.stale });
  }
  return views;
}

function utf8Bytes(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Two bytes for U+0080 to U+07FF, three to U+FFFF, and four for a surrogate pair, two for each half.
    if (code >= 0x80) bytes += code < 0x800 || (code >= 0xd800 && code <= 0xdfff) ? 1 : 2;
  }
  return bytes;
}
