import type { ChangeAuthor } from "./changeSet";

// Local-first database rules. The on-disk .sqlite IS the user's canonical
// artifact — visible and inspectable. Its raw bytes never travel through CRDT
// text sync; structured edits flow as an append-only operation log, and the
// transient WAL/journal sidecars are never synced as standalone files.

const DB_EXT = /\.(?:db|sqlite|sqlite3)$/i;
const SIDECAR = /^(.*\.(?:db|sqlite|sqlite3))-(?:wal|shm|journal)$/i;

export type DatabaseFileKind =
  | "visible-user" // user data db (e.g. finance/wallet.sqlite) — syncs via op-log
  | "hidden-internal" // .dohc/** db — a local cache/index, never synced
  | "sidecar" // -wal/-shm/-journal — transient, never a standalone synced file
  | "not-a-database";

export function isDatabaseSidecar(path: string): boolean {
  return SIDECAR.test(path);
}

// True for the database file itself (never its sidecars). The single source
// of the extension set — the watcher's sidecar-collapse logic uses these
// helpers so the two layers can't drift (.sqlite3 was once missed that way).
export function isDatabaseFile(path: string): boolean {
  return DB_EXT.test(path);
}

// Strip a sidecar suffix back to its base database path; null for non-sidecars.
export function sidecarBasePath(path: string): string | null {
  const match = SIDECAR.exec(path);
  return match ? match[1] : null;
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

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Database operation ${field} must be a non-empty string`);
  }
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
  assertNonEmptyString(input.operationId, "operationId");
  assertNonEmptyString(input.databasePath, "databasePath");
  assertNonEmptyString(input.table, "table");
  assertNonEmptyString(input.rowId, "rowId");
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw new Error("Database operation version must be a non-negative integer");
  }
  if (!Number.isFinite(input.appliedAt) || input.appliedAt < 0) {
    throw new Error("Database operation appliedAt must be a valid timestamp");
  }
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

// 32-bit FNV-1a over the exact path (pure JS — workspace-core must stay
// renderer-safe, so no node:crypto). The readable slug alone is ambiguous
// ("a/b.sqlite" and "a_b.sqlite" both slug to "a_b.sqlite"); the tag makes two
// databases' logs collide only if BOTH slug and hash collide.
function pathTag(path: string): string {
  let hash = 0x811c9dc5;
  for (const char of path) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// A stable, readable, collision-free op-log location for a visible database.
// Kept under .dohc (internal metadata governing a visible db), inspectable JSONL.
export function databaseOpLogPath(databasePath: string): string {
  const slug = databasePath.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `.dohc/databases/${slug}-${pathTag(databasePath)}/operations.jsonl`;
}
