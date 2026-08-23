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
  rmdir: typeof rmdir;
  syncDirectory: (path: string) => Promise<void>;
  unlink: typeof unlink;
};
type EngineStoreMoveDependencies = Partial<EngineStoreMoveFileSystem>;
type EngineStoreRecoveryDependencies = EngineStoreMoveDependencies & {
  rebuildGate?: {
    begin: () => void;
    end: () => void;
  };
};

class EngineStoreManifestDriftError extends Error {
  constructor(path: string, cause?: unknown) {
    super(
      `The data store file at ${path} changed or disappeared during the rebuild.`,
      { cause },
    );
    this.name = "EngineStoreManifestDriftError";
  }
}

export class EngineStoreRecoveryFailedError extends Error {
  constructor(cause: unknown) {
    const driftDetail =
      cause instanceof EngineStoreManifestDriftError ? ` ${cause.message}` : "";
    super(
      `dohc could not finish rebuilding this workspace's data store.${driftDetail} Rebuild files remain at ${ENGINE_STORE_BACKUP_DIR}. Open this workspace again to retry.`,
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

function matchesManifestEntry(
  metadata: Stats | null,
  entry: EngineStoreMoveManifest["files"][number],
): boolean {
  return (
    metadata !== null &&
    metadata.isFile() &&
    metadata.size === entry.size &&
    metadata.mtimeMs === entry.mtimeMs
  );
}

async function scanEngineStoreFiles(
  engineDir: string,
  fileSystem: EngineStoreMoveFileSystem,
): Promise<Map<EngineStoreFileName, Stats | null>> {
  const files = new Map<EngineStoreFileName, Stats | null>();
  for (const name of ENGINE_STORE_FILES) {
    const path = join(engineDir, name);
    const metadata = await lstatIfExists(path, fileSystem);
    if (metadata !== null && !metadata.isFile()) {
      throw new EngineStoreManifestDriftError(path);
    }
    files.set(name, metadata);
  }
  return files;
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
  fileSystem: EngineStoreMoveFileSystem,
): Promise<EngineStoreMoveManifest> {
  const scan = await scanEngineStoreFiles(engineDir, fileSystem);
  return {
    files: ENGINE_STORE_FILES.flatMap((name) => {
      const metadata = scan.get(name);
      return metadata
        ? [{ name, size: metadata.size, mtimeMs: metadata.mtimeMs }]
        : [];
    }),
  };
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
    rmdir: deps.rmdir ?? rmdir,
    syncDirectory: deps.syncDirectory ?? syncDirectory,
    unlink: deps.unlink ?? unlink,
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
    await fileSystem.unlink(tempMarker).catch(() => undefined);
    throw error;
  }

  await fileSystem.syncDirectory(backupDir);
}

async function assertNoUnlistedStoreFiles(
  engineDir: string,
  manifest: EngineStoreMoveManifest,
  fileSystem: EngineStoreMoveFileSystem,
): Promise<void> {
  const listedNames = new Set(manifest.files.map(({ name }) => name));
  const scan = await scanEngineStoreFiles(engineDir, fileSystem);
  for (const [name, metadata] of scan) {
    if (metadata !== null && !listedNames.has(name)) {
      throw new EngineStoreManifestDriftError(join(engineDir, name));
    }
  }
}

async function assertEngineDirHasNoStoreFiles(
  engineDir: string,
  fileSystem: EngineStoreMoveFileSystem,
): Promise<void> {
  const scan = await scanEngineStoreFiles(engineDir, fileSystem);
  const remaining = ENGINE_STORE_FILES.find((name) => scan.get(name) !== null);
  if (remaining !== undefined) {
    throw new EngineStoreManifestDriftError(join(engineDir, remaining));
  }
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
  await assertNoUnlistedStoreFiles(engineDir, manifest, fileSystem);
  for (const name of ENGINE_STORE_FILES) {
    const entry = manifest.files.find((candidate) => candidate.name === name);
    if (!entry) continue;
    const from = join(engineDir, entry.name);
    const to = join(backupDir, entry.name);
    const backup = await lstatIfExists(to, fileSystem);
    if (backup !== null) {
      if (!matchesManifestEntry(backup, entry)) {
        throw new EngineStoreManifestDriftError(to);
      }
      const duplicate = await lstatIfExists(from, fileSystem);
      if (duplicate === null) continue;
      if (!matchesManifestEntry(duplicate, entry)) {
        throw new EngineStoreManifestDriftError(from);
      }
      await fileSystem.unlink(from);
      continue;
    }

    const live = await lstatIfExists(from, fileSystem);
    if (live === null || !matchesManifestEntry(live, entry)) {
      throw new EngineStoreManifestDriftError(from);
    }

    try {
      await fileSystem.rename(from, to);
      onMoved?.();
      const moved = await lstatIfExists(to, fileSystem);
      if (
        moved === null ||
        !moved.isFile() ||
        moved.size !== live.size ||
        moved.mtimeMs !== live.mtimeMs
      ) {
        throw new EngineStoreManifestDriftError(to);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new EngineStoreManifestDriftError(from, error);
      }
      throw error;
    }
  }
  await fileSystem.syncDirectory(backupDir);
  await fileSystem.syncDirectory(engineDir);
  await assertEngineDirHasNoStoreFiles(engineDir, fileSystem);
  // The final rescan cannot exclude a process outside dohc's control. If such a
  // process creates a store file in the gap before this rename, no later open
  // will detect it because MOVE_COMPLETE is terminal.
  await fileSystem.rename(inProgressMarker, completeMarker);
  await fileSystem.syncDirectory(backupDir);
}

export async function completePendingEngineStoreMove(
  rootPath: string,
  deps: EngineStoreRecoveryDependencies = {},
): Promise<void> {
  try {
    const fileSystem = moveFileSystem(deps);
    const backupDir = join(rootPath, ENGINE_STORE_BACKUP_DIR);
    const backupEntry = await lstatIfExists(backupDir, fileSystem);
    if (backupEntry === null || !backupEntry.isDirectory()) return;
    const inProgressMarker = join(backupDir, MOVE_IN_PROGRESS);
    const completeMarker = join(backupDir, MOVE_COMPLETE);
    if ((await exists(completeMarker)) || !(await exists(inProgressMarker))) return;

    deps.rebuildGate?.begin();
    const manifest = await readMoveManifest(inProgressMarker);
    await completeManifestMove(
      join(rootPath, ".dohc", "engine"),
      backupDir,
      inProgressMarker,
      completeMarker,
      manifest,
      fileSystem,
    );
    deps.rebuildGate?.end();
  } catch (error) {
    throw new EngineStoreRecoveryFailedError(error);
  }
}

export async function withEngineStoreRecovered<T>(
  locks: Map<string, Promise<void>>,
  workspace: Pick<CreatedWorkspace, "workspaceId" | "rootPath">,
  body: () => Promise<T>,
  completePendingMove: (
    rootPath: string,
  ) => Promise<void> = completePendingEngineStoreMove,
): Promise<T> {
  return withKeyedStartLock(locks, workspace.workspaceId, () =>
    withEngineStoreRecoveredUnderEngineStoreLock(
      workspace,
      body,
      completePendingMove,
    ),
  );
}

export async function withEngineStoreRecoveredUnderEngineStoreLock<T>(
  workspace: Pick<CreatedWorkspace, "rootPath">,
  body: () => Promise<T>,
  completePendingMove: (
    rootPath: string,
  ) => Promise<void> = completePendingEngineStoreMove,
): Promise<T> {
  await completePendingMove(workspace.rootPath);
  return body();
}

async function throwAfterReservationCleanup(
  engineDir: string,
  backupDir: string,
  inProgressMarker: string,
  triggeringError: unknown,
  fileSystem: EngineStoreMoveFileSystem,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const path of [
    join(backupDir, MOVE_IN_PROGRESS_TEMP),
    inProgressMarker,
  ]) {
    try {
      await fileSystem.unlink(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") cleanupErrors.push(error);
    }
  }
  try {
    await fileSystem.rmdir(backupDir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") cleanupErrors.push(error);
  }
  try {
    await fileSystem.syncDirectory(engineDir);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length === 0) throw triggeringError;
  throw new AggregateError(
    [triggeringError, ...cleanupErrors],
    "The data store move failed, and dohc could not remove its unused rebuild reservation.",
    { cause: triggeringError },
  );
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
    const entry = await fileSystem.lstat(backupDir);
    if (!entry.isDirectory()) return "backup-exists";
    // A completed or unmarked path is not ours to overwrite.
    if ((await exists(completeMarker)) || !(await exists(inProgressMarker))) {
      return "backup-exists";
    }
  }
  let manifest: EngineStoreMoveManifest;
  if (freshReservation) {
    try {
      manifest = await captureMoveManifest(engineDir, fileSystem);
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
      await fileSystem.syncDirectory(engineDir);
    } catch (error) {
      await throwAfterReservationCleanup(
        engineDir,
        backupDir,
        inProgressMarker,
        error,
        fileSystem,
      );
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
      await throwAfterReservationCleanup(
        engineDir,
        backupDir,
        inProgressMarker,
        error,
        fileSystem,
      );
    }
    throw error;
  }
}

type EngineStoreRebuildRequestFailure =
  | "not-refused"
  | "agent-run-active"
  | "close-failed";

const engineStoreRebuildRequestMessages: Record<
  EngineStoreRebuildRequestFailure,
  string
> = {
  "not-refused":
    "dohc can read this workspace's current data store. Nothing moved.",
  "agent-run-active":
    "An agent is working in this workspace. Wait for it to finish, then try again.",
  "close-failed":
    "dohc could not finish closing this workspace's data store. Nothing moved. Try again.",
};

export class EngineStoreRebuildRequestError extends Error {
  readonly reason: EngineStoreRebuildRequestFailure;

  constructor(reason: EngineStoreRebuildRequestFailure, cause?: unknown) {
    super(
      engineStoreRebuildRequestMessages[reason],
      cause === undefined ? undefined : { cause },
    );
    this.name = "EngineStoreRebuildRequestError";
    this.reason = reason;
  }
}

export interface RebuildEngineStoreDependencies {
  probeStoreRefusal: () => Promise<EngineStoreRefusal | null>;
  closeActivity: () => Promise<void>;
  reopenActivity: () => Promise<void>;
  moveStoreAside: (rootPath: string) => Promise<MoveOutcome>;
  rebuildGate: { begin: () => void; end: () => void };
}

export async function rebuildEngineStore(
  rootPath: string,
  deps: RebuildEngineStoreDependencies,
): Promise<RebuildEngineStoreResult> {
  try {
    await deps.closeActivity();
  } catch (error) {
    throw new EngineStoreRebuildRequestError("close-failed", error);
  }

  let outcome: MoveOutcome | undefined;
  let moveAttempted = false;
  let operationError: unknown;
  let reopenError: unknown;

  try {
    if ((await deps.probeStoreRefusal()) === null) {
      throw new EngineStoreRebuildRequestError("not-refused");
    }
    moveAttempted = true;
    deps.rebuildGate.begin();
    outcome = await deps.moveStoreAside(rootPath);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await deps.reopenActivity();
    } catch (error) {
      reopenError = error;
    }
    if (!(reopenError instanceof EngineStoreRecoveryFailedError)) {
      deps.rebuildGate.end();
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
  if (
    reopenError !== undefined &&
    !(reopenError instanceof EngineStoreRecoveryFailedError)
  ) {
    console.error(
      "The engine store could not reopen after the rebuild.",
      reopenError,
    );
  }
  const reopenFailed =
    reopenError === undefined
      ? undefined
      : reopenError instanceof EngineStoreRecoveryFailedError
        ? reopenError.message
        : "dohc could not finish rebuilding this workspace's data store.";
  return {
    outcome,
    ...(reopenFailed ? { reopenFailed } : {}),
  };
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
    throw new EngineStoreRebuildRequestError("not-refused");
  }
  if (deps.hasActiveAgentRun()) {
    throw new EngineStoreRebuildRequestError("agent-run-active");
  }

  try {
    const result = await rebuildEngineStore(rootPath, deps);
    deps.rememberResult(result);
    return result;
  } catch (error) {
    if (
      error instanceof EngineStoreRebuildRequestError &&
      error.reason === "not-refused" &&
      previousResult
    ) {
      return previousResult;
    }
    throw error;
  }
}
