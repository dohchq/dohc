import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceFile } from "./workspaceAssets";

export interface DatabaseImportRecord {
  operationId: string;
  workspaceId: string;
  path: string;
  sha256: string;
  size: number;
}

export async function assertDatabaseImportFile(root: string, record: DatabaseImportRecord) {
  const missing = () => new Error(`Cannot undo this import. ${record.path} is no longer here. Import the CSV again if you need the database.`);
  const entry = await lstat(join(root, record.path)).catch(error => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing();
    throw error;
  });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Cannot undo this import. ${record.path} is no longer the imported file. Keep it or delete it yourself.`);
  }
  return entry;
}

/** Checks bytes without opening SQLite or creating a journal. Caller holds the workspace lock. */
export async function assertDatabaseImportUnchanged(root: string, record: DatabaseImportRecord): Promise<void> {
  const entry = await assertDatabaseImportFile(root, record);
  const { realTarget } = await resolveWorkspaceFile(root, record.path);
  const changed = () => new Error(`Cannot undo this import. ${record.path} changed after the import. Keep it or delete it yourself.`);
  if (entry.size !== record.size) throw changed();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(realTarget)) hash.update(chunk);
  if (hash.digest("hex") !== record.sha256) throw changed();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await lstat(realTarget + suffix).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (sidecar) throw new Error(`Cannot undo this import. ${record.path}${suffix} exists. Close programs using the database, then try again.`);
  }
}
