import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// WS-G2-C-2 — the ONE source of truth for the e2e SQLite helpers that read the
// workspace engine.db. These are load-bearing for the "no double-journal"
// invariant (workspace-engine-editor.spec) and the decoupling proof
// (workspace-collab-decoupling.spec); keeping a single copy stops the two specs
// from drifting (e.g. one getting a schema fix the other misses).
const requireModule = createRequire(import.meta.url);

type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean },
) => {
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
};

const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: DatabaseSyncCtor;
};

export type EngineDb = InstanceType<DatabaseSyncCtor>;

export interface EngineMoment {
  path: string;
  operation: string;
  text: string;
}

// Only a database that cannot be OPENED reads as "not ready, poll again", and
// only by error CODE — never by matching message text, which is the rule the
// relay helper already follows.
//
// `node:sqlite` reports EVERY sqlite failure as `code: "ERR_SQLITE_ERROR"` and
// carries the real result code in `errcode`, so an absent engine.db arrives as
// SQLITE_CANTOPEN (14), NOT as ENOENT. ENOENT stays for a filesystem-level
// failure raised before sqlite sees the path.
const SQLITE_CANTOPEN = 14;

function isDbNotOpenable(error: unknown, dbOpened: boolean): boolean {
  if (dbOpened) return false;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true;
  return (error as { errcode?: unknown } | undefined)?.errcode === SQLITE_CANTOPEN;
}

// Every (table, column) this file reads.
const SCHEMA_READ_HERE: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "moments",
    [
      "path",
      "operation",
      "moment_order",
      "payload_after_blob_sha256",
      "payload_after_content_kind",
    ],
  ],
  ["blobs", ["sha256", "text"]],
  ["snapshots", ["path"]],
  ["ydoc_updates", []],
  ["replication_log", ["op_kind", "payload_json"]],
];

// The engine builds its schema through an ordered migration ledger
// (crates/dohc-engine-storage/src/migration.rs). A transactional migration
// INSERTS its `engine_migrations` row inside the same transaction as its DDL,
// so a migration that has not committed has no row at all: "every row present
// is complete" is true in the middle of the chain and says nothing.
//
// Only the LAST migration this build applies settles the ledger. Ordinals are
// strictly increasing (`validate_migration_order`) and applied in order, so a
// complete terminal row means every earlier migration committed before it
// started. An empty ledger is the degenerate case — no terminal row, poll again.
//
// The terminal ordinal is READ FROM the migration source, never pinned here: a
// stale constant would report "settled" while a newly added migration was still
// running, which is the bug this replaces.
const MIGRATION_SOURCE = fileURLToPath(
  new URL("../../../../crates/dohc-engine-storage/src/migration.rs", import.meta.url),
);

let terminalOrdinalCache: number | null = null;

function terminalMigrationOrdinal(): number {
  if (terminalOrdinalCache !== null) return terminalOrdinalCache;
  const source = readFileSync(MIGRATION_SOURCE, "utf8");
  const start = source.indexOf("const BASELINE_MIGRATIONS: &[Migration] = &[");
  if (start < 0) {
    throw new Error(`${MIGRATION_SOURCE} has no BASELINE_MIGRATIONS list to read ordinals from.`);
  }
  const end = source.indexOf("\n];", start);
  if (end < 0) {
    throw new Error(`${MIGRATION_SOURCE} has an unterminated BASELINE_MIGRATIONS list.`);
  }
  const ordinals = [...source.slice(start, end).matchAll(/^\s*ordinal:\s*(\d+),/gm)].map((match) =>
    Number(match[1]),
  );
  // The list must be 0..n-1 in order. Anything else means this reader no longer
  // understands the migration source, and guessing a terminal from it would put
  // the gate back to reporting "settled" mid-chain.
  const contiguous =
    ordinals.length > 0 && ordinals.every((ordinal, index) => ordinal === index);
  if (!contiguous) {
    throw new Error(
      `${MIGRATION_SOURCE} lists migration ordinals [${ordinals.join(", ")}], which are not ` +
        "0..n-1 in order, so the e2e schema gate cannot tell when the chain has finished.",
    );
  }
  terminalOrdinalCache = ordinals[ordinals.length - 1]!;
  return terminalOrdinalCache;
}

function schemaSettled(db: EngineDb): boolean {
  const ledger = db
    .prepare("SELECT name FROM pragma_table_info('engine_migrations')")
    .all();
  if (ledger.length === 0) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM engine_migrations
       WHERE ordinal = ? AND completed_at IS NOT NULL`,
    )
    .get(terminalMigrationOrdinal()) as { n: number } | undefined;
  return Number(row?.n ?? 0) === 1;
}

// Once the ledger has settled, every name above MUST be there. A dropped or
// renamed one throws and says which: treating it as "not ready" instead would
// make the gate false forever, every helper would return 0/[]/false, and the
// `toBe(0)` and `toEqual([])` call sites would pass on nothing — the shape this
// file exists to remove.
function requireSchema(db: EngineDb): void {
  const missing: string[] = [];
  for (const [table, columns] of SCHEMA_READ_HERE) {
    const present = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((row) => String(row.name)),
    );
    if (present.size === 0) {
      missing.push(table);
      continue;
    }
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `engine.db has no ${missing.join(", ")}, and its migration ledger has settled: ` +
        "these e2e readers query a schema the engine no longer has.",
    );
  }
}

export function withEngineDb<T>(rootPath: string, fn: (db: EngineDb) => T): T | null {
  let db: EngineDb | null = null;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), { readOnly: true });
    if (!schemaSettled(db)) return null;
    requireSchema(db);
    return fn(db);
  } catch (error) {
    if (isDbNotOpenable(error, db !== null)) return null;
    throw error;
  } finally {
    db?.close();
  }
}

export function ydocUpdateCount(rootPath: string): number {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM ydoc_updates").get() as
        | { n: number }
        | undefined;
      return Number(row?.n ?? 0);
    }) ?? 0
  );
}

// Every text-carrying moment with its blob text, ordered by moment_order.
//
// A moment's `payload_after_blob_sha256` holds a `blobs` digest for text and a
// `binary_blobs` digest for binary, so binary moments have no `blobs` row.
// Filter them out BY KIND rather than letting an inner join drop them: a text
// moment whose blob is missing is then an impossible state — a wrong join or a
// corrupt store — and it throws. Returning a shorter list instead would quietly
// satisfy the "exactly one settle moment" double-journal check in
// workspace-engine-editor.spec, the assertion this join feeds.
function readMoments(db: EngineDb, path?: string): EngineMoment[] {
  const rows = db
    .prepare(
      `SELECT m.path AS path, m.operation AS operation,
              m.payload_after_blob_sha256 AS sha, b.text AS text
       FROM moments m
       LEFT JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
       WHERE m.payload_after_blob_sha256 IS NOT NULL
         AND m.payload_after_content_kind IS NOT 'binary'
         ${path === undefined ? "" : "AND m.path = ?"}
       ORDER BY m.moment_order`,
    )
    .all(...(path === undefined ? [] : [path]));
  return rows.map((row) => {
    if (typeof row.text !== "string") {
      throw new Error(
        `engine moment ${String(row.path)} carries text payload ${String(row.sha)}, ` +
          "but blobs holds no row for that digest: the moments->blobs join is " +
          "wrong or the store is corrupt.",
      );
    }
    return { path: String(row.path), operation: String(row.operation), text: row.text };
  });
}

export function engineMomentsOrEmpty(rootPath: string): EngineMoment[] {
  return withEngineDb(rootPath, (db) => readMoments(db)) ?? [];
}

// The projected settle-moment texts for one path (settle points ARE engine
// history) — moment payloads reference text by blob sha, so the moment→blob
// join is how the content is read.
export function momentTextsForPath(rootPath: string, path: string): string[] {
  return (
    withEngineDb(rootPath, (db) => readMoments(db, path).map((moment) => moment.text)) ?? []
  );
}

// Does the engine still hold a HEAD for this path in the active version? A
// retirement (deleteIfTracked) removes the snapshot row, so this goes false
// the moment a reconcile pass decides the path is no longer engine-ownable.
export function textFileTrackedByEngine(rootPath: string, path: string): boolean {
  return (
    withEngineDb(rootPath, (db) => {
      // No join on active_versions: that table only gains a row once a
      // version is explicitly switched, so joining it reports "untracked"
      // for every ordinary single-version workspace.
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?")
        .get(path) as { n: number } | undefined;
      return Number(row?.n ?? 0) > 0;
    }) ?? false
  );
}

// Replication ops whose payload carries the given plaintext needle, grouped by
// op_kind. A ydoc.update payload is opaque Yjs binary (plaintext is not
// searchable), so the ONLY way typed plaintext lands in a replication op is a
// moment.append — this list therefore proves whether a double-journal happened.
export function replicationOpKindsMentioning(rootPath: string, needle: string): string[] {
  return (
    withEngineDb(rootPath, (db) => {
      const rows = db
        .prepare("SELECT op_kind AS opKind, payload_json AS payload FROM replication_log")
        .all() as Array<{ opKind: string; payload: string }>;
      return rows
        .filter((row) => typeof row.payload === "string" && row.payload.includes(needle))
        .map((row) => row.opKind);
    }) ?? []
  );
}

export function replicationOpKindCount(rootPath: string, opKind: string): number {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM replication_log WHERE op_kind = ?")
        .get(opKind) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    }) ?? 0
  );
}
