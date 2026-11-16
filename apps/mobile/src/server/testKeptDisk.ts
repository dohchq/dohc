import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { onTestFinished } from "vitest";
import {
  createKeptStore,
  KEPT_FILE,
  KEPT_SCHEMA,
  type KeptStore,
  type Row,
  type SqlConnection,
  type SqlValue,
} from "./keptStore";

// kept.db on Node's built-in SQLite, for tests: real SQL in a real file. Each launch opens its own connection to one
// file, as each run of the app opens the phone's. `crash` ends every launch made so far, as the app closing would: its
// connection closes, which rolls back a transaction it held open, and nothing the ended launches started ever settles.

const ioError = () => Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" });
const never = <T>() => new Promise<T>(() => undefined);

export interface KeptDisk {
  readonly path: string;
  /** Fails each write statement that matches, so its transaction rolls back. */
  failWrites: RegExp | null;
  /**
   * Fails each COMMIT whose transaction ran a statement that matches, as a failed flush does: after rolling back, or,
   * when it `lands`, after committing.
   */
  failCommits: { readonly match: RegExp; readonly lands: boolean } | null;
  /** As the durable-file module on a phone not unlocked since it started: opening rejects. */
  locked: boolean;
  /** Settings this disk's SQLite lacks: setting one does nothing, and reading it back gives no row. */
  readonly ignored: Set<string>;
  /** Holds every COMMIT until the returned function runs or the app crashes. */
  holdCommits(): () => void;
  /** How many COMMITs the hold is holding. */
  waiting(): number;
  crash(): void;
  /** Runs SQL on its own connection, as an earlier build left the file. */
  sql(source: string, ...params: SqlValue[]): Row[];
  /** The outbox's rows' sequences, in order. */
  rows(): number[];
  /** A row's record, parsed. */
  record(sequence: number): unknown;
  /** One run of the app's kept.db over this disk. */
  launch(): KeptStore;
}

export function keptDisk(): KeptDisk {
  const folder = mkdtempSync(join(tmpdir(), "kept-"));
  const path = join(folder, KEPT_FILE);
  const open = new Set<DatabaseSync>();
  let run = 0;
  let held: { readonly promise: Promise<void>; readonly release: () => void } | null = null;
  let waiting = 0;
  const release = () => {
    held?.release();
    held = null;
  };
  onTestFinished(() => {
    disk.crash();
    rmSync(folder, { recursive: true, force: true });
  });

  function connect(): SqlConnection {
    const mine = run;
    const database = new DatabaseSync(path);
    open.add(database);
    let statements: string[] = [];
    const call = <T>(body: () => T | Promise<T>): Promise<T> =>
      Promise.resolve().then(() => (mine !== run ? never<T>() : body()));
    const write = (source: string) => {
      if (/^\s*(SELECT|PRAGMA)/.test(source)) return;
      if (disk.failWrites?.test(source)) throw ioError();
      statements.push(source);
    };
    return {
      exec: (source) =>
        call(async () => {
          if (source === "BEGIN IMMEDIATE") statements = [];
          if (source !== "COMMIT") {
            const setting = /^PRAGMA (\w+) = /.exec(source)?.[1];
            if (setting === undefined || !disk.ignored.has(setting)) database.exec(source);
            return;
          }
          if (held) {
            waiting += 1;
            await held.promise;
            waiting -= 1;
            if (mine !== run) return never<void>();
          }
          const failing = disk.failCommits;
          const fails = failing !== null && statements.some((entry) => failing.match.test(entry));
          database.exec(fails && !failing.lands ? "ROLLBACK" : "COMMIT");
          if (fails) throw ioError();
        }),
      run: (source, params) =>
        call(() => {
          write(source);
          database.prepare(source).run(...params);
        }),
      all: (source, params) =>
        call(() => {
          // SQLite answers a setting its build lacks with no row.
          if (disk.ignored.has(/^PRAGMA (\w+)$/.exec(source)?.[1] ?? "")) return [];
          write(source);
          return database.prepare(source).all(...params);
        }),
      close: () =>
        call(() => {
          open.delete(database);
          database.close();
        }),
    };
  }

  const disk: KeptDisk = {
    path,
    failWrites: null,
    failCommits: null,
    locked: false,
    ignored: new Set(),
    holdCommits() {
      let done!: () => void;
      const hold = {
        promise: new Promise<void>((resolve) => (done = resolve)),
        release: () => done(),
      };
      held = hold;
      return () => {
        if (held === hold) release();
      };
    },
    waiting: () => waiting,
    crash() {
      run += 1;
      release();
      for (const database of open) database.close();
      open.clear();
    },
    sql(source, ...params) {
      const database = new DatabaseSync(path);
      try {
        database.exec(KEPT_SCHEMA);
        return database.prepare(source).all(...params);
      } finally {
        database.close();
      }
    },
    rows: () =>
      disk.sql("SELECT sequence FROM outbox ORDER BY sequence").map((row) => Number(row.sequence)),
    record(sequence) {
      const [row] = disk.sql("SELECT record FROM outbox WHERE sequence = ?", sequence);
      return typeof row?.record === "string" ? JSON.parse(row.record) : null;
    },
    launch: () =>
      createKeptStore({
        open: async () => {
          if (disk.locked)
            throw Object.assign(new Error("The phone hasn't been unlocked since it started."), {
              code: "ERR_DURABLE_LOCKED",
            });
          return connect();
        },
        remove: async () => {
          for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
        },
      }),
  };
  return disk;
}
