import {
  databaseOpLogPath,
  DOHC_DATABASES_GUARD,
  hardLinkedFileRefusal,
  mediaTypeForPath,
  notAFileRefusal,
  notARealFolderRefusal,
  validateUserMaterializePath,
} from "@dohc/workspace-core";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isInside } from "../security/pathContainment";
import {
  resolveWorkspaceFile,
  prepareWorkspaceFileRead,
  type PreparedWorkspaceFileRead,
} from "./workspaceAssets";
import type { OwnedWorkspaceDatabaseReader } from "./ownedWorkspaceFileReader";
import { existingAncestor } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import type {
  DatabaseEdit,
  DatabaseEditResult,
  DatabasePageView,
  DatabaseSnapshotView,
} from "./workspaceDatabaseTypes";
import {
  createWorkspaceDatabaseWorkerOwner,
  type WorkspaceDatabaseWorkerOwner,
} from "./workspaceDatabaseWorker";

export type {
  DatabaseColumnView,
  DatabaseEdit,
  DatabaseEditResult,
  DatabasePageView,
  DatabaseSnapshotView,
  DatabaseTableView,
} from "./workspaceDatabaseTypes";
export {
  createWorkspaceDatabaseWorkerOwner,
  type WorkspaceDatabaseWorkerOwner,
} from "./workspaceDatabaseWorker";

export const workspaceDatabaseWorker = createWorkspaceDatabaseWorkerOwner();

interface DatabaseWorkerCallOptions {
  signal?: AbortSignal;
  worker?: WorkspaceDatabaseWorkerOwner;
}

export async function readDatabaseSnapshot(
  rootPath: string,
  relativePath: string,
  options: DatabaseWorkerCallOptions = {},
): Promise<DatabaseSnapshotView> {
  const { realTarget, normalized } = await resolveWorkspaceFile(
    rootPath,
    relativePath,
    "read",
  );
  return (options.worker ?? workspaceDatabaseWorker).readPath({
    absolutePath: realTarget,
    path: normalized,
    signal: options.signal,
  });
}

async function readPreparedPath<T>(
  source: PreparedWorkspaceFileRead,
  run: (absolutePath: string) => Promise<T>,
): Promise<T> {
  return source.withVerifiedPath(run);
}

export function readPreparedDatabaseSnapshot(
  requestedPath: string,
  source: PreparedWorkspaceFileRead,
  options: DatabaseWorkerCallOptions = {},
): Promise<DatabaseSnapshotView> {
  return readPreparedPath(source, (absolutePath) =>
    (options.worker ?? workspaceDatabaseWorker).readPath({
      absolutePath,
      path: requestedPath,
      signal: options.signal,
    }),
  );
}

export function readPreparedDatabasePage(
  requestedPath: string,
  source: PreparedWorkspaceFileRead,
  table: string,
  offset: number,
  options: DatabaseWorkerCallOptions = {},
): Promise<DatabasePageView> {
  return readPreparedPath(source, (absolutePath) =>
    (options.worker ?? workspaceDatabaseWorker).readPagePath({
      absolutePath,
      path: requestedPath,
      table,
      offset,
      signal: options.signal,
    }),
  );
}

export function readDatabaseSnapshotFromBytes(
  relativePath: string,
  bytes: Uint8Array,
  options: DatabaseWorkerCallOptions = {},
): Promise<DatabaseSnapshotView> {
  return (options.worker ?? workspaceDatabaseWorker).readBytes({
    bytes,
    path: relativePath,
    signal: options.signal,
  });
}

export function readDatabasePageFromBytes(
  relativePath: string,
  bytes: Uint8Array,
  table: string,
  offset: number,
  options: DatabaseWorkerCallOptions = {},
): Promise<DatabasePageView> {
  return (options.worker ?? workspaceDatabaseWorker).readPageBytes({
    bytes,
    path: relativePath,
    table,
    offset,
    signal: options.signal,
  });
}

async function prepareDatabaseStorage(rootPath: string, databasePath: string) {
  let directory = await resolveWorkspaceMetadataDir(rootPath);
  const slug = basename(dirname(databaseOpLogPath(databasePath)));
  // Check each folder before creating anything beneath it.
  for (const segment of ["databases", slug]) {
    directory = join(directory, segment);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await lstat(directory);
    const path = segment === "databases" ? ".dohc/databases" : `.dohc/databases/${slug}`;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(notARealFolderRefusal({ ...DOHC_DATABASES_GUARD, path }, stats));
    }
  }
  const logPath = join(directory, "operations.jsonl");
  const statePath = join(directory, "state.sqlite");
  // SQLite can open these sidecars when recovering a previous transaction.
  for (const name of ["operations.jsonl", "state.sqlite", "state.sqlite-journal", "state.sqlite-wal", "state.sqlite-shm"]) {
    try {
      const stats = await lstat(join(directory, name));
      const guard = { ...DOHC_DATABASES_GUARD, path: `.dohc/databases/${slug}/${name}` };
      if (!stats.isFile()) throw new Error(notAFileRefusal(guard, stats));
      if (stats.nlink !== 1) throw new Error(hardLinkedFileRefusal(guard));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { logPath, statePath };
}

export async function applyDatabaseEdit(
  rootPath: string,
  relativePath: string,
  edit: DatabaseEdit,
  author: ChangeAuthor,
  nowMs: number,
  options: DatabaseWorkerCallOptions & {
    createId?: () => string;
    pageOffset?: number;
  } = {},
): Promise<DatabaseEditResult> {
  if (options.signal?.aborted) throw new Error("Database edit was cancelled.");
  const { realTarget, normalized } = await resolveWorkspaceFile(
    rootPath,
    relativePath,
  );
  if (options.signal?.aborted) throw new Error("Database edit was cancelled.");
  const storage = await prepareDatabaseStorage(rootPath, normalized);
  return (options.worker ?? workspaceDatabaseWorker).editPath({
    absolutePath: realTarget,
    path: normalized,
    ...storage,
    edit,
    operation: {
      operationId: options.createId?.() ?? randomUUID(),
      databasePath: normalized,
      table: edit.table,
      op: edit.op,
      rowId: String(edit.rowId),
      payload: edit.payload ?? {},
      appliedAt: nowMs,
      author,
    },
    pageOffset: options.pageOffset,
    signal: options.signal,
  });
}

// Atomically writes bytes to a new workspace-relative path, enforcing
// path-safety and real-path containment (no traversal, no symlink escape).
// Containment is checked against the deepest existing ancestor before mkdir —
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
  const validated = validateUserMaterializePath(relativePath, { platform: process.platform });
  if (!validated.ok) {
    throw new Error(`Invalid database path (${validated.reason}): ${relativePath}`);
  }
  // "entry" because `link()` refuses
  // an existing entry rather than writing through it, so this never follows
  // the leaf. A link squatting the path then reports "already exists", which
  // is what it is, instead of a symlink refusal from a rule that does not
  // apply. The parent chain still decides the reserved rule.
  //
  // The mkdir, the staging file, and the link all run on the resolution this
  // judged, not on the spelling it was asked about.
  const { resolvedAbsolute: absolute } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: join(rootPath, validated.normalized),
    spelled: relativePath,
    label: "Database path",
    access: "entry",
  });
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
  source: { path: string; body: string },
  databaseRelativePath: string,
  tableName: string,
  options: { worker?: WorkspaceDatabaseWorkerOwner; signal?: AbortSignal } = {},
): Promise<{ path: string; tableName: string; rowCount: number; sha256: string; size: number }> {
  const mediaType = mediaTypeForPath(source.path) ?? "text/plain";

  const result = await (options.worker ?? workspaceDatabaseWorker).importData({
    name: basename(source.path),
    mediaType,
    body: source.body,
    tableName,
  }, options.signal);
  if (options.signal?.aborted) throw new Error("Database import was cancelled.");

  const path = await writeWorkspaceBytes(
    rootPath,
    databaseRelativePath,
    Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength),
  );
  return { path, tableName: result.tableName, rowCount: result.rowCount,
    sha256: createHash("sha256").update(result.bytes).digest("hex"), size: result.bytes.byteLength };
}

export function createWorkspaceDatabaseAccess(workspaceDatabaseWorker: WorkspaceDatabaseWorkerOwner) {
  function workerDatabaseReader(
    signal?: AbortSignal,
  ): OwnedWorkspaceDatabaseReader {
    return {
      readPrepared: (path, source) =>
        source.withVerifiedPath((absolutePath) =>
          workspaceDatabaseWorker.readPath({ absolutePath, path, signal }),
        ),
      readBytes: (path, bytes) =>
        workspaceDatabaseWorker.readBytes({ bytes, path, signal }),
      readPagePrepared: (path, source, table, offset) =>
        source.withVerifiedPath((absolutePath) =>
          workspaceDatabaseWorker.readPagePath({
            absolutePath,
            path,
            table,
            offset,
            signal,
          }),
        ),
      readPageBytes: (path, bytes, table, offset) =>
        workspaceDatabaseWorker.readPageBytes({
          bytes,
          path,
          table,
          offset,
          signal,
        }),
    };
  }

  async function editWorkspaceDatabaseInWorker(input: {
    rootPath: string;
    relativePath: string;
    edit: DatabaseEdit;
    author: ChangeAuthor;
    nowMs: number;
    operationId?: string;
    signal?: AbortSignal;
  }) {
    const resolved = await resolveWorkspaceFile(
      input.rootPath,
      input.relativePath,
    );
    if (input.signal?.aborted) throw new Error("Database edit was cancelled.");
    const source = await prepareWorkspaceFileRead(
      input.rootPath,
      resolved.resolvedPath,
    );
    const storage = await prepareDatabaseStorage(input.rootPath, resolved.normalized);
    return source.withVerifiedPath((absolutePath) =>
      workspaceDatabaseWorker.editPath({
        absolutePath,
        path: resolved.normalized,
        ...storage,
        edit: input.edit,
        operation: {
          operationId: input.operationId ?? randomUUID(),
          databasePath: resolved.normalized,
          table: input.edit.table,
          op: input.edit.op,
          rowId: String(input.edit.rowId),
          payload: input.edit.payload ?? {},
          appliedAt: input.nowMs,
          author: input.author,
        },
        signal: input.signal,
      }),
    );
  }

  return { workerDatabaseReader, editWorkspaceDatabaseInWorker };
}
