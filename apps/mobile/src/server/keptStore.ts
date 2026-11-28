// The phone's two SQLite files. kept.db holds work it must not lose; cache.db, in Caches, holds read copies it may
// throw away. Each file's statements run on one connection through its own queue, so none joins another's transaction
// and a cache save never waits on a Send; don't use expo-sqlite's transaction helpers, which open a connection without
// the settings. Each open sets those settings and refuses to open unless each reads back as set. Nothing here replaces
// a damaged kept.db. A damaged cache.db, or one of another format, is deleted and starts empty.

export type SqlValue = string | number | null;
export type Row = Readonly<Record<string, unknown>>;

/** One connection to the file, as expo-sqlite or, in tests, node:sqlite gives it. */
export interface SqlConnection {
  exec(source: string): Promise<void>;
  run(source: string, params: readonly SqlValue[]): Promise<void>;
  all(source: string, params: readonly SqlValue[]): Promise<readonly Row[]>;
  close(): Promise<void>;
}

/** What a transaction's body runs its statements on. */
export type Sql = Pick<SqlConnection, "run" | "all">;

/**
 * `locked`: the phone hasn't been unlocked since it started, so the file can't open yet. `damaged`: SQLite reports the
 * file corrupt or not a database. `refused`: a durability setting didn't read back as set. `failed`: anything else, and
 * nothing was written. `uncertain`: the COMMIT itself failed, whatever SQLite said, and what it wrote may still stand.
 */
export class StoreError extends Error {
  constructor(
    readonly kind: "locked" | "damaged" | "refused" | "failed" | "uncertain",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface KeptStore {
  read(source: string, params: readonly SqlValue[]): Promise<readonly Row[]>;
  /** Runs `body` in one transaction, after every call made before it, and resolves once its commit is flushed. */
  transaction<T>(body: (sql: Sql) => Promise<T>): Promise<T>;
  /** Copies every commit into kept.db and empties its WAL, whose older frames still hold deleted rows' text. */
  checkpoint(): Promise<void>;
  /** Closes the file and deletes it with its journal. Only for a damaged file, once the person has been warned. */
  destroy(): Promise<void>;
}

/** cache.db's store: it needs no checkpoint, since deleting it is how its rows go. */
export type CacheStore = Omit<KeptStore, "checkpoint">;

export const KEPT_FILE = "kept.db";
export const CACHE_FILE = "cache.db";

/**
 * `outbox`: the outbox's writes, one row each. AUTOINCREMENT never gives a committed sequence again, even once its row
 * is deleted, but a rolled-back insert's sequence comes back: the outbox allocates past any it still holds in memory.
 * `notice_lists`: each account's last whole Notice list, as JSON. `notice_marks`: its marks the server hasn't taken,
 * in the order they were made, each with the key the phone made for it, so a retried insert finds its row.
 */
export const KEPT_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS notice_lists (
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  rows TEXT NOT NULL,
  PRIMARY KEY (origin, account_id)
) STRICT;
CREATE TABLE IF NOT EXISTS notice_marks (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  mark TEXT NOT NULL,
  at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS push_registrations (
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  alerts INTEGER NOT NULL,
  generation INTEGER,
  signing_out INTEGER NOT NULL,
  PRIMARY KEY (origin, account_id)
) STRICT`;

/** Raise it when a table's layout, or the shape of a view's value, changes: an older cache.db is then deleted unread. */
export const CACHE_FORMAT = 5;

/** `views`: each workspace's saved views, as JSON, and their size. `lists`: each account's workspace list. */
export const CACHE_SCHEMA = `CREATE TABLE IF NOT EXISTS views (
  scope TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  used_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS lists (scope TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`;

/** Deletes every row kept.db holds for the account, in the caller's transaction. Sign out runs it in one commit. */
export async function deleteAccountRows(sql: Sql, account: { origin: string; userId: string }) {
  for (const table of ["outbox", "notice_lists", "notice_marks"])
    await sql.run(`DELETE FROM ${table} WHERE origin = ? AND account_id = ?`, [
      account.origin,
      account.userId,
    ]);
}

export async function openNow(stores: readonly Pick<KeptStore, "read">[]): Promise<boolean> {
  const opened = await Promise.allSettled(stores.map((store) => store.read("SELECT 1", [])));
  return opened.every((open) => open.status === "fulfilled");
}

type Setting = readonly [name: string, value: string, readBack: string | number];

/** Each setting, the value it's set to, and what reading it back must give. */
const KEPT_SETTINGS: readonly Setting[] = [
  ["journal_mode", "WAL", "wal"],
  ["synchronous", "FULL", 2],
  ["fullfsync", "ON", 1],
  ["checkpoint_fullfsync", "ON", 1],
  ["secure_delete", "ON", 1],
  ["busy_timeout", "5000", 5000],
];

/** The cache needs no flush per commit: a close may lose its last saves, never its file. */
const CACHE_SETTINGS: readonly Setting[] = [
  ["journal_mode", "WAL", "wal"],
  ["synchronous", "NORMAL", 1],
  ["busy_timeout", "5000", 5000],
];

/** The durable-file module's code for a phone not unlocked since it started. */
const LOCKED = "ERR_DURABLE_LOCKED";
const DAMAGED = /database disk image is malformed|file is not a database/;
const CHECKPOINT = "PRAGMA wal_checkpoint(TRUNCATE)";

function classify(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === LOCKED) return new StoreError("locked", message);
  return new StoreError(DAMAGED.test(message) ? "damaged" : "failed", message);
}

export interface StoreFile {
  /** Prepares the folder and opens the file, rejecting with the durable-file module's code while locked. */
  open(): Promise<SqlConnection>;
  /** Deletes the closed file and its journal. */
  remove(): Promise<void>;
}

export const createKeptStore = (file: StoreFile): KeptStore =>
  createStore(file, KEPT_FILE, KEPT_SETTINGS, KEPT_SCHEMA, null);

/** cache.db: a damaged file, or one of another format, is deleted, and the next call starts it empty. */
export const createCacheStore = (file: StoreFile): CacheStore =>
  createStore(file, CACHE_FILE, CACHE_SETTINGS, CACHE_SCHEMA, CACHE_FORMAT);

function createStore(
  file: StoreFile,
  name: string,
  settings: readonly Setting[],
  schema: string,
  /** The disposable file's format, or null for a file nothing replaces. */
  format: number | null,
): KeptStore {
  let connection: SqlConnection | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  async function setUp(): Promise<SqlConnection> {
    let opened: SqlConnection | null = null;
    try {
      opened = await file.open();
      for (const [setting, value] of settings) await opened.exec(`PRAGMA ${setting} = ${value}`);
      for (const [setting, value, expected] of settings) {
        const [row] = await opened.all(`PRAGMA ${setting}`, []);
        if (!row || Object.values(row)[0] !== expected)
          throw new StoreError("refused", `${name} didn't take ${setting} = ${value}.`);
      }
      if (format !== null) {
        const [row] = await opened.all("PRAGMA user_version", []);
        const found = row?.user_version;
        if (found !== 0 && found !== format)
          throw new StoreError("damaged", `${name} is of another format.`);
        await opened.exec(`PRAGMA user_version = ${format}`);
      }
      await opened.exec(schema);
      // A Sign out whose own checkpoint failed, or the app closing after it, can leave deleted text in the WAL.
      await opened.all(CHECKPOINT, []).catch(() => undefined);
    } catch (error) {
      await opened?.close().catch(() => undefined);
      throw classify(error);
    }
    return opened;
  }

  /** The open connection, or a new one, set up. A failed open is tried again by the next call. */
  async function connect(): Promise<SqlConnection> {
    if (connection) return connection;
    try {
      connection = await setUp();
    } catch (error) {
      if (format === null || classify(error).kind !== "damaged") throw error;
      await file.remove().catch(() => undefined);
      connection = await setUp();
    }
    return connection;
  }

  /** The error to report. A damaged disposable file is closed and deleted, so the next call starts it empty. */
  async function failure(error: unknown): Promise<StoreError> {
    const failed = classify(error);
    if (format !== null && failed.kind === "damaged") {
      const open = connection;
      connection = null;
      await open?.close().catch(() => undefined);
      await file.remove().catch(() => undefined);
    }
    return failed;
  }

  /** Ends a failed transaction. A connection that can't roll back is closed, so the next call opens a fresh one. */
  async function rollBack(open: SqlConnection) {
    try {
      await open.exec("ROLLBACK");
    } catch {
      connection = null;
      await open.close().catch(() => undefined);
    }
  }

  return {
    read: (source, params) =>
      serial(async () => {
        const open = await connect();
        return open.all(source, params).catch(async (error: unknown) => {
          throw await failure(error);
        });
      }),

    transaction: (body) =>
      serial(async () => {
        const open = await connect();
        let result;
        try {
          await open.exec("BEGIN IMMEDIATE");
          result = await body(open);
        } catch (error) {
          await rollBack(open);
          throw await failure(error);
        }
        try {
          await open.exec("COMMIT");
        } catch (error) {
          await rollBack(open);
          throw new StoreError("uncertain", classify(error).message);
        }
        return result;
      }),

    checkpoint: () =>
      serial(async () => {
        const open = await connect();
        const [row] = await open.all(CHECKPOINT, []).catch((error: unknown) => {
          throw classify(error);
        });
        // SQLite reports a checkpoint it couldn't finish in its answer, not as an error.
        if (row?.busy !== 0) throw new StoreError("failed", `${name}'s WAL wasn't emptied.`);
      }),

    destroy: () =>
      serial(async () => {
        const open = connection;
        connection = null;
        await open?.close().catch(() => undefined);
        await file.remove();
      }),
  };
}
