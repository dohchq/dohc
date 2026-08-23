import type { EngineStoreRefusal } from "@dohc/workspace-engine-client";
import type { Stats } from "node:fs";
import { z } from "zod";
import {
  access,
  mkdir,
  readFile,
  rename as renameFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ENGINE_STORE_BACKUP_DIR,
  type RebuildEngineStoreResult,
} from "../ipc/bridgeContract";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { withKeyedStartLock } from "./sitePreviewLifecycle";

const MOVE_IN_PROGRESS = "MOVE_IN_PROGRESS";
const MOVE_COMPLETE = "MOVE_COMPLETE";
const ENGINE_STORE_FILES = [
  "engine.db-shm",
  "engine.db-wal",
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
  return parseMoveManifest(await readFile(path, "utf8"));
}

async function completeManifestMove(
  engineDir: string,
  backupDir: string,
  inProgressMarker: string,
  completeMarker: string,
  manifest: EngineStoreMoveManifest,
  rename: typeof renameFile,
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
      await rename(from, to);
      onMoved?.();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  await rename(inProgressMarker, completeMarker);
}

export async function completePendingEngineStoreMove(
  rootPath: string,
  deps: { rename?: typeof renameFile } = {},
): Promise<void> {
  try {
    const backupDir = join(rootPath, ENGINE_STORE_BACKUP_DIR);
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
      deps.rename ?? renameFile,
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
  if (alreadySerialized) return body();
  return withKeyedStartLock(locks, workspace.workspaceId, async () => {
    await completePendingMove(workspace.rootPath);
    return body();
  });
}

export async function moveEngineStoreAside(
  rootPath: string,
  deps: { rename?: typeof renameFile } = {},
): Promise<MoveOutcome> {
  const rename = deps.rename ?? renameFile;
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
      await writeFile(inProgressMarker, JSON.stringify(manifest), {
        flag: "wx",
      });
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
      rename,
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
  let operationError: unknown;
  let reopenFailed: string | undefined;

  try {
    if ((await deps.probeStoreRefusal()) === null) {
      throw new EngineStoreNotRefusedError();
    }
    outcome = await deps.moveStoreAside(rootPath);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await deps.reopenActivity();
    } catch {
      if (outcome) {
        reopenFailed =
          "dohc could not finish rebuilding this workspace's data store.";
      }
    }
  }

  if (operationError !== undefined) throw operationError;
  if (outcome === undefined) {
    throw new Error("The data store rebuild finished without an outcome.");
  }
  return { outcome, ...(reopenFailed ? { reopenFailed } : {}) };
}

export async function rebuildEngineStoreRequest(
  rootPath: string,
  deps: RebuildEngineStoreDependencies & {
    isStoreRefused: () => boolean;
    previousResult: () => RebuildEngineStoreResult | undefined;
    rememberResult: (result: RebuildEngineStoreResult) => void;
  },
): Promise<RebuildEngineStoreResult> {
  const previousResult = deps.previousResult();
  if (!deps.isStoreRefused()) {
    if (previousResult) return previousResult;
    throw new EngineStoreNotRefusedError();
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
