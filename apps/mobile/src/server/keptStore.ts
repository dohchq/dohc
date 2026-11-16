// kept.db: the phone's one SQLite file for work it must not lose, such as unsent chat writes. There is one per
// install, never one per sign-in, and each row carries its server and account. It lives in a folder the durable-file
// module prepares (keptDatabase.ts): never backed up, and closed until the phone's first unlock after a restart.
//
// Every statement runs on one connection, through one queue, so no statement can join another's transaction. A write
// is one `BEGIN IMMEDIATE` … `COMMIT`. expo-sqlite's transaction helpers aren't used: its exclusive one opens another
// connection with a plain `BEGIN`, and that connection loses `fullfsync` and `secure_delete`.
//
// Each open sets the durability settings, which belong to the connection, then reads each back. One that doesn't read
// back as set refuses the open: a store that can't promise the flush must never say it kept anything. Nothing here
// replaces a damaged file. Only `destroy`, after the person has seen a warning, deletes it.

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
 * nothing was written. `uncertain`: the commit failed, and what it wrote may still stand.
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
  /** Closes the file and deletes it with its journal. Only for a damaged file, once the person has been warned. */
  destroy(): Promise<void>;
}

export const KEPT_FILE = "kept.db";

/** The outbox's writes, one row each. `sequence` is never reused, so order survives deletes and relaunches. */
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
          const failure = classify(error);
          throw failure.kind === "failed" ? new StoreError("uncertain", failure.message) : failure;
        }
        return result;
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
