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

// The engine.db may not exist yet while the app is still opening, and right
// after creation its schema materializes through a migration chain a readonly
// poll can observe mid-flight (moments existed before payload_after_* landed —
// a real race caught on Windows). Both are "not ready, poll again" cases.
// The cost: a genuinely typo'd column/table now times the poll out instead of
// failing fast — every other error still rethrows with its real message.
function isDbNotReady(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "SQLITE_CANTOPEN") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unable to open database|cannot open|no such file|no such table|no such column/i.test(
    message,
  );
}

export function withEngineDb<T>(rootPath: string, fn: (db: EngineDb) => T): T | null {
  let db: EngineDb | null = null;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), { readOnly: true });
    return fn(db);
  } catch (error) {
    // "Not present yet" and "schema still materializing" both poll again —
    // the latter throws from the query itself, so the db handle may be open.
    if (isDbNotReady(error)) return null;
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

// Every projected moment carrying its blob text, ordered by moment_order.
export function engineMomentsOrEmpty(rootPath: string): EngineMoment[] {
  return (
    withEngineDb(rootPath, (db) =>
      db
        .prepare(
          `SELECT m.path AS path, m.operation AS operation, b.text AS text
           FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
           ORDER BY m.moment_order`,
        )
        .all() as unknown as EngineMoment[],
    ) ?? []
  );
}

// The projected settle-moment texts for one path (settle points ARE engine
// history) — moment payloads reference text by blob sha, so the moment→blob
// join is how the content is read.
export function momentTextsForPath(rootPath: string, path: string): string[] {
  return (
    withEngineDb(rootPath, (db) =>
      (
        db
          .prepare(
            `SELECT b.text AS text
             FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
             WHERE m.path = ? ORDER BY m.moment_order`,
          )
          .all(path) as Array<{ text: string }>
      ).map((row) => row.text),
    ) ?? []
  );
}

// Does the engine still hold a HEAD for this path in the active version? A
// retirement (deleteIfTracked) removes the snapshot row, so this goes false
// the moment a reconcile pass decides the path is no longer engine-ownable.
export function textFileTrackedByEngine(rootPath: string, path: string): boolean {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM snapshots s
             JOIN active_versions a
               ON a.workspace_id = s.workspace_id AND a.version_id = s.version_id
            WHERE s.path = ?`,
        )
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
