import { mkdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";

// #874: recovery for an engine database the daemon refuses to open
// (`unsupported-fingerprint` / `foreign-database`). The store moves — never
// deletes — into a named folder inside the workspace, and the next open
// creates a fresh store that rebuilds from files.
//
// Workspace-relative on purpose: the UI shows this string as the reverse
// path, and a relative path names the location without embedding a username.
export const ENGINE_STORE_BACKUP_DIR = ".dohc/engine/pre-v2-backup";

export type EngineStoreMoveResult =
  | { moved: true; backupDir: string }
  | { moved: false; reason: "backup-exists"; backupDir: string };

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

// Moves `.dohc/engine/engine.db` and its `-wal`/`-shm` sidecars into
// `ENGINE_STORE_BACKUP_DIR`. Refuses — moving NOTHING — when that folder
// already exists: it holds the only copy of a store dohc already moved
// aside, and writing over it would destroy the reverse path this move
// exists to preserve.
//
// The caller must have stopped this workspace's engine activity first: a
// concurrent daemon open holds the database file, and Windows refuses to
// rename an open file.
export async function moveEngineStoreAside(
  rootPath: string,
): Promise<EngineStoreMoveResult> {
  const engineDir = join(rootPath, ".dohc", "engine");
  const backupDir = join(engineDir, "pre-v2-backup");
  // The mkdir is the no-clobber reservation: exclusive by contract, so two
  // concurrent attempts cannot both proceed.
  try {
    await mkdir(backupDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return {
        moved: false,
        reason: "backup-exists",
        backupDir: ENGINE_STORE_BACKUP_DIR,
      };
    }
    throw error;
  }
  let movedAny = false;
  try {
    // Sidecars first, database last. Each rename is atomic but the group is
    // not; if the process dies mid-move, this order leaves `engine.db` in
    // place — the workspace stays refused-but-recoverable. The other order
    // could leave a stale WAL beside a fresh database, and SQLite would
    // replay the old store's pages into it.
    for (const sidecar of ["engine.db-wal", "engine.db-shm"]) {
      try {
        await rename(join(engineDir, sidecar), join(backupDir, sidecar));
        movedAny = true;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    await rename(join(engineDir, "engine.db"), join(backupDir, "engine.db"));
  } catch (error) {
    // A failed move with nothing moved must release the reservation, or the
    // empty folder wedges every later attempt behind the no-clobber refusal.
    // Once anything moved, the folder holds real files and stays.
    if (!movedAny) await rmdir(backupDir).catch(() => undefined);
    throw error;
  }
  return { moved: true, backupDir: ENGINE_STORE_BACKUP_DIR };
}
