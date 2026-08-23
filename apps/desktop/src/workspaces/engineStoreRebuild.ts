import type { EngineStoreRefusal } from "@dohc/workspace-engine-client";
import {
  access,
  mkdir,
  rename as renameFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ENGINE_STORE_BACKUP_DIR,
  type RebuildEngineStoreResult,
} from "../ipc/bridgeContract";

const MOVE_IN_PROGRESS = "MOVE_IN_PROGRESS";
const MOVE_COMPLETE = "MOVE_COMPLETE";

type MoveOutcome = RebuildEngineStoreResult["outcome"];

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
  if (freshReservation) {
    try {
      await writeFile(inProgressMarker, "", { flag: "wx" });
    } catch (error) {
      await rmdir(backupDir).catch(() => undefined);
      throw error;
    }
  }

  let movedAny = false;
  try {
    const liveDatabase = join(engineDir, "engine.db");
    const backupDatabase = join(backupDir, "engine.db");
    if (!(await exists(liveDatabase)) && !(await exists(backupDatabase))) {
      throw Object.assign(new Error(`ENOENT: no engine database at ${liveDatabase}`), {
        code: "ENOENT",
      });
    }

    // SHM is transient; move SHM, then the authoritative WAL, then the database.
    for (const name of ["engine.db-shm", "engine.db-wal", "engine.db"] as const) {
      const from = join(engineDir, name);
      const to = join(backupDir, name);
      if (await exists(to)) continue;
      try {
        await rename(from, to);
        movedAny = true;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        if (name === "engine.db" && !(await exists(to))) throw error;
      }
    }
    await renameFile(inProgressMarker, completeMarker);
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

export async function rebuildEngineStore(
  rootPath: string,
  deps: {
    probeStoreRefusal: () => Promise<EngineStoreRefusal | null>;
    closeActivity: () => Promise<void>;
    reopenActivity: () => Promise<void>;
    moveStoreAside: (rootPath: string) => Promise<MoveOutcome>;
  },
): Promise<RebuildEngineStoreResult> {
  let outcome: MoveOutcome | undefined;
  let operationError: unknown;
  let reopenFailed: string | undefined;

  try {
    await deps.closeActivity();
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
