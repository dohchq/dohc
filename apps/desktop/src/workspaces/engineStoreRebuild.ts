import type { EngineStoreRefusal } from "@dohc/workspace-engine-client";
import type { Stats } from "node:fs";
import { z } from "zod";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename as renameFile,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ENGINE_STORE_BACKUP_DIR,
  type RebuildEngineStoreResult,
} from "../ipc/bridgeContract";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { withKeyedStartLock } from "./sitePreviewLifecycle";

const MOVE_IN_PROGRESS = "MOVE_IN_PROGRESS";
const MOVE_IN_PROGRESS_TEMP = `${MOVE_IN_PROGRESS}.tmp`;
const MOVE_COMPLETE = "MOVE_COMPLETE";
// SQLITE_SOURCE_FILES in rehearsal_harness.rs is the source of truth for names.
// Move transient SHM first, durable WAL and journal next, and the database last.
const ENGINE_STORE_FILES = [
  "engine.db-shm",
  "engine.db-wal",
  "engine.db-journal",
  "engine.db",
] as const;

type MoveOutcome = RebuildEngineStoreResult["outcome"];
type EngineStoreFileName = (typeof ENGINE_STORE_FILES)[number];
const engineStoreMoveManifestSchema = z.object({
  files: z.array(
    z.object({
      name: z.enum(ENGINE_STORE_FILES),
      size: z.number().nonnegative(),
      mtimeMs: z.number(),
    }),
  ),
});
type EngineStoreMoveManifest = z.infer<typeof engineStoreMoveManifestSchema>;
type EngineStoreMoveFileSystem = {
  lstat: (path: string) => Promise<Stats>;
  rename: typeof renameFile;
  syncDirectory: (path: string) => Promise<void>;
};
type EngineStoreMoveDependencies = Partial<EngineStoreMoveFileSystem>;

export class EngineStoreRecoveryFailedError extends Error {
  constructor(cause: unknown) {
    super(
      `dohc could not finish rebuilding this workspace's data store. Rebuild files remain at ${ENGINE_STORE_BACKUP_DIR}. Open this workspace again to retry.`,
      { cause },
    );
    this.name = "EngineStoreRecoveryFailedError";
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function statIfExists(
  path: string,
): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function lstatIfExists(
  path: string,
  fileSystem: EngineStoreMoveFileSystem,
): Promise<Stats | null> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function parseMoveManifest(contents: string): EngineStoreMoveManifest {
  const manifest = engineStoreMoveManifestSchema.parse(JSON.parse(contents));
  const names = new Set<EngineStoreFileName>();
  for (const entry of manifest.files) {
    if (names.has(entry.name)) {
      throw new Error("The engine store move manifest is invalid.");
    }
    names.add(entry.name);
  }
  return manifest;
}

async function captureMoveManifest(
  engineDir: string,
): Promise<EngineStoreMoveManifest> {
  const files: EngineStoreMoveManifest["files"] = [];
  for (const name of ENGINE_STORE_FILES) {
    const metadata = await statIfExists(join(engineDir, name));
    if (metadata) {
      files.push({ name, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }
  }
  return { files };
}

async function readMoveManifest(path: string): Promise<EngineStoreMoveManifest> {
  try {
    return parseMoveManifest(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `The recovery manifest at ${path} is unreadable or corrupt.`,
      { cause },
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    // Windows cannot fsync a directory handle the way POSIX can.
    return;
  }
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function moveFileSystem(
  deps: EngineStoreMoveDependencies,
): EngineStoreMoveFileSystem {
  return {
    lstat: deps.lstat ?? lstat,
    rename: deps.rename ?? renameFile,
    syncDirectory: deps.syncDirectory ?? syncDirectory,
  };
}

async function writeMoveManifest(
  backupDir: string,
  inProgressMarker: string,
  manifest: EngineStoreMoveManifest,
  fileSystem: EngineStoreMoveFileSystem,
): Promise<void> {
  const tempMarker = join(backupDir, MOVE_IN_PROGRESS_TEMP);
  const tempFile = await open(tempMarker, "wx");
  try {
    try {
      await tempFile.writeFile(JSON.stringify(manifest), "utf8");
      await tempFile.sync();
    } finally {
      await tempFile.close();
    }
    await fileSystem.rename(tempMarker, inProgressMarker);
  } catch (error) {
    await unlink(tempMarker).catch(() => undefined);
    throw error;
  }

  await fileSystem.syncDirectory(backupDir);
}

async function completeManifestMove(
  engineDir: string,
  backupDir: string,
  inProgressMarker: string,
  completeMarker: string,
  manifest: EngineStoreMoveManifest,
  fileSystem: EngineStoreMoveFileSystem,
  onMoved?: () => void,
): Promise<void> {
  for (const name of ENGINE_STORE_FILES) {
    const entry = manifest.files.find((candidate) => candidate.name === name);
    if (!entry) continue;
    const from = join(engineDir, entry.name);
    const to = join(backupDir, entry.name);
    if (await exists(to)) continue;

    const live = await statIfExists(from);
    if (
      live === null ||
      live.size !== entry.size ||
      live.mtimeMs !== entry.mtimeMs
    ) {
      continue;
    }

    try {
      await fileSystem.rename(from, to);
      onMoved?.();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  await fileSystem.syncDirectory(backupDir);
  await fileSystem.syncDirectory(engineDir);
  await fileSystem.rename(inProgressMarker, completeMarker);
  await fileSystem.syncDirectory(backupDir);
}

export async function completePendingEngineStoreMove(
  rootPath: string,
  deps: EngineStoreMoveDependencies = {},
): Promise<void> {
  try {
    const fileSystem = moveFileSystem(deps);
    const backupDir = join(rootPath, ENGINE_STORE_BACKUP_DIR);
    const backupEntry = await lstatIfExists(backupDir, fileSystem);
    if (backupEntry === null || !backupEntry.isDirectory()) return;
    const inProgressMarker = join(backupDir, MOVE_IN_PROGRESS);
    const completeMarker = join(backupDir, MOVE_COMPLETE);
    if ((await exists(completeMarker)) || !(await exists(inProgressMarker))) return;

    const manifest = await readMoveManifest(inProgressMarker);
    await completeManifestMove(
      join(rootPath, ".dohc", "engine"),
      backupDir,
      inProgressMarker,
      completeMarker,
      manifest,
      fileSystem,
    );
  } catch (error) {
    throw new EngineStoreRecoveryFailedError(error);
  }
}

export async function withEngineStoreRecovered<T>(
  locks: Map<string, Promise<void>>,
  workspace: Pick<CreatedWorkspace, "workspaceId" | "rootPath">,
  alreadySerialized: boolean,
  body: () => Promise<T>,
  completePendingMove: (
    rootPath: string,
  ) => Promise<void> = completePendingEngineStoreMove,
): Promise<T> {
  const recovered = async () => {
    await completePendingMove(workspace.rootPath);
    return body();
  };
  if (alreadySerialized) return recovered();
  return withKeyedStartLock(locks, workspace.workspaceId, recovered);
}

export async function moveEngineStoreAside(
  rootPath: string,
  deps: EngineStoreMoveDependencies = {},
): Promise<MoveOutcome> {
  const fileSystem = moveFileSystem(deps);
  const engineDir = join(rootPath, ".dohc", "engine");
  const backupDir = join(rootPath, ENGINE_STORE_BACKUP_DIR);
  const inProgressMarker = join(backupDir, MOVE_IN_PROGRESS);
  const completeMarker = join(backupDir, MOVE_COMPLETE);
  let freshReservation = false;

  try {
    await mkdir(backupDir);
    freshReservation = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const entry = await lstat(backupDir);
    if (!entry.isDirectory()) return "backup-exists";
    // A completed or unmarked path is not ours to overwrite.
    if ((await exists(completeMarker)) || !(await exists(inProgressMarker))) {
      return "backup-exists";
    }
  }
  let manifest: EngineStoreMoveManifest;
  if (freshReservation) {
    try {
      manifest = await captureMoveManifest(engineDir);
      if (!manifest.files.some(({ name }) => name === "engine.db")) {
        const liveDatabase = join(engineDir, "engine.db");
        throw Object.assign(
          new Error(`ENOENT: no engine database at ${liveDatabase}`),
          { code: "ENOENT" },
        );
      }
      await writeMoveManifest(
        backupDir,
        inProgressMarker,
        manifest,
        fileSystem,
      );
    } catch (error) {
      await rmdir(backupDir).catch(() => undefined);
      throw error;
    }
  } else {
    manifest = await readMoveManifest(inProgressMarker);
  }

  let movedAny = false;
  try {
    await completeManifestMove(
      engineDir,
      backupDir,
      inProgressMarker,
      completeMarker,
      manifest,
      fileSystem,
      () => {
        movedAny = true;
      },
    );
    return "moved";
  } catch (error) {
    if (freshReservation && !movedAny) {
      await unlink(inProgressMarker).catch(() => undefined);
      await rmdir(backupDir).catch(() => undefined);
    }
    throw error;
  }
}

export class EngineStoreNotRefusedError extends Error {
  constructor() {
    super("dohc can read this workspace's current data store. Nothing moved.");
    this.name = "EngineStoreNotRefusedError";
  }
}

export class EngineStoreAgentRunActiveError extends Error {
  constructor() {
    super(
      "An agent is working in this workspace. Wait for it to finish, then try again.",
    );
    this.name = "EngineStoreAgentRunActiveError";
  }
}

export class EngineStoreCloseFailedError extends Error {
  constructor(cause: unknown) {
    super(
      "dohc could not finish closing this workspace's data store. Nothing moved. Try again.",
      { cause },
    );
    this.name = "EngineStoreCloseFailedError";
  }
}

export interface RebuildEngineStoreDependencies {
  probeStoreRefusal: () => Promise<EngineStoreRefusal | null>;
  closeActivity: () => Promise<void>;
  reopenActivity: () => Promise<void>;
  moveStoreAside: (rootPath: string) => Promise<MoveOutcome>;
}

export async function rebuildEngineStore(
  rootPath: string,
  deps: RebuildEngineStoreDependencies,
): Promise<RebuildEngineStoreResult> {
  try {
    await deps.closeActivity();
  } catch (error) {
    throw new EngineStoreCloseFailedError(error);
  }

  let outcome: MoveOutcome | undefined;
  let moveAttempted = false;
  let operationError: unknown;
  let reopenError: unknown;

  try {
    if ((await deps.probeStoreRefusal()) === null) {
      throw new EngineStoreNotRefusedError();
    }
    moveAttempted = true;
    outcome = await deps.moveStoreAside(rootPath);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await deps.reopenActivity();
    } catch (error) {
      reopenError = error;
    }
  }

  if (operationError !== undefined) {
    const moveCompleted =
      moveAttempted &&
      (await exists(join(rootPath, ENGINE_STORE_BACKUP_DIR, MOVE_COMPLETE)));
    if (!moveCompleted) throw operationError;
    console.error(
      "The engine store move reported an error, but reopening completed the move.",
      operationError,
    );
    outcome = "moved";
  }
  if (outcome === undefined) {
    throw new Error("The data store rebuild finished without an outcome.");
  }
  const reopenFailed =
    reopenError === undefined
      ? undefined
      : reopenError instanceof EngineStoreRecoveryFailedError
        ? reopenError.message
        : "dohc could not finish rebuilding this workspace's data store.";
  return { outcome, ...(reopenFailed ? { reopenFailed } : {}) };
}

export async function rebuildEngineStoreRequest(
  rootPath: string,
  deps: RebuildEngineStoreDependencies & {
    isStoreRefused: () => boolean;
    hasActiveAgentRun: () => boolean;
    previousResult: () => RebuildEngineStoreResult | undefined;
    rememberResult: (result: RebuildEngineStoreResult) => void;
  },
): Promise<RebuildEngineStoreResult> {
  const previousResult = deps.previousResult();
  if (!deps.isStoreRefused()) {
    if (previousResult) return previousResult;
    throw new EngineStoreNotRefusedError();
  }
  if (deps.hasActiveAgentRun()) {
    throw new EngineStoreAgentRunActiveError();
  }

  try {
    const result = await rebuildEngineStore(rootPath, deps);
    deps.rememberResult(result);
    return result;
  } catch (error) {
    if (error instanceof EngineStoreNotRefusedError && previousResult) {
      return previousResult;
    }
    throw error;
  }
}
