import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { WorkspacePath, type Actor } from "@dohc/workspace-contracts";
import { type BlobStore } from "../blobStore";
import { assertWorkspaceMember } from "../policy/authorize";
import {
  hasWorkspaceMembership,
  type PgQueryable,
} from "../repositories/workspaces";

export type DatabaseColumn = {
  name: string;
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
};

export type DatabaseTable = {
  columns: DatabaseColumn[];
  rows: Array<Record<string, unknown>>;
};

export type DatabaseSnapshot = Record<string, DatabaseTable>;

export type DatabaseOperation = "insert" | "update" | "upsert" | "delete";

type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

type SQLiteModule = {
  DatabaseSync: new (location: string) => SQLiteDatabase;
};

type DatabaseFileRow = {
  id: string;
  workspace_id: string;
  path: string;
  media_type: string;
  size: number;
  sha256: string;
  object_key: string;
  revision: number;
  schema_snapshot: unknown;
};

type DatabaseOpRow = {
  operation_id: string;
  base_version: number;
  result_version: number;
  operation: unknown;
  result: unknown;
  created_at: Date;
};

const require = createRequire(import.meta.url);
let sqliteModulePromise: Promise<SQLiteModule> | null = null;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQLITE_MEDIA_TYPE = "application/vnd.sqlite3";

function sqliteModule() {
  sqliteModulePromise ??= Promise.resolve(require("node:sqlite") as SQLiteModule);
  return sqliteModulePromise;
}

function error(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, code, message, ...extra };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const copy = new Uint8Array(bytes);
      const digest = sha256(copy);
      const objectKey = `memory/${digest}`;
      blobs.set(objectKey, copy);
      return { objectKey, sha256: digest, size: copy.byteLength };
    },
    async get(objectKey) {
      const bytes = blobs.get(objectKey);
      if (!bytes) throw new Error(`Blob not found: ${objectKey}`);
      return new Uint8Array(bytes);
    },
  };
}

async function assertAuthorized(db: PgQueryable, actor: Actor) {
  await assertWorkspaceMember({
    actor,
    workspaceId: actor.workspaceId,
    hasMembership: (userId, workspaceId) =>
      hasWorkspaceMembership(db, userId, workspaceId),
  });
}

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid SQLite identifier: ${name}`);
  return `"${name}"`;
}

function sqliteType(type: string): string {
  const clean = type.trim().toUpperCase();
  if (
    clean === "INTEGER" ||
    clean === "REAL" ||
    clean === "TEXT" ||
    clean === "BLOB"
  ) {
    return clean;
  }
  if (clean.includes("INT")) return "INTEGER";
  if (clean.includes("REAL") || clean.includes("FLOA") || clean.includes("DOUB")) {
    return "REAL";
  }
  return "TEXT";
}

function bindValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value ?? null);
}

function primaryKeyFor(table: DatabaseTable): string {
  return table.columns.find((column) => column.primaryKey)?.name ?? "id";
}

function normalizeSnapshot(value: unknown): DatabaseSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot: DatabaseSnapshot = {};
  for (const [tableName, rawTable] of Object.entries(value as Record<string, unknown>)) {
    if (!IDENT_RE.test(tableName)) return null;
    if (!rawTable || typeof rawTable !== "object" || Array.isArray(rawTable)) {
      return null;
    }
    const row = rawTable as Record<string, unknown>;
    if (!Array.isArray(row.columns) || !Array.isArray(row.rows)) return null;
    const columns: DatabaseColumn[] = [];
    const seen = new Set<string>();
    for (const rawColumn of row.columns) {
      if (!rawColumn || typeof rawColumn !== "object" || Array.isArray(rawColumn)) {
        return null;
      }
      const column = rawColumn as Record<string, unknown>;
      if (typeof column.name !== "string" || !IDENT_RE.test(column.name)) return null;
      if (seen.has(column.name)) return null;
      seen.add(column.name);
      columns.push({
        name: column.name,
        type: typeof column.type === "string" ? sqliteType(column.type) : "TEXT",
        ...(column.primaryKey === true ? { primaryKey: true } : {}),
        ...(column.nullable === true ? { nullable: true } : {}),
      });
    }
    snapshot[tableName] = {
      columns,
      rows: row.rows.map((raw) =>
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>) }
          : {},
      ),
    };
  }
  return snapshot;
}

function createTables(db: SQLiteDatabase, snapshot: DatabaseSnapshot) {
  for (const [tableName, table] of Object.entries(snapshot)) {
    const columns = table.columns.map((column) => {
      const parts = [quoteIdent(column.name), sqliteType(column.type)];
      if (column.primaryKey) parts.push("PRIMARY KEY");
      if (column.primaryKey && column.nullable !== true) parts.push("NOT NULL");
      return parts.join(" ");
    });
    db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${columns.join(", ")})`);
    if (table.rows.length === 0) continue;
    const names = table.columns.map((column) => column.name);
    const placeholders = names.map(() => "?").join(", ");
    const statement = db.prepare(
      `INSERT INTO ${quoteIdent(tableName)} (${names.map(quoteIdent).join(", ")}) VALUES (${placeholders})`,
    );
    for (const row of table.rows) {
      statement.run(...names.map((name) => bindValue(row[name])));
    }
  }
}

function snapshotFromDatabase(db: SQLiteDatabase): DatabaseSnapshot {
  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const snapshot: DatabaseSnapshot = {};
  for (const tableRow of tableRows) {
    const tableName = String(tableRow.name);
    const pragma = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all();
    const columns = pragma.map((row) => ({
      name: String(row.name),
      type: sqliteType(String(row.type || "TEXT")),
      ...(Number(row.pk ?? 0) > 0 ? { primaryKey: true } : {}),
      ...(Number(row.notnull ?? 0) === 0 ? { nullable: true } : {}),
    }));
    snapshot[tableName] = {
      columns,
      rows: db
        .prepare(`SELECT * FROM ${quoteIdent(tableName)}`)
        .all()
        .map((row) => Object.fromEntries(Object.entries(row))),
    };
  }
  return snapshot;
}

async function withTempFile<T>(prefix: string, fn: (file: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(join(dir, "database.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function materializeSnapshot(snapshot: DatabaseSnapshot): Promise<Uint8Array> {
  const { DatabaseSync } = await sqliteModule();
  return await withTempFile("dohc-pg-sqlite-materialize-", async (file) => {
    const db = new DatabaseSync(file);
    try {
      createTables(db, snapshot);
    } finally {
      db.close();
    }
    return new Uint8Array(await readFile(file));
  });
}

async function ingestSnapshot(bytes: Uint8Array): Promise<DatabaseSnapshot> {
  const { DatabaseSync } = await sqliteModule();
  return await withTempFile("dohc-pg-sqlite-ingest-", async (file) => {
    await writeFile(file, bytes);
    const db = new DatabaseSync(file);
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      const ok =
        integrity.length === 1 &&
        String(integrity[0]?.integrity_check ?? "") === "ok";
      if (!ok) throw new Error("SQLite integrity check failed.");
      return snapshotFromDatabase(db);
    } finally {
      db.close();
    }
  });
}

async function querySnapshot(
  snapshot: DatabaseSnapshot,
  sql: string,
  params: unknown[] = [],
) {
  if (!/^\s*select\b/i.test(sql)) {
    return error("database-query-not-readonly", "Only SELECT queries are allowed.");
  }
  const { DatabaseSync } = await sqliteModule();
  const db = new DatabaseSync(":memory:");
  try {
    createTables(db, snapshot);
    return { ok: true as const, rows: db.prepare(sql).all(...params) };
  } finally {
    db.close();
  }
}

async function databaseByPath(db: PgQueryable, actor: Actor, path: string) {
  WorkspacePath.parse(path);
  const result = await db.query<DatabaseFileRow>(
    `
      select id, workspace_id, path, media_type, size, sha256, object_key, revision, schema_snapshot
      from database_files
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      limit 1
    `,
    [actor.workspaceId, path],
  );
  return result.rows[0] ?? null;
}

function mutateSnapshot(
  snapshot: DatabaseSnapshot,
  input: {
    op: DatabaseOperation;
    table: string;
    rowId?: string;
    payload: unknown;
  },
) {
  const table = snapshot[input.table];
  if (!table) return error("table-not-found", "Table not found.");
  const payload =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? { ...(input.payload as Record<string, unknown>) }
      : {};
  const columnNames = new Set(table.columns.map((column) => column.name));
  for (const key of Object.keys(payload)) {
    if (!columnNames.has(key)) {
      return error("database-column-not-found", `Column "${key}" does not exist.`);
    }
  }
  const primaryKey = primaryKeyFor(table);
  const rowId = input.rowId ?? String(payload[primaryKey] ?? "");
  if (!rowId) return error("invalid-row-id", "Row id is required.");
  const existingIndex = table.rows.findIndex((row) => String(row[primaryKey]) === rowId);

  if (input.op === "insert") {
    if (existingIndex >= 0) return error("database-row-conflict", "Row already exists.");
    table.rows.push({ ...payload, [primaryKey]: rowId });
  } else if (input.op === "update") {
    if (existingIndex < 0) return error("database-row-not-found", "Row not found.");
    table.rows[existingIndex] = {
      ...table.rows[existingIndex],
      ...payload,
      [primaryKey]: rowId,
    };
  } else if (input.op === "upsert") {
    if (existingIndex < 0) table.rows.push({ ...payload, [primaryKey]: rowId });
    else {
      table.rows[existingIndex] = {
        ...table.rows[existingIndex],
        ...payload,
        [primaryKey]: rowId,
      };
    }
  } else {
    if (existingIndex < 0) return error("database-row-not-found", "Row not found.");
    table.rows.splice(existingIndex, 1);
  }
  return { ok: true as const, rowId };
}

async function insertDatabaseFile(
  db: PgQueryable,
  actor: Actor,
  input: {
    path: string;
    snapshot: DatabaseSnapshot;
    bytes: Uint8Array;
    stored: { objectKey: string; sha256: string; size: number };
  },
) {
  const id = randomUUID();
  const result = await db.query<DatabaseFileRow>(
    `
      insert into database_files (
        id,
        workspace_id,
        path,
        media_type,
        size,
        sha256,
        object_key,
        revision,
        schema_snapshot
      )
      values ($1, $2, $3, $4, $5, $6, $7, 1, $8)
      returning id, workspace_id, path, media_type, size, sha256, object_key, revision, schema_snapshot
    `,
    [
      id,
      actor.workspaceId,
      input.path,
      SQLITE_MEDIA_TYPE,
      input.stored.size,
      input.stored.sha256,
      input.stored.objectKey,
      JSON.stringify(input.snapshot),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Database file insert returned no row.");
  return row;
}

export function createPostgresDatabaseServices(
  pool: pg.Pool,
  options: { blobStore?: BlobStore } = {},
) {
  const blobStore = options.blobStore ?? createMemoryBlobStore();

  return {
    async createFromSnapshot(
      actor: Actor,
      input: { path: string; snapshot: DatabaseSnapshot },
    ) {
      WorkspacePath.parse(input.path);
      const snapshot = normalizeSnapshot(input.snapshot);
      if (!snapshot) return error("invalid-database-snapshot", "Database snapshot is invalid.");
      await assertAuthorized(pool, actor);
      const bytes = await materializeSnapshot(snapshot);
      const stored = await blobStore.put(bytes);
      const row = await insertDatabaseFile(pool, actor, {
        path: input.path,
        snapshot,
        bytes,
        stored,
      });
      return { ok: true as const, path: row.path, version: row.revision };
    },

    async ingestSqlite(actor: Actor, input: { path: string; bytes: Uint8Array }) {
      WorkspacePath.parse(input.path);
      await assertAuthorized(pool, actor);
      const snapshot = await ingestSnapshot(input.bytes);
      const stored = await blobStore.put(input.bytes);
      const row = await insertDatabaseFile(pool, actor, {
        path: input.path,
        snapshot,
        bytes: input.bytes,
        stored,
      });
      return { ok: true as const, path: row.path, version: row.revision };
    },

    async tables(actor: Actor, path: string) {
      await assertAuthorized(pool, actor);
      const row = await databaseByPath(pool, actor, path);
      if (!row) return error("database-not-found", "Database not found.");
      const snapshot = normalizeSnapshot(row.schema_snapshot);
      if (!snapshot) return error("invalid-database-snapshot", "Database snapshot is invalid.");
      return { ok: true as const, tables: Object.keys(snapshot).sort() };
    },

    async query(
      actor: Actor,
      input: { path: string; sql: string; params?: unknown[] },
    ) {
      await assertAuthorized(pool, actor);
      const row = await databaseByPath(pool, actor, input.path);
      if (!row) return error("database-not-found", "Database not found.");
      const snapshot = normalizeSnapshot(row.schema_snapshot);
      if (!snapshot) return error("invalid-database-snapshot", "Database snapshot is invalid.");
      return await querySnapshot(snapshot, input.sql, input.params ?? []);
    },

    async apply(
      actor: Actor,
      input: {
        path: string;
        operationId: string;
        expectedVersion?: number;
        op: DatabaseOperation;
        table: string;
        rowId?: string;
        payload: unknown;
      },
    ) {
      return await withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const existing = await client.query<DatabaseOpRow>(
          `
            select operation_id, base_version, result_version, operation, result, created_at
            from database_operations
            where workspace_id = $1
              and operation_id = $2
            limit 1
          `,
          [actor.workspaceId, input.operationId],
        );
        if (existing.rows[0]) {
          return { ok: true as const, version: existing.rows[0].result_version, idempotent: true };
        }
        const row = await databaseByPath(client, actor, input.path);
        if (!row) return error("database-not-found", "Database not found.");
        if (input.expectedVersion !== undefined && row.revision !== input.expectedVersion) {
          return error("database-version-conflict", "Database version changed.", {
            currentVersion: row.revision,
          });
        }
        const snapshot = normalizeSnapshot(row.schema_snapshot);
        if (!snapshot) return error("invalid-database-snapshot", "Database snapshot is invalid.");
        const mutated = mutateSnapshot(snapshot, input);
        if (!mutated.ok) return mutated;
        const bytes = await materializeSnapshot(snapshot);
        const stored = await blobStore.put(bytes);
        const nextVersion = row.revision + 1;
        await client.query(
          `
            update database_files
            set revision = $3,
                schema_snapshot = $4,
                size = $5,
                sha256 = $6,
                object_key = $7,
                updated_at = now()
            where id = $1
              and workspace_id = $2
          `,
          [
            row.id,
            actor.workspaceId,
            nextVersion,
            JSON.stringify(snapshot),
            stored.size,
            stored.sha256,
            stored.objectKey,
          ],
        );
        await client.query(
          `
            insert into database_operations (
              id,
              workspace_id,
              database_file_id,
              operation_id,
              base_version,
              result_version,
              operation,
              result
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            randomUUID(),
            actor.workspaceId,
            row.id,
            input.operationId,
            row.revision,
            nextVersion,
            JSON.stringify(input),
            JSON.stringify({ rowId: mutated.rowId }),
          ],
        );
        return { ok: true as const, version: nextVersion };
      });
    },

    async listOperations(actor: Actor, path: string) {
      await assertAuthorized(pool, actor);
      const row = await databaseByPath(pool, actor, path);
      if (!row) return error("database-not-found", "Database not found.");
      const result = await pool.query<DatabaseOpRow>(
        `
          select operation_id, base_version, result_version, operation, result, created_at
          from database_operations
          where workspace_id = $1
            and database_file_id = $2
          order by result_version asc
        `,
        [actor.workspaceId, row.id],
      );
      return {
        ok: true as const,
        operations: result.rows.map((operation) => ({
          operationId: operation.operation_id,
          baseVersion: operation.base_version,
          resultVersion: operation.result_version,
          operation: operation.operation,
          result: operation.result,
          createdAt: operation.created_at.getTime(),
        })),
      };
    },

    async materialize(actor: Actor, path: string) {
      await assertAuthorized(pool, actor);
      const row = await databaseByPath(pool, actor, path);
      if (!row) return error("database-not-found", "Database not found.");
      const snapshot = normalizeSnapshot(row.schema_snapshot);
      if (!snapshot) return error("invalid-database-snapshot", "Database snapshot is invalid.");
      const bytes = await materializeSnapshot(snapshot);
      return { ok: true as const, mediaType: SQLITE_MEDIA_TYPE, bytes };
    },
  };
}

async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (cause) {
    await client.query("rollback");
    throw cause;
  } finally {
    client.release();
  }
}
