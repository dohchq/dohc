import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ENGINE_STORE_BACKUP_DIR,
  moveEngineStoreAside,
} from "./engineStoreRebuild";
import { createTestScratch } from "./testTemp";

let root: string;
let engineDir: string;

beforeEach(async () => {
  root = join(await createTestScratch("dohc-rebuild-"), "workspace");
  engineDir = join(root, ".dohc", "engine");
  await mkdir(engineDir, { recursive: true });
});

describe("moveEngineStoreAside", () => {
  // #874: the recovery for a store the engine refuses. The database and its
  // sidecars move into a NAMED backup folder inside the workspace — the
  // reverse path the success copy shows — and nothing else in .dohc/engine
  // moves with them.
  it("moves the database and its sidecars into the named backup folder", async () => {
    await writeFile(join(engineDir, "engine.db"), "refused-store");
    await writeFile(join(engineDir, "engine.db-wal"), "wal");
    await writeFile(join(engineDir, "engine.db-shm"), "shm");
    await writeFile(join(engineDir, "SHADOW_CLONE"), "token");

    const result = await moveEngineStoreAside(root);

    expect(result).toEqual({ moved: true, backupDir: ENGINE_STORE_BACKUP_DIR });
    expect(ENGINE_STORE_BACKUP_DIR).toBe(".dohc/engine/pre-v2-backup");
    const backupDir = join(engineDir, "pre-v2-backup");
    expect(await readFile(join(backupDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
    expect(await readFile(join(backupDir, "engine.db-wal"), "utf8")).toBe("wal");
    expect(await readFile(join(backupDir, "engine.db-shm"), "utf8")).toBe("shm");
    // The store is GONE from the live location (a fresh open rebuilds from
    // files), and the shadow marker stays where the engine expects it.
    expect((await readdir(engineDir)).sort()).toEqual([
      "SHADOW_CLONE",
      "pre-v2-backup",
    ]);
  });

  it("moves a database that has no sidecars", async () => {
    await writeFile(join(engineDir, "engine.db"), "refused-store");

    const result = await moveEngineStoreAside(root);

    expect(result).toEqual({ moved: true, backupDir: ENGINE_STORE_BACKUP_DIR });
    expect(
      await readFile(join(engineDir, "pre-v2-backup", "engine.db"), "utf8"),
    ).toBe("refused-store");
  });

  // No clobber: an existing backup is the only copy of a store dohc already
  // moved aside. The refusal leaves EVERYTHING in place — the live store, the
  // old backup — and names the folder so the user can move it away.
  it("refuses when the backup folder already exists and moves nothing", async () => {
    await writeFile(join(engineDir, "engine.db"), "refused-store");
    await mkdir(join(engineDir, "pre-v2-backup"));
    await writeFile(
      join(engineDir, "pre-v2-backup", "engine.db"),
      "earlier-backup",
    );

    const result = await moveEngineStoreAside(root);

    expect(result).toEqual({
      moved: false,
      reason: "backup-exists",
      backupDir: ENGINE_STORE_BACKUP_DIR,
    });
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
    expect(
      await readFile(join(engineDir, "pre-v2-backup", "engine.db"), "utf8"),
    ).toBe("earlier-backup");
  });

  it("throws when there is no database to move", async () => {
    await expect(moveEngineStoreAside(root)).rejects.toThrow();
    // The failed attempt must not leave a claimed-but-empty backup folder
    // wedging the next attempt behind the no-clobber refusal.
    expect(await readdir(engineDir)).toEqual([]);
  });
});
