// kept.db, the phone's file for work it must not lose. Every statement runs on one connection through one queue, so
// none joins another's transaction; don't use expo-sqlite's transaction helpers, which open a connection without the
// durability settings. Each open sets those settings and refuses to open unless each reads back as set. Nothing here
// replaces a damaged file.

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

export const KEPT_FILE = "kept.db";

/**
 * The outbox's writes, one row each. AUTOINCREMENT never gives a committed sequence again, even once its row is
 * deleted, but a rolled-back insert's sequence comes back: the outbox allocates past any it still holds in memory.
 */
export const KEPT_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT`;

/** Each setting, the value it's set to, and what reading it back must give. */
const SETTINGS: readonly (readonly [string, string, string | number])[] = [
  ["journal_mode", "WAL", "wal"],
  ["synchronous", "FULL", 2],
  ["fullfsync", "ON", 1],
  ["checkpoint_fullfsync", "ON", 1],
  ["secure_delete", "ON", 1],
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

export function createKeptStore(file: {
  /** Prepares the folder and opens the file, rejecting with the durable-file module's code while locked. */
  open(): Promise<SqlConnection>;
  /** Deletes the closed file and its journal. */
  remove(): Promise<void>;
}): KeptStore {
  let connection: SqlConnection | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  /** The open connection, or a new one, set up. A failed open is tried again by the next call. */
  async function connect(): Promise<SqlConnection> {
    if (connection) return connection;
    let opened: SqlConnection | null = null;
    try {
      opened = await file.open();
      for (const [name, value] of SETTINGS) await opened.exec(`PRAGMA ${name} = ${value}`);
      for (const [name, value, expected] of SETTINGS) {
        const [row] = await opened.all(`PRAGMA ${name}`, []);
        if (!row || Object.values(row)[0] !== expected)
          throw new StoreError("refused", `kept.db didn't take ${name} = ${value}.`);
      }
      await opened.exec(KEPT_SCHEMA);
      // A Sign out whose own checkpoint failed, or the app closing after it, can leave deleted text in the WAL.
      await opened.all(CHECKPOINT, []).catch(() => undefined);
    } catch (error) {
      await opened?.close().catch(() => undefined);
      throw classify(error);
    }
    connection = opened;
    return opened;
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
        return open.all(source, params).catch((error: unknown) => {
          throw classify(error);
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
          throw classify(error);
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
        if (row?.busy !== 0) throw new StoreError("failed", "kept.db's WAL wasn't emptied.");
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
