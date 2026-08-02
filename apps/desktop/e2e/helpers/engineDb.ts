import { createRequire } from "node:module";
import { join } from "node:path";

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
function isDbNotOpenable(error: unknown, dbOpened: boolean): boolean {
  if (dbOpened) return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "SQLITE_CANTOPEN";
}

// Every (table, column) this file reads. The engine applies its schema through
// an ordered migration chain, and a later migration adds `payload_after_*` to a
// baseline `moments`, so a read-only poll can observe the chain mid-flight (a
// real race caught on Windows). This list is the readiness gate for that race:
// a half-applied chain reads as "poll again" BEFORE any query runs, so after
// the gate every query error throws.
//
// That split is the point. A swallowed query error becomes an EMPTY result, and
// an empty result silently satisfies `toEqual([])`, `toBe(0)` and `toBe(false)`
// at the call sites below. A name that is NOT on this list — a typo, a renamed
// column, a wrong join column — reaches the query and fails loud.
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

function schemaMaterialized(db: EngineDb): boolean {
  for (const [table, columns] of SCHEMA_READ_HERE) {
    const present = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((row) => String(row.name)),
    );
    if (present.size === 0) return false;
    for (const column of columns) if (!present.has(column)) return false;
  }
  return true;
}

export function withEngineDb<T>(rootPath: string, fn: (db: EngineDb) => T): T | null {
  let db: EngineDb | null = null;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), { readOnly: true });
    if (!schemaMaterialized(db)) return null;
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
