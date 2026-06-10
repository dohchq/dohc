import type { ChangeAuthor } from "./changeSet";

// Local-first database rules. The on-disk .sqlite IS the user's canonical
// artifact — visible and inspectable. Its raw bytes never travel through CRDT
// text sync; structured edits flow as an append-only operation log, and the
// transient WAL/journal sidecars are never synced as standalone files.

const DB_EXT = /\.(?:db|sqlite|sqlite3)$/i;
const SIDECAR = /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/i;

export type DatabaseFileKind =
  | "visible-user" // user data db (e.g. finance/wallet.sqlite) — syncs via op-log
  | "hidden-internal" // .dohc/** db — a local cache/index, never synced
  | "sidecar" // -wal/-shm/-journal — transient, never a standalone synced file
  | "not-a-database";

export function isDatabaseSidecar(path: string): boolean {
  return SIDECAR.test(path);
}

function inDohc(path: string): boolean {
  return path === ".dohc" || path.startsWith(".dohc/");
}

export function classifyDatabaseFile(path: string): DatabaseFileKind {
  if (SIDECAR.test(path)) return "sidecar";
  if (!DB_EXT.test(path)) return "not-a-database";
  return inDohc(path) ? "hidden-internal" : "visible-user";
}

// How the sync engine treats a path's bytes:
// - operation-log: a visible db — raw bytes are NOT CRDT-synced; structured
//   edits travel as an operation log (and the file materializes locally).
// - ignore: sidecars (transient) and hidden internal dbs (local cache only).
// - file-content: an ordinary file, synced as text/content.
export type DatabaseSyncStrategy = "operation-log" | "ignore" | "file-content";

export function databaseSyncStrategy(path: string): DatabaseSyncStrategy {
  switch (classifyDatabaseFile(path)) {
    case "visible-user":
      return "operation-log";
    case "hidden-internal":
    case "sidecar":
      return "ignore";
    case "not-a-database":
      return "file-content";
  }
}

// True only for ordinary files. A database's raw bytes never sync as a file
// (they sync via the op-log), and sidecars are never synced at all.
export function shouldSyncAsStandaloneFile(path: string): boolean {
  return databaseSyncStrategy(path) === "file-content";
}

// A safe point at which a visible .sqlite is (re)materialized on disk and
// surfaced to sync — never mid-write or while the WAL is still active.
export type MaterializationTrigger =
  | "import-complete"
  | "explicit-save"
  | "close"
  | "mid-write"
  | "wal-active";

export function isDatabaseMaterializationPoint(trigger: MaterializationTrigger): boolean {
  return trigger === "import-complete" || trigger === "explicit-save" || trigger === "close";
}

export type DatabaseRowOp = "insert" | "update" | "upsert" | "delete";

// One structured row edit. The append-only log of these IS what syncs for a
// database — not the raw bytes. Stored as inspectable JSONL under .dohc.
export interface DatabaseOperation {
  operationId: string;
  databasePath: string;
  table: string;
  op: DatabaseRowOp;
  rowId: string;
  payload: Record<string, unknown>;
  version: number;
  appliedAt: number;
  author: ChangeAuthor;
}

export function createDatabaseOperation(input: {
  operationId: string;
  databasePath: string;
  table: string;
  op: DatabaseRowOp;
  rowId: string;
  payload?: Record<string, unknown>;
  version: number;
  appliedAt: number;
  author: ChangeAuthor;
}): DatabaseOperation {
  return {
    operationId: input.operationId,
    databasePath: input.databasePath,
    table: input.table,
    op: input.op,
    rowId: input.rowId,
    payload: input.payload ?? {},
    version: input.version,
    appliedAt: input.appliedAt,
    author: input.author,
  };
}

export function serializeDatabaseOperation(op: DatabaseOperation): string {
  return `${JSON.stringify(op)}\n`;
}

// A stable, readable op-log location for a visible database. Kept under .dohc
// (internal metadata governing a visible db) and inspectable as JSONL.
export function databaseOpLogPath(databasePath: string): string {
  const slug = databasePath.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `.dohc/databases/${slug}/operations.jsonl`;
}
