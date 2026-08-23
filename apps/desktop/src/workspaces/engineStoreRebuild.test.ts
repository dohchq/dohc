import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EngineWorkspaceRebuildingError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import { ENGINE_STORE_BACKUP_DIR } from "../ipc/bridgeContract";
import {
  completePendingEngineStoreMove,
  EngineStoreCloseFailedError,
  EngineStoreNotRefusedError,
  EngineStoreRecoveryFailedError,
  moveEngineStoreAside,
  rebuildEngineStore,
  rebuildEngineStoreRequest,
  withEngineStoreRecovered,
} from "./engineStoreRebuild";
import { withKeyedStartLock } from "./sitePreviewLifecycle";
import { createWorkspaceActivity } from "./workspaceActivity";
import { createWorkspaceChatLifecycle } from "./workspaceChatLifecycle";
import { createTestScratch } from "./testTemp";

const engineStoreRebuildSource = readFileSync(
  new URL("./engineStoreRebuild.ts", import.meta.url),
  "utf8",
);
const rehearsalHarnessSource = readFileSync(
  new URL(
    "../../../../crates/dohc-workspace-engine/src/rehearsal_harness.rs",
    import.meta.url,
  ),
  "utf8",
);

function stringLiteralsInArray(source: string, name: string): string[] {
  const match = new RegExp(
    `const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?;`,
  ).exec(source);
  if (!match) throw new Error(`Could not find ${name}.`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

let root: string;
let engineDir: string;
let backupDir: string;

interface TestMoveManifest {
  files: Array<{ name: string; size: number; mtimeMs: number }>;
}

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

async function writeMoveManifest(names: string[]): Promise<void> {
  const files = await Promise.all(
    names.map(async (name) => {
      const metadata = await stat(join(engineDir, name));
      return { name, size: metadata.size, mtimeMs: metadata.mtimeMs };
    }),
  );
  await writeFile(
    join(backupDir, "MOVE_IN_PROGRESS"),
    JSON.stringify({ files }),
  );
}

async function readMoveManifest(): Promise<TestMoveManifest> {
  return JSON.parse(
    await readFile(join(backupDir, "MOVE_IN_PROGRESS"), "utf8"),
  ) as TestMoveManifest;
}

async function expectCompleteStore(): Promise<void> {
  expect((await readdir(backupDir)).sort()).toEqual([
    "MOVE_COMPLETE",
    "engine.db",
    "engine.db-journal",
    "engine.db-shm",
    "engine.db-wal",
  ]);
  expect(await readFile(join(backupDir, "engine.db"), "utf8")).toBe(
    "refused-store",
  );
  expect(await readFile(join(backupDir, "engine.db-journal"), "utf8")).toBe(
    "journal",
  );
  expect(await readFile(join(backupDir, "engine.db-wal"), "utf8")).toBe("wal");
  expect(await readFile(join(backupDir, "engine.db-shm"), "utf8")).toBe("shm");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("moveEngineStoreAside", () => {
  it("keeps the TypeScript store files in sync with the Rust source list", () => {
    expect(
      new Set(
        stringLiteralsInArray(engineStoreRebuildSource, "ENGINE_STORE_FILES"),
      ),
    ).toEqual(
      new Set(
        stringLiteralsInArray(rehearsalHarnessSource, "SQLITE_SOURCE_FILES"),
      ),
    );
  });

  it("moves only the database and its sidecars into a completed backup", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
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

  it("publishes a complete manifest before moving any store file", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    let renames = 0;

    await expect(
      moveEngineStoreAside(root, {
        rename: async (from, to) => {
          renames += 1;
          await rename(from, to);
          if (renames === 1) {
            expect(from).toBe(join(backupDir, "MOVE_IN_PROGRESS.tmp"));
            expect(to).toBe(join(backupDir, "MOVE_IN_PROGRESS"));
            expect(
              (await readMoveManifest()).files.map(({ name }) => name),
            ).toEqual([
              "engine.db-shm",
              "engine.db-wal",
              "engine.db-journal",
              "engine.db",
            ]);
          }
        },
      }),
    ).resolves.toBe("moved");

    expect(renames).toBe(6);
    await expectCompleteStore();
  });

  it("flushes moved files and the completion marker before returning", async () => {
    await seedStore({ "engine.db": "refused-store" });
    const events: string[] = [];

    const outcome = await moveEngineStoreAside(root, {
      rename: async (from, to) => {
        await rename(from, to);
        events.push(`rename:${from}->${to}`);
      },
      syncDirectory: async (path) => {
        events.push(`sync:${path}`);
      },
    });
    events.push(`return:${outcome}`);

    expect(events).toEqual([
      `rename:${join(backupDir, "MOVE_IN_PROGRESS.tmp")}->${join(backupDir, "MOVE_IN_PROGRESS")}`,
      `sync:${backupDir}`,
      `rename:${join(engineDir, "engine.db")}->${join(backupDir, "engine.db")}`,
      `sync:${engineDir}`,
      `sync:${backupDir}`,
      `rename:${join(backupDir, "MOVE_IN_PROGRESS")}->${join(backupDir, "MOVE_COMPLETE")}`,
      `sync:${backupDir}`,
      "return:moved",
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

  it("moves a rollback journal beside its database", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
    });

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_COMPLETE",
      "engine.db",
      "engine.db-journal",
    ]);
    expect(await readFile(join(backupDir, "engine.db-journal"), "utf8")).toBe(
      "journal",
    );
    expect(await readdir(engineDir)).not.toContain("engine.db-journal");
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
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);

    await expect(moveEngineStoreAside(root)).resolves.toBe("backup-exists");

    expect((await readdir(backupDir))).toEqual([]);
    expect((await readdir(engineDir)).sort()).toEqual([
      "engine.db",
      "engine.db-journal",
      "engine.db-shm",
      "engine.db-wal",
      "pre-v2-backup",
    ]);
  });

  it("refuses a file at the backup path and leaves the live store untouched", async () => {
    await seedStore({ "engine.db": "refused-store", "engine.db-wal": "wal" });
    await writeFile(backupDir, "occupied");

    await expect(moveEngineStoreAside(root)).resolves.toBe("backup-exists");

    expect((await lstat(backupDir)).isFile()).toBe(true);
    expect(await readFile(backupDir, "utf8")).toBe("occupied");
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
    expect(await readFile(join(engineDir, "engine.db-wal"), "utf8")).toBe(
      "wal",
    );
    expect((await readdir(engineDir)).sort()).toEqual([
      "engine.db",
      "engine.db-wal",
      "pre-v2-backup",
    ]);
  });

  it("refuses a symlink at the backup path without following it", async () => {
    await seedStore({ "engine.db": "refused-store" });
    const target = join(root, "other-backup");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "untouched");
    await symlink(
      target,
      backupDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeMoveManifest(["engine.db"]);
    const marker = await readFile(join(target, "MOVE_IN_PROGRESS"), "utf8");

    await expect(moveEngineStoreAside(root)).resolves.toBe("backup-exists");

    expect((await lstat(backupDir)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("untouched");
    expect(await readFile(join(target, "MOVE_IN_PROGRESS"), "utf8")).toBe(
      marker,
    );
    expect((await readdir(target)).sort()).toEqual([
      "MOVE_IN_PROGRESS",
      "sentinel",
    ]);
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
    expect((await readdir(engineDir)).sort()).toEqual([
      "engine.db",
      "pre-v2-backup",
    ]);
  });

  it("refuses a reservation that has only an unpublished manifest", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);
    await writeFile(join(backupDir, "MOVE_IN_PROGRESS.tmp"), "partial");

    await expect(moveEngineStoreAside(root)).resolves.toBe("backup-exists");

    expect(await readdir(backupDir)).toEqual(["MOVE_IN_PROGRESS.tmp"]);
    expect((await readdir(engineDir)).sort()).toEqual([
      "engine.db",
      "engine.db-journal",
      "engine.db-shm",
      "engine.db-wal",
      "pre-v2-backup",
    ]);
  });

  it("resumes after a crash moved only SHM", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
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
    ]);
    const manifest = await readMoveManifest();
    expect(manifest.files.map(({ name }) => name)).toEqual([
      "engine.db-shm",
      "engine.db-wal",
      "engine.db-journal",
      "engine.db",
    ]);
    expect(manifest.files.every(({ size }) => Number.isFinite(size))).toBe(true);
    expect(manifest.files.every(({ mtimeMs }) => Number.isFinite(mtimeMs))).toBe(
      true,
    );

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    await expectCompleteStore();
  });

  it("resumes after a crash moved SHM and WAL", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    let renames = 0;
    await expect(
      moveEngineStoreAside(root, {
        rename: async (from, to) => {
          renames += 1;
          if (renames === 4) throw new Error("host crash");
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

  it("resumes after a crash moved a rollback journal but not its database", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
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
      "engine.db-journal",
    ]);
    expect((await readdir(engineDir)).sort()).toEqual([
      "engine.db",
      "pre-v2-backup",
    ]);

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_COMPLETE",
      "engine.db",
      "engine.db-journal",
    ]);
    expect(await readFile(join(backupDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
    expect(await readFile(join(backupDir, "engine.db-journal"), "utf8")).toBe(
      "journal",
    );
    expect(await readdir(engineDir)).not.toContain("engine.db-journal");
  });

  it("resumes an in-progress reservation before any file moved", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);
    await writeMoveManifest([
      "engine.db-shm",
      "engine.db-wal",
      "engine.db-journal",
      "engine.db",
    ]);

    await expect(moveEngineStoreAside(root)).resolves.toBe("moved");

    await expectCompleteStore();
  });

  it("releases a fresh reservation when the first move fails", async () => {
    await seedStore({ "engine.db": "refused-store" });
    let renames = 0;

    await expect(
      moveEngineStoreAside(root, {
        rename: async (from, to) => {
          renames += 1;
          if (renames === 2) throw new Error("EACCES");
          await rename(from, to);
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
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);
    await writeMoveManifest([
      "engine.db-shm",
      "engine.db-wal",
      "engine.db-journal",
      "engine.db",
    ]);
    await rename(
      join(engineDir, "engine.db-shm"),
      join(backupDir, "engine.db-shm"),
    );

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

  it("completes a move after the database rename crashes before the marker rename", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    let renames = 0;
    await expect(
      moveEngineStoreAside(root, {
        rename: async (from, to) => {
          renames += 1;
          if (renames === 6) throw new Error("host crash");
          await rename(from, to);
        },
      }),
    ).rejects.toThrow("host crash");
    expect(await readdir(engineDir)).toEqual(["pre-v2-backup"]);
    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_IN_PROGRESS",
      "engine.db",
      "engine.db-journal",
      "engine.db-shm",
      "engine.db-wal",
    ]);

    await completePendingEngineStoreMove(root);

    await expectCompleteStore();
  });

  it("names an unreadable recovery manifest and rejects once", async () => {
    await mkdir(backupDir);
    const manifestPath = join(backupDir, "MOVE_IN_PROGRESS");
    await writeFile(manifestPath, '{"files":[');

    const recovery = completePendingEngineStoreMove(root);

    await expect(recovery).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: `The recovery manifest at ${manifestPath} is unreadable or corrupt.`,
        cause: expect.any(SyntaxError),
      }),
    });
  });

  it("leaves a new sidecar omitted from the manifest at the live location", async () => {
    await seedStore({ "engine.db": "refused-store" });
    await mkdir(backupDir);
    await writeMoveManifest(["engine.db"]);
    await rename(join(engineDir, "engine.db"), join(backupDir, "engine.db"));
    await writeFile(join(engineDir, "engine.db-wal"), "new-wal");

    await completePendingEngineStoreMove(root);

    expect(await readFile(join(engineDir, "engine.db-wal"), "utf8")).toBe(
      "new-wal",
    );
    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_COMPLETE",
      "engine.db",
    ]);
  });

  it("leaves a same-name live file whose identity does not match the manifest", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-wal": "old-wal",
    });
    await mkdir(backupDir);
    await writeMoveManifest(["engine.db-wal", "engine.db"]);
    await rename(join(engineDir, "engine.db"), join(backupDir, "engine.db"));
    await writeFile(join(engineDir, "engine.db-wal"), "different-new-wal");

    await completePendingEngineStoreMove(root);

    expect(await readFile(join(engineDir, "engine.db-wal"), "utf8")).toBe(
      "different-new-wal",
    );
    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_COMPLETE",
      "engine.db",
    ]);
  });

  it("rejects an open before activity starts when pending-move recovery fails", async () => {
    await seedStore({ "engine.db": "refused-store" });
    await mkdir(backupDir);
    await writeMoveManifest(["engine.db"]);
    const workspace = {
      workspaceId: "workspace",
      rootPath: root,
      kind: "personal" as const,
      mode: "local-first" as const,
    };
    const activity = createWorkspaceActivity(() => {});
    const openActivity = vi.fn(() => activity.open(workspace));
    const lifecycle = createWorkspaceChatLifecycle({
      isReadOnly: () => false,
      maintain: async () => undefined,
      onError: vi.fn(),
    });
    const renameError = new Error("rename denied");

    const opening = lifecycle.open(workspace, () =>
      withEngineStoreRecovered(
        new Map(),
        workspace,
        false,
        openActivity,
        (rootPath) =>
          completePendingEngineStoreMove(rootPath, {
            rename: async () => {
              throw renameError;
            },
          }),
      ),
    );

    try {
      await expect(opening).rejects.toBeInstanceOf(EngineStoreRecoveryFailedError);
      await expect(opening).rejects.toMatchObject({
        message: expect.stringContaining(ENGINE_STORE_BACKUP_DIR),
        cause: renameError,
      });
      await expect(opening).rejects.toThrow(
        "dohc could not finish rebuilding this workspace's data store",
      );
      expect(openActivity).not.toHaveBeenCalled();
      expect(activity.listOpenWorkspaceIds()).toEqual([]);
    } finally {
      await activity.stopAll();
    }
  });

  it("recovers a pending move before a dispatch-scoped capture can open a new store", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    await mkdir(backupDir);
    await writeMoveManifest([
      "engine.db-shm",
      "engine.db-wal",
      "engine.db-journal",
      "engine.db",
    ]);
    await rename(
      join(engineDir, "engine.db-shm"),
      join(backupDir, "engine.db-shm"),
    );
    const workspace = { workspaceId: "workspace", rootPath: root };
    const openScopedCapture = vi.fn(async () => {
      expect((await readdir(backupDir)).sort()).toEqual([
        "MOVE_COMPLETE",
        "engine.db",
        "engine.db-journal",
        "engine.db-shm",
        "engine.db-wal",
      ]);
      expect((await readdir(engineDir)).sort()).toEqual(["pre-v2-backup"]);
      await writeFile(join(engineDir, "engine.db"), "rebuilt-store");
      return true;
    });

    await expect(
      withEngineStoreRecovered(
        new Map(),
        workspace,
        false,
        openScopedCapture,
      ),
    ).resolves.toBe(true);

    expect(openScopedCapture).toHaveBeenCalledOnce();
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "rebuilt-store",
    );
    expect(await readFile(join(backupDir, "engine.db"), "utf8")).toBe(
      "refused-store",
    );
  });

  it("recovers a failed partial move before an already-locked reopen opens the store", async () => {
    await seedStore({
      "engine.db": "refused-store",
      "engine.db-journal": "journal",
      "engine.db-wal": "wal",
      "engine.db-shm": "shm",
    });
    const locks = new Map<string, Promise<void>>();
    const workspace = { workspaceId: "workspace", rootPath: root };
    const moveError = new Error("host crash");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let renames = 0;
    let stateAtOpen:
      | { backupFiles: string[]; liveFiles: string[] }
      | undefined;
    const openActivity = vi.fn(async () => {
      stateAtOpen = {
        backupFiles: (await readdir(backupDir)).sort(),
        liveFiles: (await readdir(engineDir)).sort(),
      };
      await writeFile(join(engineDir, "engine.db"), "rebuilt-store");
    });

    const rebuilding = withKeyedStartLock(
      locks,
      workspace.workspaceId,
      () =>
        rebuildEngineStore(root, {
          closeActivity: async () => undefined,
          probeStoreRefusal: async () => "foreign-database",
          moveStoreAside: (rootPath) =>
            moveEngineStoreAside(rootPath, {
              rename: async (from, to) => {
                renames += 1;
                if (renames === 5) throw moveError;
                await rename(from, to);
              },
            }),
          reopenActivity: () =>
            withEngineStoreRecovered(locks, workspace, true, openActivity),
        }),
    );

    await expect(rebuilding).resolves.toEqual({ outcome: "moved" });
    expect(consoleError).toHaveBeenCalledWith(
      "The engine store move reported an error, but reopening completed the move.",
      moveError,
    );
    expect(openActivity).toHaveBeenCalledOnce();
    expect(stateAtOpen).toEqual({
      backupFiles: [
        "MOVE_COMPLETE",
        "engine.db",
        "engine.db-journal",
        "engine.db-shm",
        "engine.db-wal",
      ],
      liveFiles: ["pre-v2-backup"],
    });
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "rebuilt-store",
    );
    consoleError.mockRestore();
  });

  it("holds the workspace lock through an ordinary activity open before rebuilding", async () => {
    const locks = new Map<string, Promise<void>>();
    const workspace = {
      workspaceId: "workspace",
      rootPath: root,
      kind: "personal" as const,
      mode: "local-first" as const,
    };
    const openReachedCapture = deferred();
    const finishOpen = deferred();
    const order: string[] = [];
    let captureBuilds = 0;
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: async () => {
        captureBuilds += 1;
        order.push(`activity.open:${captureBuilds}:start`);
        if (captureBuilds === 1) {
          openReachedCapture.resolve();
          await finishOpen.promise;
        }
        order.push(`activity.open:${captureBuilds}:end`);
        return { capture: null, shareView: false };
      },
    });
    const ordinaryOpen = withEngineStoreRecovered(
      locks,
      workspace,
      false,
      async () => {
        const result = await activity.open(workspace);
        order.push("ordinary-open-finished");
        return result;
      },
    );
    await openReachedCapture.promise;

    const closeActivity = vi.fn(async () => {
      order.push("rebuild-close");
      await activity.close(workspace.workspaceId);
    });
    const rebuild = withKeyedStartLock(locks, workspace.workspaceId, () =>
      rebuildEngineStore(root, {
        closeActivity,
        probeStoreRefusal: async () => "foreign-database",
        moveStoreAside: async () => {
          order.push("rebuild-move");
          return "moved";
        },
        reopenActivity: () =>
          withEngineStoreRecovered(
            locks,
            workspace,
            true,
            async () => {
              await activity.open(workspace);
              order.push("rebuild-reopen-finished");
            },
          ),
      }),
    );

    await Promise.resolve();
    finishOpen.resolve();
    await ordinaryOpen;
    await expect(rebuild).resolves.toEqual({ outcome: "moved" });

    expect(order).toEqual([
      "activity.open:1:start",
      "activity.open:1:end",
      "ordinary-open-finished",
      "rebuild-close",
      "rebuild-move",
      "activity.open:2:start",
      "activity.open:2:end",
      "rebuild-reopen-finished",
    ]);
    await activity.stopAll();
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

  it("refuses a healthy fresh probe despite a completed prior backup", async () => {
    await mkdir(backupDir);
    await writeFile(join(backupDir, "MOVE_COMPLETE"), "");
    const d = deps({ probeStoreRefusal: vi.fn(async () => null) });

    await expect(rebuildEngineStore(root, d)).rejects.toBeInstanceOf(
      EngineStoreNotRefusedError,
    );

    expect(d.closeActivity).toHaveBeenCalledOnce();
    expect(d.moveStoreAside).not.toHaveBeenCalled();
    expect(d.reopenActivity).toHaveBeenCalledOnce();
  });

  it("rethrows a probe failure beside a completed prior backup", async () => {
    await mkdir(backupDir);
    await writeFile(join(backupDir, "MOVE_COMPLETE"), "");
    const probeError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const d = deps({
      probeStoreRefusal: vi.fn(async () => {
        throw probeError;
      }),
    });

    await expect(rebuildEngineStore(root, d)).rejects.toBe(probeError);

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

  it("blocks direct engine runs only while the rebuild moves the store", async () => {
    await seedStore({ "engine.db": "refused-store" });
    const workspace = { workspaceId: "workspace", rootPath: root };
    const moveStarted = deferred();
    const finishMove = deferred();
    const requests: Parameters<EngineDaemonClient["sendRequest"]>[0][] = [];
    const operations: string[] = [];
    const client: EngineDaemonClient = {
      close() {},
      async sendRequest(request) {
        requests.push(request);
        if (request.method === "workspace.open") {
          return {
            id: request.id,
            result: { workspace: `handle-${requests.length}` },
          };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    const rebuilding = rebuildEngineStore(root, {
      closeActivity: () => sessions.closeWorkspace(workspace.workspaceId),
      probeStoreRefusal: async () => {
        await sessions.run(workspace, async () => {
          operations.push("probe");
        });
        await sessions.closeWorkspace(workspace.workspaceId);
        return "foreign-database";
      },
      moveStoreAside: async (rootPath) => {
        sessions.beginRebuild(workspace.workspaceId);
        try {
          return await moveEngineStoreAside(rootPath, {
            rename: async (from, to) => {
              if (to === join(backupDir, "engine.db")) {
                moveStarted.resolve();
                await finishMove.promise;
              }
              await rename(from, to);
            },
          });
        } finally {
          sessions.endRebuild(workspace.workspaceId);
        }
      },
      reopenActivity: async () => {
        await sessions.run(workspace, async () => {
          operations.push("reopen");
        });
      },
    });
    await moveStarted.promise;

    try {
      await expect(
        sessions.run(workspace, async () => {
          operations.push("during-move");
        }),
      ).rejects.toEqual(
        new EngineWorkspaceRebuildingError(workspace.workspaceId),
      );
      expect(
        requests.filter((request) => request.method === "workspace.open"),
      ).toHaveLength(1);
    } finally {
      finishMove.resolve();
    }

    await expect(rebuilding).resolves.toEqual({ outcome: "moved" });
    expect(operations).toEqual(["probe", "reopen"]);
    expect(
      requests.filter((request) => request.method === "workspace.open"),
    ).toHaveLength(2);
  });

  it("stops before probe, move, or reopen when close rejects", async () => {
    const closeError = new Error("stop failed");
    const d = deps({
      closeActivity: vi.fn(async () => {
        throw closeError;
      }),
    });

    const rebuilding = rebuildEngineStore(root, d);
    await expect(rebuilding).rejects.toBeInstanceOf(EngineStoreCloseFailedError);
    await expect(rebuilding).rejects.toMatchObject({
      message:
        "dohc could not finish closing this workspace's data store. Nothing moved. Try again.",
      cause: closeError,
    });
    expect(d.probeStoreRefusal).not.toHaveBeenCalled();
    expect(d.moveStoreAside).not.toHaveBeenCalled();
    expect(d.reopenActivity).not.toHaveBeenCalled();
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

  it("surfaces the recovery failure details when reopening fails", async () => {
    const recoveryError = new EngineStoreRecoveryFailedError(
      new Error("rename denied"),
    );
    const d = deps({
      reopenActivity: vi.fn(async () => {
        throw recoveryError;
      }),
    });

    await expect(rebuildEngineStore(root, d)).resolves.toEqual({
      outcome: "moved",
      reopenFailed: recoveryError.message,
    });
  });

  it("reports a reopen failure after recovery completes a failed move", async () => {
    await mkdir(backupDir);
    await writeFile(join(backupDir, "MOVE_COMPLETE"), "");
    const moveError = new Error("host crash");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const d = deps({
      moveStoreAside: vi.fn(async () => {
        throw moveError;
      }),
      reopenActivity: vi.fn(async () => {
        throw new Error("daemon did not come back");
      }),
    });

    await expect(rebuildEngineStore(root, d)).resolves.toEqual({
      outcome: "moved",
      reopenFailed:
        "dohc could not finish rebuilding this workspace's data store.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "The engine store move reported an error, but reopening completed the move.",
      moveError,
    );
    consoleError.mockRestore();
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

  it("moves once and shares the result between concurrent rebuild requests", async () => {
    await seedStore({ "engine.db": "refused-store" });
    const locks = new Map<string, Promise<void>>();
    const results = new Map<string, Awaited<ReturnType<typeof rebuildEngineStore>>>();
    let refused = true;
    const probeStoreRefusal = vi.fn(async () => "foreign-database" as const);
    const moveStoreAside = vi.fn(moveEngineStoreAside);
    const closeActivity = vi.fn(async () => undefined);
    const reopenActivity = vi.fn(async () => {
      refused = false;
    });
    const request = () =>
      withKeyedStartLock(locks, "workspace", () =>
        rebuildEngineStoreRequest(root, {
          isStoreRefused: () => refused,
          previousResult: () => results.get("workspace"),
          rememberResult: (result) => results.set("workspace", result),
          closeActivity,
          probeStoreRefusal,
          moveStoreAside,
          reopenActivity,
        }),
      );

    await expect(Promise.all([request(), request()])).resolves.toEqual([
      { outcome: "moved" },
      { outcome: "moved" },
    ]);

    expect(moveStoreAside).toHaveBeenCalledOnce();
    expect(closeActivity).toHaveBeenCalledOnce();
    expect(probeStoreRefusal).toHaveBeenCalledOnce();
    expect(reopenActivity).toHaveBeenCalledOnce();
    expect((await readdir(backupDir)).sort()).toEqual([
      "MOVE_COMPLETE",
      "engine.db",
    ]);
  });

  it("returns the prior result when a fresh probe finds a healthy store", async () => {
    const previous = { outcome: "moved" } as const;
    const moveStoreAside = vi.fn(async () => "moved" as const);

    await expect(
      rebuildEngineStoreRequest(root, {
        isStoreRefused: () => true,
        previousResult: () => previous,
        rememberResult: vi.fn(),
        closeActivity: vi.fn(async () => undefined),
        probeStoreRefusal: vi.fn(async () => null),
        moveStoreAside,
        reopenActivity: vi.fn(async () => undefined),
      }),
    ).resolves.toBe(previous);

    expect(moveStoreAside).not.toHaveBeenCalled();
  });

  it("rejects an uncached request before closing when the store is healthy", async () => {
    const closeActivity = vi.fn(async () => undefined);
    const moveStoreAside = vi.fn(async () => "moved" as const);

    await expect(
      rebuildEngineStoreRequest(root, {
        isStoreRefused: () => false,
        previousResult: () => undefined,
        rememberResult: vi.fn(),
        closeActivity,
        probeStoreRefusal: vi.fn(async () => "foreign-database" as const),
        moveStoreAside,
        reopenActivity: vi.fn(async () => undefined),
      }),
    ).rejects.toBeInstanceOf(EngineStoreNotRefusedError);

    expect(closeActivity).not.toHaveBeenCalled();
    expect(moveStoreAside).not.toHaveBeenCalled();
  });
});
