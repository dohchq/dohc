import {
  createDatabaseOperation,
  databaseOpLogPath,
  mediaTypeForPath,
  serializeDatabaseOperation,
  validateUserMaterializePath,
  type ChangeAuthor,
  type DatabaseRowOp,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveWorkspaceFile } from "./workspaceAssets";
import { existingAncestor } from "./workspaceFiles";

// node:sqlite is a Node built-in (no native addon, no electron-rebuild). It is
// loaded via createRequire so the bundler leaves it as a runtime require and it
// stays off the launch path until a database is actually opened. A minimal
// local type avoids depending on @types/node's experimental sqlite typings.
interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const requireFromHere = createRequire(import.meta.url);
function nodeSqlite(): SqliteModule {
  return requireFromHere("node:sqlite") as SqliteModule;
}

interface DatabaseColumnView {
  name: string;
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
}
interface DatabaseTableView {
  name: string;
  columns: DatabaseColumnView[];
  rows: Array<Record<string, unknown>>;
}
export interface DatabaseSnapshotView {
  path: string;
  tables: DatabaseTableView[];
}

// Bounds: the studio shows a workable window, never streams an entire large
// database into the renderer or main-process memory (native-fast, not
// Notion-slow — and a hostile db with one giant blob must not freeze the app).
const MAX_ROWS = 1000;
const MAX_TABLES = 200;
const MAX_CELL_CHARS = 4096;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Bound every cell before it leaves the database layer: blobs become a small
// placeholder, oversized text is truncated for display (edits write the full
// typed value, so truncation never round-trips into the file).
function sanitizeCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}…`;
  }
  return value;
}

function sanitizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sanitizeCell(v)])),
  );
}

// node:sqlite only binds null / number / bigint / string / Uint8Array. Coerce
// the JS values the studio sends (booleans, undefined) into bindable ones.
function bindable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

// Reads a visible workspace database into an inspectable snapshot: every table,
// its column schema, and a bounded window of rows. Opened read-only.
export async function readDatabaseSnapshot(
  rootPath: string,
  relativePath: string,
): Promise<DatabaseSnapshotView> {
  const { realTarget, normalized } = await resolveWorkspaceFile(
    rootPath,
    relativePath,
    "read",
  );
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(realTarget, { readOnly: true });
  try {
    const tableNames = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ${MAX_TABLES}`,
      )
      .all()
      .map((r) => String(r.name));
    const tables: DatabaseTableView[] = tableNames.map((name) => {
      const info = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
      const columns: DatabaseColumnView[] = info.map((c) => ({
        name: String(c.name),
        type: String(c.type ?? "").toLowerCase() || "text",
        primaryKey: Number(c.pk) > 0,
        nullable: Number(c.notnull) === 0,
      }));
      // Each row carries its SQLite rowid as __dohc_rowid — the stable, unique
      // identity an edit keys on (a guessed "id" column may not be unique).
      // WITHOUT ROWID tables fall back to a plain select; the studio then only
      // allows edits when a single-column declared primary key exists.
      let rows: Array<Record<string, unknown>>;
      try {
        rows = db
          .prepare(`SELECT rowid AS __dohc_rowid, * FROM ${quoteIdent(name)} LIMIT ${MAX_ROWS}`)
          .all();
      } catch {
        rows = db.prepare(`SELECT * FROM ${quoteIdent(name)} LIMIT ${MAX_ROWS}`).all();
      }
      return { name, columns, rows: sanitizeRows(rows) };
    });
    return { path: normalized, tables };
  } finally {
    db.close();
  }
}

export interface DatabaseEdit {
  table: string;
  op: DatabaseRowOp;
  pkColumn: string;
  rowId: string | number;
  payload?: Record<string, unknown>;
}

function runEdit(db: SqliteDb, edit: DatabaseEdit): void {
  const table = quoteIdent(edit.table);
  const pk = quoteIdent(edit.pkColumn);
  if (edit.op === "delete") {
    db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(bindable(edit.rowId));
    return;
  }
  const payload = edit.payload ?? {};
  if (edit.op === "update") {
    const cols = Object.keys(payload);
    if (cols.length === 0) return;
    const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(", ");
    db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`).run(
      ...cols.map((c) => bindable(payload[c])),
      bindable(edit.rowId),
    );
    return;
  }
  // insert / upsert — ensure the primary key value is present.
  const cols = edit.pkColumn in payload ? Object.keys(payload) : [edit.pkColumn, ...Object.keys(payload)];
  const values = cols.map((c) => bindable(c === edit.pkColumn && !(c in payload) ? edit.rowId : payload[c]));
  const verb = edit.op === "upsert" ? "INSERT OR REPLACE" : "INSERT";
  db.prepare(
    `${verb} INTO ${table} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...values);
}

async function nextOpVersion(logAbsPath: string): Promise<number> {
  try {
    const text = await readFile(logAbsPath, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length + 1;
  } catch {
    return 1;
  }
}

// Edits to one database run strictly in sequence: the op-log version derives
// from the log's line count, so two interleaved edits would otherwise both
// read the same count and record duplicate versions.
const editQueues = new Map<string, Promise<unknown>>();

function enqueueEdit<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (editQueues.get(key) ?? Promise.resolve()).then(run, run);
  editQueues.set(key, next.catch(() => undefined));
  return next;
}

// Applies a single structured row edit to a visible database IN PLACE (the
// file is the canonical artifact) and appends the edit to the inspectable
// JSONL operation log under .dohc. Local history records the file change via
// the watcher today; the op log is the structured record cloud sync will
// carry in Phase 9 (raw database bytes never CRDT-sync). Returns the fresh
// snapshot.
export function applyDatabaseEdit(
  rootPath: string,
  relativePath: string,
  edit: DatabaseEdit,
  author: ChangeAuthor,
  nowMs: number,
  // Injectable id seam (oracle/tests) for the persisted operationId. Omitted ⇒
  // a real randomUUID, identical to today's behavior.
  options: { signal?: AbortSignal; createId?: () => string } = {},
): Promise<DatabaseSnapshotView> {
  return enqueueEdit(`${rootPath}\u0000${relativePath}`, () => {
    if (options.signal?.aborted) throw new Error("Database edit was cancelled.");
    return applyDatabaseEditNow(
      rootPath,
      relativePath,
      edit,
      author,
      nowMs,
      options.signal,
      options.createId,
    );
  });
}

async function applyDatabaseEditNow(
  rootPath: string,
  relativePath: string,
  edit: DatabaseEdit,
  author: ChangeAuthor,
  nowMs: number,
  signal?: AbortSignal,
  createId: () => string = randomUUID,
): Promise<DatabaseSnapshotView> {
  const { realTarget, normalized } = await resolveWorkspaceFile(rootPath, relativePath);
  if (signal?.aborted) throw new Error("Database edit was cancelled.");
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(realTarget);
  try {
    runEdit(db, edit);
  } finally {
    db.close();
  }

  const logRel = databaseOpLogPath(normalized);
  const logAbs = join(rootPath, logRel);
  await mkdir(dirname(logAbs), { recursive: true });
  const operation = createDatabaseOperation({
    operationId: createId(),
    databasePath: normalized,
    table: edit.table,
    op: edit.op,
    rowId: String(edit.rowId),
    payload: edit.payload ?? {},
    version: await nextOpVersion(logAbs),
    appliedAt: nowMs,
    author,
  });
  await appendFile(logAbs, serializeDatabaseOperation(operation));

  return readDatabaseSnapshot(rootPath, relativePath);
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(sep);
}

// Atomically writes bytes to a NEW workspace-relative path, enforcing
// path-safety and real-path containment (no traversal, no symlink escape).
// Containment is checked against the deepest EXISTING ancestor BEFORE mkdir —
// a workspace-internal symlinked ancestor must not cause directories to be
// created outside the root (mirrors createFile). Refuses to replace an
// existing file: the on-disk database is canonical, so materializing over it
// would silently drop the user's edits. temp+rename so a reader never sees a
// half-written database.
async function writeWorkspaceBytes(
  rootPath: string,
  relativePath: string,
  bytes: Buffer,
): Promise<string> {
  const validated = validateUserMaterializePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid database path (${validated.reason}): ${relativePath}`);
  }
  const absolute = join(rootPath, validated.normalized);
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(dirname(absolute)))) {
    throw new Error(`Invalid database path (escapes workspace): ${relativePath}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  if (!isInside(realRoot, await realpath(dirname(absolute)))) {
    throw new Error(`Invalid database path (escapes workspace): ${relativePath}`);
  }
  const temp = `${absolute}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes);
  try {
    // link() fails with EEXIST if the target exists (rename would clobber).
    await link(temp, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Database already exists: ${validated.normalized}`);
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
  return validated.normalized;
}

// Imports a delimited/structured source file (CSV, JSON, JSONL, Markdown table)
// into a visible SQLite database, reusing the sqlite-worker engine's parser and
// schema inference. The materialized bytes are written atomically (a safe
// materialization point) so the watcher only ever sees a complete database.
export async function importToDatabase(
  rootPath: string,
  sourceRelativePath: string,
  databaseRelativePath: string,
  tableName: string,
): Promise<{ path: string; tableName: string; rowCount: number }> {
  const { realTarget } = await resolveWorkspaceFile(
    rootPath,
    sourceRelativePath,
    "read",
  );
  const body = await readFile(realTarget, "utf8");
  const mediaType = mediaTypeForPath(sourceRelativePath) ?? "text/plain";

  // Dynamic import keeps the engine (and node:sqlite) off the launch path.
  const { createSqliteEngine } = await import("@dohc/sqlite-worker");
  const engine = await createSqliteEngine();
  const result = await engine.importData({ name: basename(sourceRelativePath), mediaType, body, tableName });
  if (!result.ok) {
    throw new Error(`Import failed (${result.code}): ${result.message}`);
  }

  const path = await writeWorkspaceBytes(
    rootPath,
    databaseRelativePath,
    Buffer.from(result.bytesBase64, "base64"),
  );
  return { path, tableName: result.tableName, rowCount: result.rowCount };
}
