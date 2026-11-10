import { Directory, File, Paths } from "expo-file-system";

// The read cache's copy on disk, so that after a relaunch the phone shows what it read last while it reads again. Each
// scope, a server, account and workspace, has one file in the app's Caches folder, named for a hash of the scope so
// no name holds an account detail. The account's workspace list has one more, named for its server and account. iOS
// doesn't back up Caches and may empty it, which costs only a read.
//
// A file holds its format, the scope it was written for, and either each view's value, cursor and staleness, or the
// list. A file of another format or scope, one that doesn't parse, and one that can't be read count as absent, and
// are deleted.
//
// A scope's first write waits until it stops changing for WRITE_DELAY_MS, and at most WRITE_MAX_DELAY_MS after the
// first change. Later writes of it wait WRITE_INTERVAL_MS from the last, so a reply streaming into a chat costs one
// write every 30 s, not one per change. `flush`, when the app goes to the background, writes everything at once. Each
// write goes to a temporary file that then replaces the scope's file, so a read never finds half a file. A scope keeps
// the views that fit in SCOPE_MAX_BYTES, in the order given, and leaves out the rest without writing them out. The
// scopes' files together stay within TOTAL_MAX_BYTES: the scopes used least recently go first. Writes and deletes run
// one at a time, in order, so a delete lands after any write it raced, and no file comes back after a sign-out. A
// write that fails is dropped without a word: the next change writes again.

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
  /** Deletes every scope's file but those of `scopes`, and drops the others' writes that haven't landed. */
  keep(scopes: readonly string[]): Promise<void>;
  /** The workspace list last saved for the account `scope`, unchecked, or null. It never rejects. */
  readList(scope: string): Promise<unknown>;
  /** Saves the account's workspace list now. */
  writeList(scope: string, workspaces: unknown): Promise<void>;
}

/** Raise it when a file's layout, or the shape of a view's value, changes: older files are then deleted unread. */
export const CACHE_FORMAT = 1;
export const WRITE_DELAY_MS = 1000;
export const WRITE_MAX_DELAY_MS = 5000;
export const WRITE_INTERVAL_MS = 30_000;
export const SCOPE_MAX_BYTES = 10 * 1024 * 1024;
export const TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export const CACHE_FOLDER = "dohc-read-cache";

/** A scope's views are in `<name>.json`, an account's list in `<name>.list`, and either's next copy in `.tmp`. */
const VIEWS = ".json";
const LIST = ".list";

interface Waiting {
  readonly views: () => readonly SavedView[];
  readonly first: number;
  readonly due: number;
}

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
  const bump = (scope: string) => void removals.set(scope, (removals.get(scope) ?? 0) + 1);

  /** When each file was last written or read, by name, this run. Other files go by when they were last written. */
  const used = new Map<string, number>();
  /** When each scope's last write began, this run. */
  const written = new Map<string, number>();
  const pending = new Map<string, Waiting>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  let queue: Promise<void> = Promise.resolve();
  function serial(run: () => Promise<void> | void): Promise<void> {
    queue = queue.then(run).catch(() => undefined);
    return queue;
  }

  const fileOf = (name: string, extension: string) => new File(folder, `${name}${extension}`);

  function deleteFile(name: string, extension: string) {
    const file = fileOf(name, extension);
    if (file.exists) file.delete();
  }

  /** Writes `text` beside the file, then puts it in the file's place, unless the scope was deleted meanwhile. */
  async function replace(scope: string, extension: string, text: string, expected: string): Promise<boolean> {
    const name = fileName(scope);
    const temp = fileOf(name, `${extension}.tmp`);
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      await temp.write(text);
      if (version(scope) !== expected) {
        temp.delete();
        return false;
      }
      await temp.move(fileOf(name, extension), { overwrite: true });
      return true;
    } catch {
      try { if (temp.exists) temp.delete(); } catch { /* the next batch deletes it */ }
      return false;
    }
  }

  /** The file's content for `scope`, picked out by `pick`, or null. A file that isn't one is deleted. */
  async function readFile<T>(scope: string, extension: string, pick: (data: Record<string, unknown>) => T | null): Promise<T | null> {
    const expected = version(scope);
    const name = fileName(scope);
    let found: T | null = null;
    try {
      const file = fileOf(name, extension);
      if (!file.exists) return null;
      const data = parseFile(await file.text(), scope);
      found = data && pick(data);
    } catch {
      found = null;
    }
    if (version(scope) !== expected) return null;
    if (found === null) void serial(() => deleteFile(name, extension));
    return found;
  }

  /** Deletes temporary files a closed app left, then the least recently used scopes past the cap. */
  function trim() {
    if (!folder.exists) return;
    const saved: { file: File; size: number; usedAt: number }[] = [];
    for (const item of folder.list()) {
      if (!(item instanceof File)) continue;
      if (item.name.endsWith(".tmp")) item.delete();
      else if (item.name.endsWith(VIEWS)) {
        saved.push({ file: item, size: item.size, usedAt: used.get(item.name.slice(0, -VIEWS.length)) ?? item.modificationTime ?? 0 });
      }
    }
    let total = saved.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of saved.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= totalMaxBytes) break;
      entry.file.delete();
      used.delete(entry.file.name.slice(0, -VIEWS.length));
      total -= entry.size;
    }
  }

  /** Sets the timer for the next scope that's due. */
  function arm() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;
    const next = Math.min(...[...pending.values()].map(waiting => waiting.due));
    timer = setTimeout(() => void save(false), Math.max(0, next - now()));
  }

  /** Writes every waiting scope, or only those due. */
  function save(everything: boolean): Promise<void> {
    const at = now();
    const batch: { scope: string; views: () => readonly SavedView[]; expected: string }[] = [];
    for (const [scope, waiting] of pending) {
      if (!everything && waiting.due > at) continue;
      pending.delete(scope);
      written.set(scope, at);
      batch.push({ scope, views: waiting.views, expected: version(scope) });
    }
    arm();
    if (batch.length === 0) return queue;
    return serial(async () => {
      for (const job of batch) {
        if (version(job.scope) !== job.expected) continue;
        if (await replace(job.scope, VIEWS, serialize(job.scope, job.views(), scopeMaxBytes), job.expected)) used.set(fileName(job.scope), now());
      }
      trim();
    });
  }

  return {
    async read(scope) {
      const views = await readFile(scope, VIEWS, data => Array.isArray(data.views) ? savedViews(data.views) : null);
      if (views) used.set(fileName(scope), now());
      return views ?? [];
    },

    write(scope, views) {
      const at = now();
      const first = pending.get(scope)?.first ?? at;
      const quiet = Math.min(at + WRITE_DELAY_MS, first + WRITE_MAX_DELAY_MS);
      pending.set(scope, { views, first, due: Math.max(quiet, (written.get(scope) ?? -Infinity) + WRITE_INTERVAL_MS) });
      arm();
    },

    flush: () => save(true),

    remove(scope) {
      bump(scope);
      pending.delete(scope);
      written.delete(scope);
      arm();
      const name = fileName(scope);
      used.delete(name);
      return serial(() => deleteFile(name, VIEWS));
    },

    removeAll() {
      epoch += 1;
      pending.clear();
      written.clear();
      used.clear();
      arm();
      return serial(() => {
        if (folder.exists) folder.delete();
      });
    },

    keep(scopes) {
      const kept = new Set(scopes.map(fileName));
      for (const scope of [...pending.keys()]) {
        if (kept.has(fileName(scope))) continue;
        bump(scope);
        pending.delete(scope);
      }
      arm();
      return serial(() => {
        if (!folder.exists) return;
        for (const item of folder.list()) {
          if (!(item instanceof File) || !item.name.endsWith(VIEWS)) continue;
          const name = item.name.slice(0, -VIEWS.length);
          if (kept.has(name)) continue;
          item.delete();
          used.delete(name);
        }
      });
    },

    readList: scope => readFile(scope, LIST, data => data.workspaces ?? null),

    writeList(scope, workspaces) {
      const expected = version(scope);
      return serial(async () => {
        if (version(scope) !== expected) return;
        await replace(scope, LIST, JSON.stringify({ format: CACHE_FORMAT, scope, workspaces }), expected);
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

/**
 * The scope's file, with each view that still fits under `maxBytes` in UTF-8, in the order given. A view whose
 * smallest possible size is already past what's left is left out before any of it is written out, so one too large
 * for the cap, such as a long chat, costs a walk over its fields, never a copy of its text.
 */
function serialize(scope: string, views: readonly SavedView[], maxBytes: number): string {
  const head = `{"format":${CACHE_FORMAT},"scope":${JSON.stringify(scope)},"views":[`;
  let bytes = utf8Bytes(head) + 2;
  const parts: string[] = [];
  for (const view of views) {
    const left = maxBytes - bytes - (parts.length > 0 ? 1 : 0);
    if (left <= 0) break;
    const saved = { id: view.id, value: view.value, cursor: view.cursor, stale: view.stale };
    if (leastJsonBytes(saved, left) > left) continue;
    const part = JSON.stringify(saved);
    const size = utf8Bytes(part);
    if (size > left) continue;
    parts.push(part);
    bytes += size + (parts.length > 1 ? 1 : 0);
  }
  return `${head}${parts.join(",")}]}`;
}

/**
 * At most the UTF-8 length of `value` as JSON, counted only until it passes `limit`. A string counts its UTF-16
 * length, which UTF-8 and escaping only add to, plus its quotes; every other mark counts one byte.
 */
export function leastJsonBytes(value: unknown, limit: number): number {
  let total = 0;
  const walk = (item: unknown): void => {
    if (total > limit) return;
    if (typeof item === "string") {
      total += item.length + 2;
    } else if (Array.isArray(item)) {
      total += item.length + 1;
      for (const entry of item) walk(entry);
    } else if (typeof item === "object" && item !== null) {
      const fields = Object.entries(item).filter(([, entry]) => entry !== undefined);
      total += fields.length + 1;
      for (const [key, entry] of fields) {
        total += key.length + 3;
        walk(entry);
      }
    } else {
      total += 1;
    }
  };
  walk(value);
  return total;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A file's fields when it is of this format and for `scope`, or null. */
function parseFile(text: string, scope: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(data) && data.format === CACHE_FORMAT && data.scope === scope ? data : null;
}

function savedViews(items: readonly unknown[]): readonly SavedView[] | null {
  const views: SavedView[] = [];
  for (const item of items) {
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
