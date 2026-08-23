import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_STORE_BACKUP_DIR } from "../ipc/bridgeContract";
import {
  EngineStoreNotRefusedError,
  moveEngineStoreAside,
  rebuildEngineStore,
} from "./engineStoreRebuild";
import { createTestScratch } from "./testTemp";

let root: string;
let engineDir: string;
let backupDir: string;

beforeEach(async () => {
  root = join(await createTestScratch("dohc-rebuild-"), "workspace");
  engineDir = join(root, ".dohc", "engine");
  backupDir = join(root, ENGINE_STORE_BACKUP_DIR);
  await mkdir(engineDir, { recursive: true });
});

async function seedStore(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(engineDir, name), content);
  }
}

async function expectCompleteStore(): Promise<void> {
  expect((await readdir(backupDir)).sort()).toEqual([
    "MOVE_COMPLETE",
    "engine.db",
    "engine.db-shm",
    "engine.db-wal",
  ]);
  expect(await readFile(join(backupDir, "engine.db"), "utf8")).toBe(
    "refused-store",
  );
  expect(await readFile(join(backupDir, "engine.db-wal"), "utf8")).toBe("wal");
  expect(await readFile(join(backupDir, "engine.db-shm"), "utf8")).toBe("shm");
}

describe("moveEngineStoreAside", () => {
  it("moves only the database and its sidecars into a completed backup", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
      SHADOW_CLONE: "token",
    });

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    await expectCompleteStore();
    expect((await readdir(engineDir)).sort()).toEqual([
      "SHADOW_CLONE",
      "pre-v2-backup",
    ]);
  });

  it("moves a database that has no sidecars", async () => {
    await seedStore({ "engine.db": "refused-store" });

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_COMPLETE",
      "engine.db",
    ]);
  });

  it("refuses a completed backup and leaves both stores untouched", async () => {
    await seedStore({ "engine.db": "refused-store" });
    await mkdir(backupDir);
    await writeFile(join(backupDir, "engine.db"), "earlier-backup");
    await writeFile(join(backupDir, "MOVE_COMPLETE"), "");

    await expect(moveEngineStoreAside(root)).resolves.toBe("backup-exists");

    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
    expect(await readFile(join(backupDir, "engine.db"), "utf8")).toBe(
      "earlier-backup",
    );
  });

  it("refuses an unmarked path and leaves the live store untouched", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);

    await expect(moveEngineStoreAside(root)).resolves.toBe("backup-exists");

    expect((await readdir(backupDir))).toEqual([]);
    expect((await readdir(engineDir)).sort()).toEqual([
      "engine.db",
      "engine.db-shm",
      "engine.db-wal",
      "pre-v2-backup",
    ]);
  });

  it("resumes after a crash moved only SHM", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    let renames = 0;
    await expect(
      moveEngineStoreAside(root, {
        rename: async (from, to) => {
          renames += 1;
          if (renames === 2) throw new Error("host crash");
          await rename(from, to);
        },
      }),
    ).rejects.toThrow("host crash");
    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_IN_PROGRESS",
      "engine.db-shm",
    ]);

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    await expectCompleteStore();
  });

  it("resumes after a crash moved SHM and WAL", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    let renames = 0;
    await expect(
      moveEngineStoreAside(root, {
        rename: async (from, to) => {
          renames += 1;
          if (renames === 3) throw new Error("host crash");
          await rename(from, to);
        },
      }),
    ).rejects.toThrow("host crash");
    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_IN_PROGRESS",
      "engine.db-shm",
      "engine.db-wal",
    ]);

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    await expectCompleteStore();
  });

  it("resumes an in-progress reservation before any file moved", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);
    await writeFile(join(backupDir, "MOVE_IN_PROGRESS"), "");

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    await expectCompleteStore();
  });

  it("releases a fresh reservation when the first move fails", async () => {
    await seedStore({ "engine.db": "refused-store" });

    await expect(
      moveEngineStoreAside(root, {
        rename: async () => {
          throw new Error("EACCES");
        },
      }),
    ).rejects.toThrow("EACCES");

    await expect(readdir(backupDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
  });

  it("keeps a partial backup when a resumed move fails", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "wal",
    });
    await mkdir(backupDir);
    await writeFile(join(backupDir, "MOVE_IN_PROGRESS"), "");
    await writeFile(join(backupDir, "engine.db-shm"), "shm");

    await expect(
      moveEngineStoreAside(root, {
        rename: async () => {
          throw new Error("host crash");
        },
      }),
    ).rejects.toThrow("host crash");

    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_IN_PROGRESS",
      "engine.db-shm",
    ]);
  });

  it("throws when there is no database to move", async () => {
    await expect(moveEngineStoreAside(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("rebuildEngineStore", () => {
  function deps(overrides: Partial<Parameters<typeof rebuildEngineStore>[1]> = {}) {
    return {
      probeStoreRefusal: vi.fn(async () => "foreign-database" as const),
      closeActivity: vi.fn(async () => undefined),
      reopenActivity: vi.fn(async () => undefined),
      moveStoreAside: vi.fn(async () => "moved" as const),
      ...overrides,
    };
  }

  it("refuses a healthy fresh probe despite a prior refusal and reopens", async () => {
    const d = deps({ probeStoreRefusal: vi.fn(async () => null) });

    await expect(rebuildEngineStore(root, d)).rejects.toBeInstanceOf(
      EngineStoreNotRefusedError,
    );

    expect(d.closeActivity).toHaveBeenCalledOnce();
    expect(d.moveStoreAside).not.toHaveBeenCalled();
    expect(d.reopenActivity).toHaveBeenCalledOnce();
  });

  it("runs close, probe, move, and reopen in order", async () => {
    const order: string[] = [];
    const d = deps({
      closeActivity: vi.fn(async () => void order.push("close")),
      probeStoreRefusal: vi.fn(async () => {
        order.push("probe");
        return "unsupported-fingerprint" as const;
      }),
      moveStoreAside: vi.fn(async () => {
        order.push("move");
        return "moved" as const;
      }),
      reopenActivity: vi.fn(async () => void order.push("reopen")),
    });

    await expect(rebuildEngineStore(root, d)).resolves.toEqual({
      outcome: "moved",
    });
    expect(order).toEqual(["close", "probe", "move", "reopen"]);
  });

  it("attempts to reopen when close rejects", async () => {
    const closeError = new Error("stop failed");
    const d = deps({
      closeActivity: vi.fn(async () => {
        throw closeError;
      }),
    });

    await expect(rebuildEngineStore(root, d)).rejects.toBe(closeError);
    expect(d.probeStoreRefusal).not.toHaveBeenCalled();
    expect(d.moveStoreAside).not.toHaveBeenCalled();
    expect(d.reopenActivity).toHaveBeenCalledOnce();
  });

  it("preserves a completed move when reopening fails", async () => {
    const d = deps({
      reopenActivity: vi.fn(async () => {
        throw new Error("daemon did not come back");
      }),
    });

    await expect(rebuildEngineStore(root, d)).resolves.toEqual({
      outcome: "moved",
      reopenFailed:
        "dohc could not finish rebuilding this workspace's data store.",
    });
  });

  it("preserves a no-clobber outcome when reopening fails", async () => {
    const d = deps({
      moveStoreAside: vi.fn(async () => "backup-exists" as const),
      reopenActivity: vi.fn(async () => {
        throw new Error("still down");
      }),
    });

    await expect(rebuildEngineStore(root, d)).resolves.toEqual({
      outcome: "backup-exists",
      reopenFailed:
        "dohc could not finish rebuilding this workspace's data store.",
    });
  });

  it("reopens and rethrows the original move error", async () => {
    const moveError = new Error("EACCES");
    const d = deps({
      moveStoreAside: vi.fn(async () => {
        throw moveError;
      }),
      reopenActivity: vi.fn(async () => {
        throw new Error("reopen also failed");
      }),
    });

    await expect(rebuildEngineStore(root, d)).rejects.toBe(moveError);
    expect(d.reopenActivity).toHaveBeenCalledOnce();
  });
});
