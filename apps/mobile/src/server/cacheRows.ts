import type { CacheStore, Sql } from "./keptStore";

// The read cache's rows in cache.db (keptStore.ts): one row of views per workspace scope, and one workspace list per
// account. Each scope's views are kept under SCOPE_MAX_BYTES, and all scopes' under TOTAL_MAX_BYTES, by deleting the
// scopes used least recently. Both caps count the views' JSON, not the file. Nothing here rejects: a cache that can't
// be read or written answers as empty.

/** One view as a scope's row keeps it. */
export interface SavedView {
  readonly id: string;
  readonly value: unknown;
  readonly cursor: string;
  readonly stale: boolean;
}

export interface CacheRows {
  /** The scope's saved views, or none. */
  read(scope: string): Promise<readonly SavedView[]>;
  /** Saves the scope soon, with the views `views` answers then. */
  write(scope: string, views: () => readonly SavedView[]): void;
  /** Saves now every scope that waits to be saved. */
  flush(): Promise<void>;
  /** Deletes the scope's views, and drops a write of them that hasn't landed. */
  remove(scope: string): Promise<void>;
  /** Deletes cache.db, and drops every write that hasn't landed. */
  removeAll(): Promise<void>;
  /** Deletes every scope's views but those of `scopes`, and drops the others' writes that haven't landed. */
  keep(scopes: readonly string[]): Promise<void>;
  /** The workspace list last saved for the account `scope`, unchecked, or null. */
  readList(scope: string): Promise<unknown>;
  /** Saves the account's workspace list now. */
  writeList(scope: string, workspaces: unknown): Promise<void>;
}

export const WRITE_DELAY_MS = 1000;
export const WRITE_MAX_DELAY_MS = 5000;
export const WRITE_INTERVAL_MS = 30_000;
export const SCOPE_MAX_BYTES = 10 * 1024 * 1024;
export const TOTAL_MAX_BYTES = 25 * 1024 * 1024;

interface Waiting {
  readonly views: () => readonly SavedView[];
  readonly first: number;
  readonly due: number;
}

export function createCacheRows(
  store: CacheStore,
  options: {
    readonly scopeMaxBytes?: number;
    readonly totalMaxBytes?: number;
    readonly now?: () => number;
  } = {},
): CacheRows {
  const scopeMaxBytes = options.scopeMaxBytes ?? SCOPE_MAX_BYTES;
  const totalMaxBytes = options.totalMaxBytes ?? TOTAL_MAX_BYTES;
  const now = options.now ?? Date.now;
  /** When each scope's last write began, this run. */
  const written = new Map<string, number>();
  const pending = new Map<string, Waiting>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** The last change asked for, which settles after every one before it. */
  let last: Promise<void> = Promise.resolve();
  const change = (body: (sql: Sql) => Promise<unknown>) =>
    (last = store.transaction(body).then(
      () => undefined,
      () => undefined,
    ));

  /** Keeps the scopes used most recently whose views fit under the total cap, and deletes the rest. */
  async function trim(sql: Sql) {
    let total = 0;
    for (const row of await sql.all("SELECT scope, bytes FROM views ORDER BY used_at DESC", [])) {
      total += Number(row.bytes);
      if (total > totalMaxBytes)
        await sql.run("DELETE FROM views WHERE scope = ?", [String(row.scope)]);
    }
  }

  /** Sets the timer for the next scope that's due. */
  function arm() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;
    const next = Math.min(...[...pending.values()].map((waiting) => waiting.due));
    timer = setTimeout(() => void save(false), Math.max(0, next - now()));
  }

  function save(everything: boolean): Promise<void> {
    const at = now();
    const batch: { scope: string; views: () => readonly SavedView[] }[] = [];
    for (const [scope, waiting] of pending) {
      if (!everything && waiting.due > at) continue;
      pending.delete(scope);
      written.set(scope, at);
      batch.push({ scope, views: waiting.views });
    }
    arm();
    // A batch of none waits behind the changes before it, without opening cache.db.
    if (batch.length === 0) return last;
    return change(async (sql) => {
      for (const job of batch) {
        const { text, bytes } = serialize(job.views(), scopeMaxBytes);
        await sql.run(
          `INSERT INTO views (scope, value, bytes, used_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, used_at = excluded.used_at`,
          [job.scope, text, bytes, now()],
        );
      }
      await trim(sql);
    });
  }

  return {
    async read(scope) {
      try {
        return await store.transaction(async (sql) => {
          const [row] = await sql.all("SELECT value FROM views WHERE scope = ?", [scope]);
          if (!row) return [];
          const views = savedViews(row.value);
          if (views) await sql.run("UPDATE views SET used_at = ? WHERE scope = ?", [now(), scope]);
          else await sql.run("DELETE FROM views WHERE scope = ?", [scope]);
          return views ?? [];
        });
      } catch {
        return [];
      }
    },

    write(scope, views) {
      const at = now();
      const first = pending.get(scope)?.first ?? at;
      const quiet = Math.min(at + WRITE_DELAY_MS, first + WRITE_MAX_DELAY_MS);
      pending.set(scope, {
        views,
        first,
        due: Math.max(quiet, (written.get(scope) ?? -Infinity) + WRITE_INTERVAL_MS),
      });
      arm();
    },

    flush: () => save(true),

    remove(scope) {
      pending.delete(scope);
      written.delete(scope);
      arm();
      return change((sql) => sql.run("DELETE FROM views WHERE scope = ?", [scope]));
    },

    removeAll() {
      pending.clear();
      written.clear();
      arm();
      return (last = store.destroy().catch(() => undefined));
    },

    keep(scopes) {
      for (const scope of [...pending.keys()]) if (!scopes.includes(scope)) pending.delete(scope);
      arm();
      return change((sql) =>
        sql.run("DELETE FROM views WHERE scope NOT IN (SELECT value FROM json_each(?))", [
          JSON.stringify(scopes),
        ]),
      );
    },

    readList: (scope) =>
      store.read("SELECT value FROM lists WHERE scope = ?", [scope]).then(
        ([row]) => parsed(row?.value),
        () => null,
      ),

    writeList: (scope, workspaces) =>
      change((sql) =>
        sql.run(
          "INSERT INTO lists (scope, value) VALUES (?, ?) ON CONFLICT (scope) DO UPDATE SET value = excluded.value",
          [scope, JSON.stringify(workspaces)],
        ),
      ),
  };
}

function parsed(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The views as JSON, with each view that still fits under `maxBytes` in UTF-8, in the order given. A view whose
 * smallest possible size is already past what's left is left out before any of it is written out, so one too large
 * for the cap, such as a long chat, costs a walk over its fields, never a copy of its text.
 */
function serialize(views: readonly SavedView[], maxBytes: number) {
  let bytes = 2;
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
  return { text: `[${parts.join(",")}]`, bytes };
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function savedViews(text: unknown): readonly SavedView[] | null {
  const items = parsed(text);
  if (!Array.isArray(items)) return null;
  const views: SavedView[] = [];
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.cursor !== "string" ||
      typeof item.stale !== "boolean" ||
      item.value === undefined ||
      item.value === null
    )
      return null;
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
