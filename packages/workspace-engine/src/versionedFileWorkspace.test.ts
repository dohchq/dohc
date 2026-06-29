import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_FILE_AUTHOR,
  VersionedFileWorkspaceError,
  createTestableVersionedFileWorkspace,
} from "./versionedFileWorkspace";

let root: string;
let rootParent: string;
let now = 1000;
// VersionedFileWorkspace currently exercises the anchored descriptor filesystem
// implementation; desktop/MCP callers use higher-level fallbacks off platform.
const itAnchoredFilesystem = process.platform === "linux" ? it : it.skip;

type WorkspaceTestCounters = Record<"moment" | "object" | "version", number>;
type VersionedFileWorkspaceTestHooks = Parameters<
  typeof createTestableVersionedFileWorkspace
>[1];

beforeEach(async () => {
  rootParent = await mkdtemp(join(tmpdir(), "dohc-versioned-files-"));
  root = join(rootParent, "workspace");
  await mkdir(root, { recursive: true });
  now = 1000;
});

afterEach(async () => {
  await rm(rootParent, { recursive: true, force: true });
});

function createWorkspaceTestCounters(): WorkspaceTestCounters {
  return { moment: 0, object: 0, version: 0 };
}

function historyBlobDirForTest(workspaceId = "workspace-a"): string {
  const namespace = `workspace-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 32)}`;
  return join(root, ".dohc", "engine", "history-blobs", namespace);
}

async function readHistoryBlobRootEntriesForTest(): Promise<string[]> {
  try {
    return await readdir(join(root, ".dohc", "engine", "history-blobs"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function workspace(
  counters = createWorkspaceTestCounters(),
  testHooks?: VersionedFileWorkspaceTestHooks,
  workspaceId = "workspace-a",
) {
  const options = {
    rootDir: root,
    workspaceId,
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: (kind: keyof WorkspaceTestCounters) => {
      counters[kind] += 1;
      return `${kind}-${counters[kind]}`;
    },
  };
  return createTestableVersionedFileWorkspace(options, testHooks ?? {});
}

it("rejects unsupported versioned file workspace platforms", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
  try {
    try {
      workspace();
    } catch (error) {
      expect(error).toBeInstanceOf(VersionedFileWorkspaceError);
      expect(error).toMatchObject({ code: "unsupported-filesystem" });
      return;
    }
    throw new Error("Expected workspace creation to fail on unsupported platforms.");
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
});

itAnchoredFilesystem("pins symlink workspace roots to their real directory", async () => {
  const linkedRoot = `${root}-link`;
  await symlink(root, linkedRoot, "dir");
  try {
    const ws = createTestableVersionedFileWorkspace({
      rootDir: linkedRoot,
      workspaceId: "workspace-a",
    });

    expect(ws.unsafeInternals.rootDir).toBe(root);
    await ws.writeTextFile({ path: "notes/symlink-root.md", text: "real root\n" });
    await expect(readFile(join(root, "notes/symlink-root.md"), "utf8")).resolves.toBe(
      "real root\n",
    );
  } finally {
    await rm(linkedRoot, { force: true });
  }
});

itAnchoredFilesystem("fails closed if the pinned workspace root is replaced", async () => {
  const ws = workspace();
  const originalRoot = `${root}-original`;
  await rename(root, originalRoot);
  await mkdir(root);
  try {
    await expect(
      ws.writeTextFile({ path: "notes/replaced-root.md", text: "nope\n" }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(readdir(root)).resolves.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rename(originalRoot, root).catch(() => undefined);
  }
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T | PromiseLike<T>);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isPidAliveForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function unusedPidForTest(): number {
  const maxPid = 4_000_000;
  for (let offset = 1; offset < 100_000; offset += 1) {
    const pid = ((process.pid + offset) % maxPid) || maxPid;
    if (!isPidAliveForTest(pid)) return pid;
  }
  throw new Error("Could not find an unused pid for lock fixture.");
}

async function expectHistoryIds(
  ws: { history: { list(): Promise<Array<{ id: string }>> } },
  ids: string[],
): Promise<void> {
  expect((await ws.history.list()).map((record) => record.id)).toEqual(ids);
}

async function writeFixture(path: string, text: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

function unsafeFileWorkspacePaths(): string[] {
  return [
    ".dohc/engine/escape.md",
    ".DOHC/engine/escape.md",
    "notes/.dohc/engine/escape.md",
    "notes/.DOHC/engine/escape.md",
    "../outside.md",
    ".git/escape.md",
    ".Git/escape.md",
    ".GIT/escape.md",
    "notes/.git/config",
    "notes/.GIT/config",
    "node_modules/pkg/index.md",
    "notes/node_modules/pkg/index.md",
    "notes/NODE_MODULES/pkg/index.md",
    "notes/../../outside.md",
    join(root, "absolute.md"),
  ];
}

async function replaceHistoryDirWithFile() {
  const historyPath = join(root, ".dohc", "history");
  await rm(historyPath, { recursive: true, force: true });
  await writeFile(historyPath, "blocked", "utf8");
}

async function readPendingMutationEntries(): Promise<string[]> {
  try {
    return (await readdir(join(root, ".dohc", "engine", "pending-file-mutations"))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readInternalTempEntries(): Promise<string[]> {
  try {
    return await readdir(join(root, ".dohc", "tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function createExternalMutationLockForTest(): Promise<() => Promise<void>> {
  const lockNow = Date.now();
  now = lockNow;
  const token = `external-${lockNow}`;
  const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
  const ownerDir = join(lockDir, token);
  await mkdir(ownerDir, { recursive: true });
  await writeFile(
    join(ownerDir, "owner.json"),
    JSON.stringify({
      token,
      pid: process.pid,
      createdAtMs: lockNow,
      heartbeatAtMs: lockNow,
    }),
    "utf8",
  );
  return () => rm(lockDir, { recursive: true, force: true });
}

async function readPendingMutationJournalsForTest(): Promise<
  Array<{
    phase: string;
    path: string;
    diskBackup: { backupPath?: string; mode?: number };
    after: unknown;
    createdHistoryBlobPaths?: string[];
  }>
> {
  const pendingDir = join(root, ".dohc", "engine", "pending-file-mutations");
  const entries = await readPendingMutationEntries();
  return Promise.all(
    entries.map(async (entry) => {
      const raw = await readFile(join(pendingDir, entry), "utf8");
      return JSON.parse(raw) as {
        phase: string;
        path: string;
        diskBackup: { backupPath?: string; mode?: number };
        after: unknown;
        createdHistoryBlobPaths?: string[];
      };
    }),
  );
}

async function writePendingMutationJournalForTest(input: {
  id: string;
  workspaceId?: string;
  versionId: string;
  path: string;
  operation?: "write" | "delete";
  phase: string;
  backupPath?: string;
  targetPath?: string;
  before?: unknown;
  beforeText?: string;
  after?: unknown;
  afterText?: string;
  mode?: number;
  historyId: string;
  historyRecordedAtMs?: number;
  expectedChangeSet?: unknown;
  versionMutationMomentId?: string;
  createdHistoryBlobPaths?: string[];
}) {
  const operation = input.operation ?? "write";
  const pendingDir = join(root, ".dohc", "engine", "pending-file-mutations");
  await mkdir(pendingDir, { recursive: true });
  await writeFile(
    join(pendingDir, `${input.id}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        workspaceId: input.workspaceId ?? "workspace-a",
        versionId: input.versionId,
        path: input.path,
        operation,
        phase: input.phase,
        before:
          input.before === undefined ? { text: input.beforeText ?? "Original\n" } : input.before,
        after:
          input.after === undefined
            ? operation === "delete"
              ? null
              : { text: input.afterText ?? "Crashed\n" }
            : input.after,
        diskBackup: {
          targetPath: input.targetPath ?? join(root, input.path),
          ...(input.backupPath ? { backupPath: input.backupPath } : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        },
        historyId: input.historyId,
        historyRecordedAtMs: input.historyRecordedAtMs ?? 5000,
        ...(input.expectedChangeSet ? { expectedChangeSet: input.expectedChangeSet } : {}),
        ...(input.versionMutationMomentId
          ? { versionMutationMomentId: input.versionMutationMomentId }
          : {}),
        ...(input.createdHistoryBlobPaths
          ? { createdHistoryBlobPaths: input.createdHistoryBlobPaths }
          : {}),
        createdAtMs: 5000,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("versioned file workspace", () => {
  itAnchoredFilesystem("writes a normal file, stores a version snapshot, and records history", async () => {
    const ws = workspace();
    const result = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Hello files\n",
    });

    await expect(readFile(join(root, "notes/today.md"), "utf8")).resolves.toBe(
      "Hello files\n",
    );
    await expect(
      ws.versions.readTextFile({
        versionId: result.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({
      path: "notes/today.md",
      text: "Hello files\n",
      metadata: { origin: "local-file" },
    });
    expect(result.history).toMatchObject({
      author: LOCAL_FILE_AUTHOR,
      files: [
        {
          path: "notes/today.md",
          operation: "write",
          before: null,
          after: { text: "Hello files\n" },
        },
      ],
    });
  });

  itAnchoredFilesystem("rejects invalid configured authors before journaling", async () => {
    const ws = createTestableVersionedFileWorkspace(
      {
        rootDir: root,
        workspaceId: "workspace-a",
        author: { kind: "local", label: " " } as never,
      },
      {},
    );

    await expect(
      ws.writeTextFile({ path: "notes/invalid-author.md", text: "nope\n" }),
    ).rejects.toThrow(/non-empty/i);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rejects invalid workspace ids before storage setup", async () => {
    for (const workspaceId of ["", " workspace-a", "workspace-a "]) {
      expect(() => workspace(createWorkspaceTestCounters(), undefined, workspaceId)).toThrow(
        /workspace id/i,
      );
    }
  });

  itAnchoredFilesystem("records write history from the mutation text even if the live file drifts", async () => {
    const ws = workspace(createWorkspaceTestCounters(), {
      afterFileWriteBeforeHistory: async (path) => {
        await writeFile(join(root, path), "external drift\n");
      },
    });

    const result = await ws.writeTextFile({
      path: "notes/drift.md",
      text: "applied\n",
    });

    expect(result.history.files[0].after).toMatchObject({
      text: "applied\n",
      sizeBytes: 8,
    });
    await expect(
      ws.versions.readTextFile({
        versionId: result.versionId,
        path: "notes/drift.md",
      }),
    ).resolves.toMatchObject({ text: "applied\n" });
    await expect(readFile(join(root, "notes/drift.md"), "utf8")).resolves.toBe(
      "external drift\n",
    );
  });

  itAnchoredFilesystem("keeps file history scoped to the workspace id", async () => {
    const counters = createWorkspaceTestCounters();
    const wsA = workspace(counters, undefined, "workspace-a");
    const wsB = workspace(counters, undefined, "workspace-b");

    const a = await wsA.writeTextFile({ path: "notes/a.md", text: "A\n" });
    const b = await wsB.writeTextFile({ path: "notes/b.md", text: "B\n" });

    await expect(wsA.history.list()).resolves.toMatchObject([{ id: a.history.id }]);
    await expect(wsB.history.list()).resolves.toMatchObject([{ id: b.history.id }]);
    await expect(
      wsA.unsafeInternals.versions.readTextFile({
        workspaceId: "workspace-a",
        versionId: b.versionId,
        path: "notes/b.md",
      }),
    ).resolves.toBeNull();
    await expect(
      wsB.unsafeInternals.versions.readTextFile({
        workspaceId: "workspace-b",
        versionId: a.versionId,
        path: "notes/a.md",
      }),
    ).resolves.toBeNull();
    await expect(
      wsA.restoreTextFile({ changeSetId: b.history.id, path: "notes/b.md" }),
    ).rejects.toMatchObject({ code: "restore-file-not-found" });
  });

  itAnchoredFilesystem("rejects invalid restore directions before reading history state", async () => {
    const ws = workspace();

    await expect(
      ws.restoreTextFile({
        changeSetId: "missing",
        path: "notes/today.md",
        direction: "sideways" as "before",
      }),
    ).rejects.toMatchObject({ code: "invalid-restore-direction" });
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("preserves UTF-8 BOM bytes when reading and snapshotting text files", async () => {
    const ws = workspace();
    const original = "\ufeffhello\n";
    await writeFixture("notes/bom.md", original);

    await expect(ws.readTextFile({ path: "notes/bom.md" })).resolves.toBe(original);

    const result = await ws.writeTextFile({
      path: "notes/bom.md",
      text: "replacement\n",
    });

    expect(result.history.files[0].before).toMatchObject({
      text: original,
      sizeBytes: Buffer.byteLength(original, "utf8"),
    });
  });

  itAnchoredFilesystem("reads, lists, and stats text files through the normal folder surface", async () => {
    const ws = workspace();
    await writeFixture("notes/a.md", "A\n");
    await writeFixture(".git/config", "ignored\n");
    await writeFixture("node_modules/pkg/index.js", "ignored\n");
    await writeFixture(".dohc/history/internal.json", "ignored\n");

    await expect(ws.readTextFile({ path: "notes/a.md" })).resolves.toBe("A\n");
    await expect(ws.statTextFile({ path: "notes/a.md" })).resolves.toMatchObject({
      path: "notes/a.md",
      mediaType: "text/markdown",
      sizeBytes: 2,
    });
    await expect(ws.listTextFiles()).resolves.toMatchObject([
      { path: "notes/a.md", mediaType: "text/markdown" },
    ]);
  });

  itAnchoredFilesystem("excludes invalid UTF-8 text-classified files from list", async () => {
    const ws = workspace();
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/binary-ish.md"), Buffer.from([0xff, 0xfe, 0x61]));
    await writeFixture("notes/a.md", "A\n");

    await expect(ws.listTextFiles()).resolves.toEqual([
      {
        path: "notes/a.md",
        mediaType: "text/markdown",
        sizeBytes: 2,
        sha256: expect.any(String),
      },
    ]);
    await expect(ws.statTextFile({ path: "notes/binary-ish.md" })).rejects.toMatchObject({
      code: "not-text",
    });
  });

  itAnchoredFilesystem("keeps missing read-only calls from creating engine mutation state", async () => {
    const ws = workspace();

    await expect(ws.readTextFile({ path: "notes/missing.md" })).resolves.toBeNull();
    expect(await readPendingMutationEntries()).toEqual([]);
    expect(await readInternalTempEntries()).toEqual([]);
  });

  itAnchoredFilesystem("waits behind a filesystem mutation lock before reading", async () => {
    const lockWaitObserved = deferred();
    const ws = workspace(createWorkspaceTestCounters(), {
      onFileMutationLockWait: () => lockWaitObserved.resolve(),
    });
    await writeFixture("notes/a.md", "A\n");
    const releaseExternalLock = await createExternalMutationLockForTest();
    const read = ws.readTextFile({ path: "notes/a.md" });
    let readSettled = false;
    read.then(
      () => {
        readSettled = true;
      },
      () => {
        readSettled = true;
      },
    );
    try {
      await lockWaitObserved.promise;
      await Promise.resolve();
      expect(readSettled).toBe(false);
    } finally {
      await releaseExternalLock();
    }
    await expect(read).resolves.toBe("A\n");
  });

  itAnchoredFilesystem("rejects oversized text reads before buffering the whole file", async () => {
    const ws = workspace();
    const absolute = join(root, "notes", "huge.md");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));

    await expect(ws.readTextFile({ path: "notes/huge.md" })).rejects.toMatchObject({
      code: "file-too-large",
    });
    await expect(ws.statTextFile({ path: "notes/huge.md" })).rejects.toMatchObject({
      code: "file-too-large",
    });
  });

  itAnchoredFilesystem("keeps read-only calls behind a paused workspace write lock", async () => {
    const counters = createWorkspaceTestCounters();
    const writePaused = deferred();
    const releaseWrite = deferred();
    const readOnlyQueued = deferred();
    let readOnlyQueuedCount = 0;
    let paused = false;
    const writer = workspace(counters, {
      afterFileMutationLockAcquired: async () => {
        if (paused) return;
        paused = true;
        writePaused.resolve();
        await releaseWrite.promise;
      },
    });
    const reader = workspace(counters, {
      onWorkspaceMutationQueued: () => {
        readOnlyQueuedCount += 1;
        if (readOnlyQueuedCount === 2) readOnlyQueued.resolve();
      },
    });

    const write = writer.writeTextFile({ path: "notes/write.md", text: "writing\n" });
    let read: Promise<string | null> | undefined;
    let historyRead: Promise<Array<{ id: string }>> | undefined;
    let readSettled = false;
    let historyReadSettled = false;
    try {
      await writePaused.promise;
      read = reader.readTextFile({ path: "notes/missing.md" });
      historyRead = reader.history.list();
      read.then(
        () => {
          readSettled = true;
        },
        () => {
          readSettled = true;
        },
      );
      historyRead.then(
        () => {
          historyReadSettled = true;
        },
        () => {
          historyReadSettled = true;
        },
      );
      await readOnlyQueued.promise;
      await Promise.resolve();
      expect(readSettled).toBe(false);
      expect(historyReadSettled).toBe(false);
    } finally {
      releaseWrite.resolve();
      await write;
    }
    if (!read) throw new Error("Expected read to start while writer was paused.");
    if (!historyRead) throw new Error("Expected history read to start while writer was paused.");
    await expect(read).resolves.toBeNull();
    await expect(historyRead).resolves.toHaveLength(1);
  });

  itAnchoredFilesystem(
    "restores one file from a previous history snapshot",
    async () => {
      const ws = workspace();
      await ws.writeTextFile({ path: "notes/today.md", text: "Version one\n" });
      const second = await ws.writeTextFile({
        path: "notes/today.md",
        text: "Version two\n",
      });

      const restored = await ws.restoreTextFile({
        changeSetId: second.history.id,
        path: "notes/today.md",
      });

      await expect(ws.readTextFile({ path: "notes/today.md" })).resolves.toBe(
        "Version one\n",
      );
      expect(restored.restoredFrom).toEqual({
        changeSetId: second.history.id,
        path: "notes/today.md",
        direction: "before",
      });
      expect(restored.history.kind).toBe("history-restore");
      expect(restored.history.provenance).toMatchObject({
        source: "history-restore",
        restoreOfChangeSetId: second.history.id,
        restoreOfPath: "notes/today.md",
      });

      const restoredForward = await ws.restoreTextFile({
        changeSetId: second.history.id,
        path: "notes/today.md",
        direction: "after",
      });

      await expect(ws.readTextFile({ path: "notes/today.md" })).resolves.toBe(
        "Version two\n",
      );
      expect(restoredForward.restoredFrom).toEqual({
        changeSetId: second.history.id,
        path: "notes/today.md",
        direction: "after",
      });
      expect(restoredForward.history.provenance).toMatchObject({
        source: "history-restore",
        restoreOfChangeSetId: second.history.id,
        restoreDirection: "redo",
      });
      expect(restoredForward.history.summary).toBe(
        "Redid restore for notes/today.md",
      );

      const restoredAgain = await ws.restoreTextFile({
        changeSetId: second.history.id,
        path: "notes/today.md",
      });
      const undoneRestore = await ws.restoreTextFile({
        changeSetId: restoredAgain.history.id,
        path: "notes/today.md",
        direction: "before",
      });
      await expect(ws.readTextFile({ path: "notes/today.md" })).resolves.toBe(
        "Version two\n",
      );
      expect(undoneRestore.history.provenance).toMatchObject({
        source: "history-restore",
        restoreOfChangeSetId: restoredAgain.history.id,
        restoreDirection: "undo",
      });
      expect(undoneRestore.history.summary).toBe("Undid restore for notes/today.md");

      await ws.writeTextFile({ path: "notes/redelete.md", text: "Delete and redo\n" });
      const deleted = await ws.deleteTextFile({ path: "notes/redelete.md" });
      await ws.restoreTextFile({
        changeSetId: deleted.history.id,
        path: "notes/redelete.md",
        direction: "before",
      });

      const redoneDelete = await ws.restoreTextFile({
        changeSetId: deleted.history.id,
        path: "notes/redelete.md",
        direction: "after",
      });

      await expect(ws.readTextFile({ path: "notes/redelete.md" })).resolves.toBeNull();
      expect(redoneDelete.restoredFrom).toEqual({
        changeSetId: deleted.history.id,
        path: "notes/redelete.md",
        direction: "after",
      });
      expect(redoneDelete.history.provenance).toMatchObject({
        source: "history-restore",
        restoreOfChangeSetId: deleted.history.id,
        restoreDirection: "redo",
      });
      expect(redoneDelete.history.summary).toBe(
        "Redid restore for notes/redelete.md",
      );
    },
    10_000,
  );

  itAnchoredFilesystem("restores when the method is destructured from the workspace", async () => {
    const ws = workspace();
    await ws.writeTextFile({ path: "notes/today.md", text: "Version one\n" });
    const second = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Version two\n",
    });
    const { restoreTextFile } = ws;

    await restoreTextFile({
      changeSetId: second.history.id,
      path: "notes/today.md",
    });

    await expect(ws.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Version one\n",
    );
  });

  itAnchoredFilesystem("deletes a text file while recording version and history state", async () => {
    const ws = workspace();
    const written = await ws.writeTextFile({ path: "notes/today.md", text: "Delete me\n" });
    const named = await ws.createNamedVersion({
      name: "Delete branch",
      fromVersionId: written.versionId,
    });

    const deleted = await ws.deleteTextFile({ path: "notes/today.md", versionId: named.id });

    await expect(readFile(join(root, "notes/today.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      ws.versions.readTextFile({
        versionId: deleted.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toBeNull();
    await expect(
      ws.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Delete me\n" });
    expect(deleted.deleted).toMatchObject({ text: "Delete me\n" });
    expect(deleted.history.summary).toBe("Deleted notes/today.md");
    expect(deleted.history.files).toMatchObject([
      {
        path: "notes/today.md",
        operation: "delete",
        before: { text: "Delete me\n" },
        after: null,
      },
    ]);
  });

  itAnchoredFilesystem("cleans delete preimage backups when version lookup fails", async () => {
    const ws = workspace();
    await writeFixture("notes/delete-version-missing.md", "Keep me\n");

    await expect(
      ws.deleteTextFile({
        path: "notes/delete-version-missing.md",
        versionId: "missing-version",
      }),
    ).rejects.toMatchObject({ code: "version-not-found" });

    await expect(readFile(join(root, "notes/delete-version-missing.md"), "utf8")).resolves.toBe(
      "Keep me\n",
    );
    await expect(readInternalTempEntries()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("tightens pre-existing internal temp directories before writing", async () => {
    const tmpPath = join(root, ".dohc", "tmp");
    await mkdir(tmpPath, { recursive: true, mode: 0o777 });
    await chmod(tmpPath, 0o777);
    const ws = workspace();

    await ws.writeTextFile({ path: "notes/internal-mode.md", text: "Mode\n" });

    expect((await stat(tmpPath)).mode & 0o777).toBe(0o700);
  });

  itAnchoredFilesystem("deletes a disk-only text file while preserving history and empty version state", async () => {
    const ws = workspace();
    await writeFixture("notes/disk-only.md", "Only on disk\n");

    const deleted = await ws.deleteTextFile({ path: "notes/disk-only.md" });

    await expect(readFile(join(root, "notes/disk-only.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      ws.versions.readTextFile({
        versionId: deleted.versionId,
        path: "notes/disk-only.md",
      }),
    ).resolves.toBeNull();
    expect(deleted.deleted).toBeNull();
    expect(deleted.history.files).toMatchObject([
      {
        path: "notes/disk-only.md",
        operation: "delete",
        before: { text: "Only on disk\n" },
        after: null,
      },
    ]);
  });

  itAnchoredFilesystem("restores a created file back to deletion when the target snapshot is missing", async () => {
    const ws = workspace();
    const created = await ws.writeTextFile({ path: "notes/new.md", text: "Temporary\n" });

    const restored = await ws.restoreTextFile({
      changeSetId: created.history.id,
      path: "notes/new.md",
    });

    await expect(readFile(join(root, "notes/new.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(restored.restoredFrom).toEqual({
      changeSetId: created.history.id,
      path: "notes/new.md",
      direction: "before",
    });
    expect(restored.history.files).toMatchObject([
      {
        path: "notes/new.md",
        operation: "delete",
        before: { text: "Temporary\n" },
        after: null,
      },
    ]);
  });

  itAnchoredFilesystem("refuses restore when the live file no longer matches the history entry", async () => {
    const ws = workspace();
    await ws.writeTextFile({ path: "notes/today.md", text: "Version one\n" });
    const second = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Version two\n",
    });
    await writeFile(join(root, "notes/today.md"), "External untracked edit\n", "utf8");

    await expect(
      ws.restoreTextFile({
        changeSetId: second.history.id,
        path: "notes/today.md",
      }),
    ).rejects.toMatchObject({ code: "restore-stale-live-file" });
  });

  itAnchoredFilesystem("rejects reserved and traversal paths before writing disk, version, or history state", async () => {
    const ws = workspace();

    for (const path of unsafeFileWorkspacePaths()) {
      await expect(ws.readTextFile({ path })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.statTextFile({ path })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.writeTextFile({ path, text: "nope\n" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.deleteTextFile({ path })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.restoreTextFile({ changeSetId: "missing", path })).rejects.toMatchObject({
        code: "invalid-path",
      });
    }
    await expect(readFile(join(root, ".dohc/engine/escape.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(dirname(root), "outside.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "absolute.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(ws.versions.listVersions()).resolves.toEqual([]);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rolls back the normal file when the version write fails", async () => {
    const ws = workspace();

    await expect(
      ws.writeTextFile({
        path: "notes/today.md",
        text: "should roll back\n",
        versionId: "missing-version",
      }),
    ).rejects.toMatchObject({ code: "version-not-found" });
    await expect(readFile(join(root, "notes/today.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rolls back from a raw disk backup when the preimage is too large for history", async () => {
    const ws = workspace();
    const original = "x".repeat(129 * 1024);
    await writeFixture("notes/large.md", original);

    await expect(
      ws.writeTextFile({
        path: "notes/large.md",
        text: "replacement\n",
        versionId: "missing-version",
      }),
    ).rejects.toMatchObject({ code: "version-not-found" });

    await expect(readFile(join(root, "notes/large.md"), "utf8")).resolves.toBe(original);
    await expect(readdir(join(root, "notes"))).resolves.toEqual(["large.md"]);
    await expect(ws.history.list()).resolves.toEqual([]);
    await expect(readHistoryBlobRootEntriesForTest()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("removes newly created after-history blobs when failed writes roll back", async () => {
    const ws = workspace();
    const large = "x".repeat(129 * 1024);

    await expect(
      ws.writeTextFile({
        path: "notes/new-large.md",
        text: large,
        versionId: "missing-version",
      }),
    ).rejects.toMatchObject({ code: "version-not-found" });

    await expect(readFile(join(root, "notes/new-large.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readHistoryBlobRootEntriesForTest()).resolves.toEqual([]);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("removes history blobs listed by rolled-back pending journals", async () => {
    const ws = workspace();
    const main = await ws.ensureMainVersion();
    const blobPath = join(historyBlobDirForTest(), "orphan.txt");
    await mkdir(dirname(blobPath), { recursive: true });
    await writeFile(blobPath, "orphaned history blob\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000016",
      versionId: main.id,
      path: "notes/new.md",
      phase: "prepared",
      before: null,
      after: { text: "Crashed\n" },
      historyId: "history_orphan_blob",
      createdHistoryBlobPaths: [blobPath],
    });

    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/new.md" })).resolves.toBeNull();
    await expect(readFile(blobPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("uses hashes to verify large live files before restoring them to missing", async () => {
    const ws = workspace();
    const large = "x".repeat(129 * 1024);
    const written = await ws.writeTextFile({ path: "notes/large.md", text: large });

    expect(written.history.files[0].after).toMatchObject({
      sha256: expect.any(String),
      truncated: true,
      unavailableReason: "too-large",
    });

    await ws.restoreTextFile({
      changeSetId: written.history.id,
      path: "notes/large.md",
      direction: "before",
    });

    await expect(ws.readTextFile({ path: "notes/large.md" })).resolves.toBeNull();
  });

  itAnchoredFilesystem("restores large text content from history blobs", async () => {
    const ws = workspace();
    const large = "x".repeat(129 * 1024);
    const written = await ws.writeTextFile({ path: "notes/large.md", text: large });

    await ws.restoreTextFile({
      changeSetId: written.history.id,
      path: "notes/large.md",
      direction: "before",
      versionId: written.versionId,
    });
    await expect(readFile(join(root, "notes/large.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await ws.restoreTextFile({
      changeSetId: written.history.id,
      path: "notes/large.md",
      direction: "after",
      versionId: written.versionId,
    });
    await expect(readFile(join(root, "notes/large.md"), "utf8")).resolves.toBe(large);

    const deleted = await ws.deleteTextFile({
      path: "notes/large.md",
      versionId: written.versionId,
    });
    await ws.restoreTextFile({
      changeSetId: deleted.history.id,
      path: "notes/large.md",
      direction: "before",
      versionId: written.versionId,
    });

    await expect(readFile(join(root, "notes/large.md"), "utf8")).resolves.toBe(large);
  });

  itAnchoredFilesystem("rejects invalid UTF-8 preimages before replacing text files", async () => {
    const ws = workspace();
    const original = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/binary-ish.md"), original);

    await expect(
      ws.writeTextFile({
        path: "notes/binary-ish.md",
        text: "replacement\n",
      }),
    ).rejects.toMatchObject({ code: "not-text" });

    await expect(readFile(join(root, "notes/binary-ish.md"))).resolves.toEqual(original);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rejects invalid UTF-8 preimages before deleting text files", async () => {
    const ws = workspace();
    const original = Buffer.from([0xff, 0xfe, 0x61]);
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/binary-ish.md"), original);

    await expect(ws.deleteTextFile({ path: "notes/binary-ish.md" })).rejects.toMatchObject({
      code: "not-text",
    });

    await expect(readFile(join(root, "notes/binary-ish.md"))).resolves.toEqual(original);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("streams large preimages before rejecting invalid UTF-8 text files", async () => {
    const ws = workspace();
    const original = Buffer.concat([Buffer.alloc(129 * 1024, 0x61), Buffer.from([0xff])]);
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/large-binary-ish.md"), original);

    await expect(
      ws.writeTextFile({
        path: "notes/large-binary-ish.md",
        text: "replacement\n",
      }),
    ).rejects.toMatchObject({ code: "not-text" });

    await expect(readFile(join(root, "notes/large-binary-ish.md"))).resolves.toEqual(original);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rejects history blobs larger than the text restore cap", async () => {
    const ws = workspace();
    await ws.unsafeInternals.history.record(
      {
        kind: "user-edit",
        author: LOCAL_FILE_AUTHOR,
        summary: "Recorded oversized history blob",
        files: [
          {
            path: "notes/huge.md",
            operation: "write",
            before: null,
            after: {
              sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
              sizeBytes: 10 * 1024 * 1024 + 1,
              truncated: true,
              unavailableReason: "too-large",
            },
          },
        ],
        boundaryCrossings: [],
      },
      { id: "history_oversized_blob", recordedAtMs: 1000 },
    );

    await expect(
      ws.restoreTextFile({
        changeSetId: "history_oversized_blob",
        path: "notes/huge.md",
        direction: "after",
      }),
    ).rejects.toMatchObject({ code: "file-too-large" });
    await expect(readFile(join(root, "notes/huge.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  itAnchoredFilesystem("rejects oversized writes and preimages before text mutation work", async () => {
    const ws = workspace();
    const huge = "x".repeat(10 * 1024 * 1024 + 1);
    await expect(
      ws.writeTextFile({
        path: "notes/huge-new.md",
        text: huge,
      }),
    ).rejects.toMatchObject({ code: "file-too-large" });
    await expect(readFile(join(root, "notes/huge-new.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFixture("notes/huge-preimage.md", huge);

    await expect(
      ws.writeTextFile({
        path: "notes/huge-preimage.md",
        text: "replacement\n",
      }),
    ).rejects.toMatchObject({ code: "file-too-large" });
    await expect(ws.deleteTextFile({ path: "notes/huge-preimage.md" })).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect((await stat(join(root, "notes/huge-preimage.md"))).size).toBe(
      Buffer.byteLength(huge),
    );
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rejects non-round-trippable UTF-8 strings before writing", async () => {
    const ws = workspace();

    await expect(
      ws.writeTextFile({
        path: "notes/bad-string.md",
        text: "bad \uD800\n",
      }),
    ).rejects.toMatchObject({ code: "not-text" });
    await expect(readFile(join(root, "notes/bad-string.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rejects invalid UTF-8 when reading extension-classified text files", async () => {
    const ws = workspace();
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/binary-ish.md"), Buffer.from([0xff, 0xfe, 0x61]));

    await expect(ws.readTextFile({ path: "notes/binary-ish.md" })).rejects.toMatchObject({
      code: "not-text",
    });
  });

  itAnchoredFilesystem("preserves executable mode bits when replacing an existing text file", async () => {
    const ws = workspace();
    await writeFixture("scripts/run.sh", "#!/bin/sh\necho old\n");
    await chmod(join(root, "scripts/run.sh"), 0o755);
    const originalMode = (await stat(join(root, "scripts/run.sh"))).mode & 0o777;

    await ws.writeTextFile({ path: "scripts/run.sh", text: "#!/bin/sh\necho new\n" });

    await expect(readFile(join(root, "scripts/run.sh"), "utf8")).resolves.toBe(
      "#!/bin/sh\necho new\n",
    );
    const replaced = await stat(join(root, "scripts/run.sh"));
    expect(replaced.mode & 0o777).toBe(originalMode);
    expect(replaced.nlink).toBe(1);
    expect(await readInternalTempEntries()).toEqual([]);
  });

  itAnchoredFilesystem("rejects existing non-regular text targets before atomic replace", async () => {
    const ws = workspace();
    await mkdir(join(root, "notes", "as-dir.md"), { recursive: true });

    await expect(
      ws.writeTextFile({ path: "notes/as-dir.md", text: "nope\n" }),
    ).rejects.toMatchObject({ code: "invalid-path" });
    expect((await stat(join(root, "notes", "as-dir.md"))).isDirectory()).toBe(true);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("rejects writes before mutation when history state is unreadable", async () => {
    const ws = workspace();
    const original = "x".repeat(129 * 1024);
    const written = await ws.writeTextFile({ path: "notes/large.md", text: original });
    await replaceHistoryDirWithFile();

    await expect(
      ws.writeTextFile({
        path: "notes/large.md",
        text: "replacement\n",
        versionId: written.versionId,
      }),
    ).rejects.toThrow();

    await expect(readFile(join(root, "notes/large.md"), "utf8")).resolves.toBe(original);
    await expect(
      ws.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/large.md",
      }),
    ).resolves.toMatchObject({ text: original });
    expect(await readPendingMutationEntries()).toEqual([]);
    expect(await readInternalTempEntries()).toEqual([]);
  });

  itAnchoredFilesystem("rejects deletes before mutation when history state is unreadable", async () => {
    const ws = workspace();
    const original = "x".repeat(129 * 1024);
    const written = await ws.writeTextFile({ path: "notes/large.md", text: original });
    await replaceHistoryDirWithFile();

    await expect(
      ws.deleteTextFile({ path: "notes/large.md", versionId: written.versionId }),
    ).rejects.toThrow();

    await expect(readFile(join(root, "notes/large.md"), "utf8")).resolves.toBe(original);
    await expect(
      ws.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/large.md",
      }),
    ).resolves.toMatchObject({ text: original });
    expect(await readPendingMutationEntries()).toEqual([]);
    expect(await readInternalTempEntries()).toEqual([]);
  });

  itAnchoredFilesystem("rejects executable deletes before mutation when history state is unreadable", async () => {
    const ws = workspace();
    const written = await ws.writeTextFile({
      path: "scripts/run.sh",
      text: "#!/bin/sh\necho original\n",
    });
    await chmod(join(root, "scripts/run.sh"), 0o755);
    const originalMode = (await stat(join(root, "scripts/run.sh"))).mode & 0o777;
    await replaceHistoryDirWithFile();

    await expect(
      ws.deleteTextFile({ path: "scripts/run.sh", versionId: written.versionId }),
    ).rejects.toThrow();

    await expect(readFile(join(root, "scripts/run.sh"), "utf8")).resolves.toBe(
      "#!/bin/sh\necho original\n",
    );
    expect((await stat(join(root, "scripts/run.sh"))).mode & 0o777).toBe(originalMode);
    expect(await readPendingMutationEntries()).toEqual([]);
    expect(await readInternalTempEntries()).toEqual([]);
  });

  itAnchoredFilesystem("recovers a pending write journal by rolling disk and version state back on restart", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await writeFile(join(root, "notes/today.md"), "Crashed\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-crash.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000000",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "version-recorded",
      backupPath,
      historyId: "history_crashed",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Original\n",
    );
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Original\n" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("fails closed when a pending rollback backup no longer matches the preimage", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await writeFile(join(root, "notes/today.md"), "Crashed\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-corrupt.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Tampered\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000012",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "version-recorded",
      backupPath,
      beforeText: "Original\n",
      historyId: "history_corrupt_backup",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });
    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    await expect(readFile(join(root, "notes/today.md"), "utf8")).resolves.toBe("Crashed\n");
    await expect(readFile(backupPath, "utf8")).resolves.toBe("Tampered\n");
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000012.json",
    ]);
  });

  itAnchoredFilesystem("preserves a pending journal as a conflict when live disk diverges from the postimage", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await writeFile(join(root, "notes/today.md"), "External edit\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-conflict.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000013",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "version-recorded",
      backupPath,
      beforeText: "Original\n",
      afterText: "Crashed\n",
      historyId: "history_conflict",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });
    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    await expect(readFile(join(root, "notes/today.md"), "utf8")).resolves.toBe(
      "External edit\n",
    );
    expect(await readPendingMutationJournalsForTest()).toMatchObject([
      {
        path: "notes/today.md",
        phase: "recovery-conflict",
        after: { text: "Crashed\n" },
      },
    ]);
    await expect(
      restarted.unsafeInternals.versions.readTextFile({
        workspaceId: "workspace-a",
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Crashed\n" });
    await expect(readFile(backupPath, "utf8")).resolves.toBe("Original\n");
  });

  itAnchoredFilesystem("rolls back an incomplete disk-mutating journal from its backup", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    await writeFile(join(root, "notes/today.md"), "Partial crash\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-disk-mutating-crash.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000018",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "disk-mutating",
      backupPath,
      beforeText: "Original\n",
      afterText: "Crashed\n",
      historyId: "history_disk_mutating_crash",
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Original\n",
    );
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Original\n" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("recovers a pending write journal with an empty text preimage", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/empty.md",
      text: "",
    });
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/empty.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await writeFile(join(root, "notes/empty.md"), "Crashed\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-empty-crash.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000009",
      versionId: written.versionId,
      path: "notes/empty.md",
      phase: "version-recorded",
      backupPath,
      beforeText: "",
      historyId: "history_empty_crashed",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/empty.md" })).resolves.toBe("");
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/empty.md",
      }),
    ).resolves.toMatchObject({ text: "" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("recovers pending journals through their owning workspace namespace", async () => {
    const counters = createWorkspaceTestCounters();
    const wsA = workspace(counters, undefined, "workspace-a");
    const wsB = workspace(counters, undefined, "workspace-b");
    const workspaceAWrite = await wsA.writeTextFile({
      path: "notes/workspace-a.md",
      text: "Workspace A live\n",
    });
    const workspaceBWrite = await wsB.writeTextFile({
      path: "notes/workspace-b.md",
      text: "Workspace B committed\n",
    });
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000010",
      workspaceId: "workspace-b",
      versionId: workspaceBWrite.versionId,
      path: "notes/workspace-b.md",
      phase: "history-recorded",
      before: null,
      afterText: "Workspace B committed\n",
      historyId: workspaceBWrite.history.id,
      historyRecordedAtMs: workspaceBWrite.history.recordedAtMs,
      expectedChangeSet: {
        kind: workspaceBWrite.history.kind,
        author: workspaceBWrite.history.author,
        summary: workspaceBWrite.history.summary,
        files: workspaceBWrite.history.files,
        boundaryCrossings: workspaceBWrite.history.boundaryCrossings,
        ...(workspaceBWrite.history.provenance
          ? { provenance: workspaceBWrite.history.provenance }
          : {}),
      },
      versionMutationMomentId: workspaceBWrite.snapshot.latestMomentId,
    });
    const restartedA = workspace(counters, undefined, "workspace-a");
    const restartedB = workspace(counters, undefined, "workspace-b");

    await expect(restartedA.readTextFile({ path: "notes/workspace-a.md" })).resolves.toBe(
      "Workspace A live\n",
    );
    await expect(restartedB.readTextFile({ path: "notes/workspace-b.md" })).resolves.toBe(
      "Workspace B committed\n",
    );
    await expectHistoryIds(restartedA, [workspaceAWrite.history.id]);
    await expectHistoryIds(restartedB, [workspaceBWrite.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
  });

  itAnchoredFilesystem("fails closed on pending journals with mismatched disk targets", async () => {
    await writeFixture("notes/live.md", "After\n");
    await writeFixture("notes/crafted.md", "Crafted\n");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000012",
      versionId: "main",
      path: "notes/live.md",
      phase: "disk-mutated",
      targetPath: join(root, "notes/crafted.md"),
      beforeText: "Before\n",
      afterText: "After\n",
      historyId: "history_mismatched_target",
    });

    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/live.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    await expect(readFile(join(root, "notes/live.md"), "utf8")).resolves.toBe("After\n");
    await expect(readFile(join(root, "notes/crafted.md"), "utf8")).resolves.toBe("Crafted\n");
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000012.json",
    ]);
  });

  itAnchoredFilesystem("fails closed on malformed root pending journals", async () => {
    await writeFixture("notes/shared.md", "Workspace A live\n");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000011",
      workspaceId: "workspace-b",
      versionId: "main",
      path: "notes/shared.md",
      phase: "not-a-real-phase",
      historyId: "history_malformed_other_workspace",
    });

    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/shared.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000011.json",
    ]);
  });

  itAnchoredFilesystem("keeps committed history when a post-commit pending journal is recovered", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const committed = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Committed\n",
      versionId: written.versionId,
    });
    const backupPath = join(root, ".dohc", "tmp", "backup-history-committed.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000005",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "history-recorded",
      backupPath,
      historyId: committed.history.id,
      historyRecordedAtMs: committed.history.recordedAtMs,
      expectedChangeSet: {
        kind: committed.history.kind,
        author: committed.history.author,
        summary: committed.history.summary,
        files: committed.history.files,
        boundaryCrossings: committed.history.boundaryCrossings,
        ...(committed.history.provenance ? { provenance: committed.history.provenance } : {}),
      },
      versionMutationMomentId: committed.snapshot.latestMomentId,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Committed\n",
    );
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Committed\n" });
    await expectHistoryIds(restarted, [committed.history.id, written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("recovers a version-recording write journal after the version moment commits", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await writeFile(join(root, "notes/today.md"), "Crashed\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-version-recording-write.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000003",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "version-recording",
      backupPath,
      historyId: "history_version_recording_write",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Original\n",
    );
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Original\n" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("recovers a created-file journal when the parent folder already vanished", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const main = await ws.ensureMainVersion();
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/new.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await rm(join(root, "notes"), { recursive: true, force: true });
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000008",
      versionId: main.id,
      path: "notes/new.md",
      phase: "version-recorded",
      before: null,
      historyId: "history_created_file_parent_missing",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/new.md" })).resolves.toBeNull();
    await expect(
      restarted.versions.readTextFile({
        versionId: main.id,
        path: "notes/new.md",
      }),
    ).resolves.toBeNull();
    await expectHistoryIds(restarted, []);
    expect(await readPendingMutationEntries()).toEqual([]);
  });

  itAnchoredFilesystem("cleans a pending journal left after rollback already restored state", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const crashedVersionWrite = await ws.unsafeInternals.versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      text: "Crashed\n",
      metadata: { origin: "local-file" },
    });
    await ws.unsafeInternals.versions.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      mutationMomentId: crashedVersionWrite.moment.id,
    });
    await writeFile(join(root, "notes/today.md"), "Original\n", "utf8");
    const backupPath = join(root, ".dohc", "tmp", "backup-already-restored.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000004",
      versionId: written.versionId,
      path: "notes/today.md",
      phase: "version-recorded",
      backupPath,
      historyId: "history_already_restored",
      versionMutationMomentId: crashedVersionWrite.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Original\n",
    );
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Original\n" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("recovers a pending delete journal by restoring disk and version state on restart", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    await chmod(join(root, "notes/today.md"), 0o755);
    const crashedVersionDelete = await ws.unsafeInternals.versions.deleteTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      metadata: { origin: "local-file" },
    });
    await rm(join(root, "notes/today.md"), { force: true });
    const backupPath = join(root, ".dohc", "tmp", "backup-delete-crash.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await chmod(backupPath, 0o755);
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000002",
      versionId: written.versionId,
      path: "notes/today.md",
      operation: "delete",
      phase: "version-recorded",
      backupPath,
      mode: 0o755,
      historyId: "history_delete_crashed",
      versionMutationMomentId: crashedVersionDelete.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Original\n",
    );
    expect((await stat(join(root, "notes/today.md"))).mode & 0o777).toBe(0o755);
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Original\n" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("recovers a version-recording delete journal after the version moment commits", async () => {
    const counters = createWorkspaceTestCounters();
    const ws = workspace(counters);
    const written = await ws.writeTextFile({
      path: "notes/today.md",
      text: "Original\n",
    });
    const crashedVersionDelete = await ws.unsafeInternals.versions.deleteTextFile({
      workspaceId: "workspace-a",
      versionId: written.versionId,
      path: "notes/today.md",
      metadata: { origin: "local-file" },
    });
    await rm(join(root, "notes/today.md"), { force: true });
    const backupPath = join(root, ".dohc", "tmp", "backup-version-recording-delete.bak");
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "Original\n", "utf8");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000005",
      versionId: written.versionId,
      path: "notes/today.md",
      operation: "delete",
      phase: "version-recording",
      backupPath,
      historyId: "history_version_recording_delete",
      versionMutationMomentId: crashedVersionDelete.moment.id,
    });

    const restarted = workspace(counters);

    await expect(restarted.readTextFile({ path: "notes/today.md" })).resolves.toBe(
      "Original\n",
    );
    await expect(
      restarted.versions.readTextFile({
        versionId: written.versionId,
        path: "notes/today.md",
      }),
    ).resolves.toMatchObject({ text: "Original\n" });
    await expectHistoryIds(restarted, [written.history.id]);
    expect(await readPendingMutationEntries()).toEqual([]);
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("reclaims a stale file mutation lock before writing", async () => {
    const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
    const token = "stale-file-mutation-lock";
    const ownerDir = join(lockDir, token);
    const ownerPath = join(ownerDir, "owner.json");
    now = 120_000;
    const staleAtMs = now - 60_000;
    await mkdir(ownerDir, { recursive: true });
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        token,
        pid: unusedPidForTest(),
        createdAtMs: staleAtMs,
        heartbeatAtMs: staleAtMs,
      })}\n`,
      "utf8",
    );
    const ws = workspace();

    await expect(
      ws.writeTextFile({ path: "notes/after-stale-lock.md", text: "Recovered\n" }),
    ).resolves.toMatchObject({ path: "notes/after-stale-lock.md" });
    await expect(readFile(join(root, "notes/after-stale-lock.md"), "utf8")).resolves.toBe(
      "Recovered\n",
    );
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("reclaims a stale file mutation lock even if the pid was reused", async () => {
    const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
    const token = "stale-reused-pid-file-mutation-lock";
    const ownerDir = join(lockDir, token);
    const ownerPath = join(ownerDir, "owner.json");
    now = 120_000;
    const staleAtMs = now - 60_000;
    await mkdir(ownerDir, { recursive: true });
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        token,
        pid: process.pid,
        createdAtMs: staleAtMs,
        heartbeatAtMs: staleAtMs,
      })}\n`,
      "utf8",
    );
    const ws = workspace();

    await expect(
      ws.writeTextFile({ path: "notes/after-stale-reused-pid-lock.md", text: "Recovered\n" }),
    ).resolves.toMatchObject({ path: "notes/after-stale-reused-pid-lock.md" });
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("reclaims a file mutation lock with a future heartbeat", async () => {
    const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
    const token = "future-file-mutation-lock";
    const ownerDir = join(lockDir, token);
    const ownerPath = join(ownerDir, "owner.json");
    now = Date.now();
    const futureAtMs = now + 60_000;
    await mkdir(ownerDir, { recursive: true });
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        token,
        pid: unusedPidForTest(),
        createdAtMs: futureAtMs,
        heartbeatAtMs: futureAtMs,
      })}\n`,
      "utf8",
    );
    const ws = workspace();

    await expect(
      ws.writeTextFile({ path: "notes/after-future-lock.md", text: "Recovered\n" }),
    ).resolves.toMatchObject({ path: "notes/after-future-lock.md" });
    await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itAnchoredFilesystem("refuses to reclaim symlinked file mutation locks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-versioned-files-lock-target-"));
    try {
      const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
      await mkdir(dirname(lockDir), { recursive: true });
      await writeFile(join(outside, "marker.txt"), "keep\n", "utf8");
      await symlink(outside, lockDir, "dir");
      const ws = workspace();

      await expect(
        ws.writeTextFile({ path: "notes/symlink-lock.md", text: "blocked\n" }),
      ).rejects.toMatchObject({ code: "recovery-failed" });
      await expect(readFile(join(outside, "marker.txt"), "utf8")).resolves.toBe("keep\n");
      await expect(readFile(join(root, "notes/symlink-lock.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  itAnchoredFilesystem("ignores symlinked file mutation lock owners before reclaiming stale locks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-versioned-files-lock-owner-"));
    try {
      const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
      const token = "symlink-file-mutation-owner";
      const ownerDir = join(lockDir, token);
      const ownerPath = join(ownerDir, "owner.json");
      now = 120_000;
      const staleDate = new Date(now - 60_000);
      await mkdir(ownerDir, { recursive: true });
      await writeFile(join(outside, "owner.json"), "not lock metadata\n", "utf8");
      await symlink(join(outside, "owner.json"), ownerPath);
      await utimes(ownerDir, staleDate, staleDate);
      await utimes(lockDir, staleDate, staleDate);
      const ws = workspace();

      await expect(
        ws.writeTextFile({ path: "notes/after-symlink-owner-lock.md", text: "Recovered\n" }),
      ).resolves.toMatchObject({ path: "notes/after-symlink-owner-lock.md" });
      await expect(readFile(join(outside, "owner.json"), "utf8")).resolves.toBe(
        "not lock metadata\n",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  itAnchoredFilesystem("fences writes when the acquired file mutation lock is reclaimed", async () => {
    const counters = createWorkspaceTestCounters();
    const lockDir = join(root, ".dohc", "engine", "mutation-locks", "workspace.lock");
    let reclaimed = false;
    const ws = workspace(counters, {
      afterFileMutationLockAcquired: async () => {
        if (reclaimed) return;
        reclaimed = true;
        await rm(lockDir, { recursive: true, force: true });
      },
    });

    await expect(
      ws.writeTextFile({ path: "notes/reclaimed.md", text: "should not commit\n" }),
    ).rejects.toMatchObject({ code: "recovery-failed" });
    expect(reclaimed).toBe(true);
    await expect(readFile(join(root, "notes/reclaimed.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(ws.versions.listVersions()).resolves.toEqual([]);
    await expect(ws.history.list()).resolves.toEqual([]);
  });

  itAnchoredFilesystem("refuses to delete journal backup paths outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-versioned-files-backup-outside-"));
    try {
      const outsideBackup = join(outside, "backup.bak");
      await writeFile(outsideBackup, "do not delete\n", "utf8");
      await writePendingMutationJournalForTest({
        id: "pending_00000000-0000-4000-8000-000000000001",
        versionId: "main",
        path: "notes/today.md",
        phase: "prepared",
        backupPath: outsideBackup,
        historyId: "history_outside_backup",
      });
      const restarted = workspace();

      await expect(restarted.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
        code: "recovery-failed",
      });
      expect(await readPendingMutationEntries()).toEqual([
        "pending_00000000-0000-4000-8000-000000000001.json",
      ]);
      await expect(readFile(outsideBackup, "utf8")).resolves.toBe("do not delete\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  itAnchoredFilesystem("refuses journal backup paths inside the workspace but outside engine temp", async () => {
    await writeFixture("notes/backup.md", "do not delete\n");
    const workspaceBackup = join(root, "notes/backup.md");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000006",
      versionId: "main",
      path: "notes/today.md",
      phase: "prepared",
      backupPath: workspaceBackup,
      historyId: "history_workspace_backup",
    });
    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000006.json",
    ]);
    await expect(readFile(workspaceBackup, "utf8")).resolves.toBe("do not delete\n");
  });

  itAnchoredFilesystem("rejects pending journals with malformed preimage snapshots", async () => {
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000007",
      versionId: "main",
      path: "notes/today.md",
      phase: "prepared",
      before: { text: 123 },
      historyId: "history_malformed_preimage",
    });
    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000007.json",
    ]);
  });

  itAnchoredFilesystem("rejects pending write journals with missing postimages", async () => {
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000014",
      versionId: "main",
      path: "notes/missing-postimage.md",
      phase: "prepared",
      after: null,
      historyId: "history_missing_postimage",
    });
    const restarted = workspace();

    await expect(
      restarted.readTextFile({ path: "notes/missing-postimage.md" }),
    ).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000014.json",
    ]);
  });

  itAnchoredFilesystem("rejects pending journals with contradictory unavailable snapshots", async () => {
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000016",
      versionId: "main",
      path: "notes/contradictory-preimage.md",
      phase: "prepared",
      before: { text: "content\n", unavailableReason: "unreadable" },
      after: { text: "after\n" },
      historyId: "history_contradictory_preimage",
    });
    const beforeReload = workspace();
    await expect(
      beforeReload.readTextFile({ path: "notes/contradictory-preimage.md" }),
    ).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000016.json",
    ]);

    await rm(join(root, ".dohc"), { recursive: true, force: true });
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000017",
      versionId: "main",
      path: "notes/contradictory-postimage.md",
      phase: "prepared",
      before: { text: "before\n" },
      after: { text: "after\n", unavailableReason: "too-large" },
      historyId: "history_contradictory_postimage",
    });
    const afterReload = workspace();
    await expect(
      afterReload.readTextFile({ path: "notes/contradictory-postimage.md" }),
    ).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000017.json",
    ]);
  });

  itAnchoredFilesystem("rejects pending delete journals with postimages", async () => {
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000015",
      versionId: "main",
      path: "notes/delete-with-postimage.md",
      operation: "delete",
      phase: "prepared",
      after: { text: "should not exist\n" },
      historyId: "history_delete_postimage",
    });
    const restarted = workspace();

    await expect(
      restarted.readTextFile({ path: "notes/delete-with-postimage.md" }),
    ).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000015.json",
    ]);
  });

  itAnchoredFilesystem("preserves pending journals when rollback has no restorable preimage", async () => {
    await writeFixture("notes/large.md", "mutated\n");
    await writePendingMutationJournalForTest({
      id: "pending_00000000-0000-4000-8000-000000000011",
      versionId: "main",
      path: "notes/large.md",
      phase: "disk-mutated",
      before: {
        sha256: "0".repeat(64),
        sizeBytes: 8,
        unavailableReason: "too-large",
      },
      historyId: "history_unavailable_preimage",
    });
    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/large.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    await expect(readFile(join(root, "notes/large.md"), "utf8")).resolves.toBe("mutated\n");
    expect(await readPendingMutationEntries()).toEqual([
      "pending_00000000-0000-4000-8000-000000000011.json",
    ]);
  });

  itAnchoredFilesystem("rejects malformed pending journal files as recovery failures", async () => {
    const pendingDir = join(root, ".dohc", "engine", "pending-file-mutations");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(join(pendingDir, "pending_broken.json"), "{not-json", "utf8");
    const restarted = workspace();

    await expect(restarted.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual(["pending_broken.json"]);
  });

  itAnchoredFilesystem("rejects unsafe pending journal file entries during recovery", async () => {
    const pendingDir = join(root, ".dohc", "engine", "pending-file-mutations");
    await mkdir(pendingDir, { recursive: true });
    const outside = join(root, "outside-journal.json");
    await writeFile(outside, "{}", "utf8");
    await symlink(outside, join(pendingDir, "pending_symlink.json"));
    const symlinked = workspace();

    await expect(symlinked.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual(["pending_symlink.json"]);

    await rm(join(pendingDir, "pending_symlink.json"));
    await mkdir(join(pendingDir, "pending_dir.json"));
    const directory = workspace();
    await expect(directory.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual(["pending_dir.json"]);

    await rm(join(pendingDir, "pending_dir.json"), { recursive: true });
    await writeFile(join(pendingDir, "pending_large.json"), "x".repeat(129 * 1024), "utf8");
    const oversized = workspace();
    await expect(oversized.readTextFile({ path: "notes/today.md" })).rejects.toMatchObject({
      code: "recovery-failed",
    });
    expect(await readPendingMutationEntries()).toEqual(["pending_large.json"]);
  });

  itAnchoredFilesystem("rejects non-text files before decoding through the text API", async () => {
    const ws = workspace();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets/image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(ws.readTextFile({ path: "assets/image.png" })).rejects.toMatchObject({
      code: "not-text",
    });
    await expect(
      ws.writeTextFile({ path: "assets/image.png", text: "not really a png\n" }),
    ).rejects.toMatchObject({
      code: "not-text",
    });
    await expect(ws.deleteTextFile({ path: "assets/image.png" })).rejects.toMatchObject({
      code: "not-text",
    });
    await expect(readFile(join(root, "assets/image.png"))).resolves.toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  itAnchoredFilesystem("rejects symlinked paths that escape the workspace root", async () => {
    const ws = workspace();
    const outside = await mkdtemp(join(tmpdir(), "dohc-versioned-files-outside-"));
    try {
      const linkedTarget = join(outside, "target.md");
      await writeFile(linkedTarget, "outside target\n", "utf8");
      await symlink(linkedTarget, join(root, "linked.md"));
      await symlink(outside, join(root, "escape"), "dir");

      for (const path of unsafeFileWorkspacePaths()) {
        await expect(ws.writeTextFile({ path, text: "outside\n" })).rejects.toMatchObject({
          code: "invalid-path",
        });
        await expect(ws.deleteTextFile({ path })).rejects.toMatchObject({
          code: "invalid-path",
        });
        await expect(ws.restoreTextFile({ changeSetId: "missing", path })).rejects.toMatchObject({
          code: "invalid-path",
        });
      }
      await expect(ws.readTextFile({ path: "linked.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.statTextFile({ path: "linked.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(
        ws.writeTextFile({ path: "linked.md", text: "outside overwrite\n" }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(ws.deleteTextFile({ path: "linked.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(
        ws.restoreTextFile({ changeSetId: "missing", path: "linked.md" }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(
        ws.writeTextFile({ path: "escape/out.md", text: "outside\n" }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(ws.statTextFile({ path: "escape/out.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.readTextFile({ path: "escape/out.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.deleteTextFile({ path: "escape/out.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(
        ws.restoreTextFile({ changeSetId: "missing", path: "escape/out.md" }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(ws.listTextFiles()).resolves.toEqual([]);
      await expect(readFile(join(outside, "out.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(linkedTarget, "utf8")).resolves.toBe("outside target\n");
      await expect(ws.versions.listVersions()).resolves.toEqual([]);
      await expect(ws.history.list()).resolves.toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  itAnchoredFilesystem("rejects hard-linked regular files before reading or mutating", async () => {
    const ws = workspace();
    const outside = await mkdtemp(join(tmpdir(), "dohc-versioned-files-hardlink-"));
    try {
      const outsideTarget = join(outside, "shared.md");
      await writeFile(outsideTarget, "shared outside\n", "utf8");
      await mkdir(join(root, "notes"), { recursive: true });
      await link(outsideTarget, join(root, "notes/shared.md"));

      await expect(ws.readTextFile({ path: "notes/shared.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.statTextFile({ path: "notes/shared.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(ws.listTextFiles()).rejects.toMatchObject({ code: "invalid-path" });
      await expect(
        ws.writeTextFile({ path: "notes/shared.md", text: "mutated\n" }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(ws.deleteTextFile({ path: "notes/shared.md" })).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(readFile(outsideTarget, "utf8")).resolves.toBe("shared outside\n");
      await expect(ws.versions.listVersions()).resolves.toEqual([]);
      await expect(ws.history.list()).resolves.toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  itAnchoredFilesystem("rejects hard-linked regular files before restore", async () => {
    const ws = workspace();
    const outside = await mkdtemp(join(tmpdir(), "dohc-versioned-files-hardlink-restore-"));
    try {
      const written = await ws.writeTextFile({ path: "notes/tracked.md", text: "tracked\n" });
      const outsideTarget = join(outside, "shared.md");
      await writeFile(outsideTarget, "shared outside\n", "utf8");
      await rm(join(root, "notes/tracked.md"));
      await link(outsideTarget, join(root, "notes/tracked.md"));

      await expect(
        ws.restoreTextFile({
          changeSetId: written.history.id,
          path: "notes/tracked.md",
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(readFile(outsideTarget, "utf8")).resolves.toBe("shared outside\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  itAnchoredFilesystem("serializes concurrent mutations for the same text path", async () => {
    const counters = createWorkspaceTestCounters();
    const firstLockAcquired = deferred();
    const releaseFirstLock = deferred();
    let blockedFirstMutation = false;
    const wsA = workspace(counters, {
      afterFileMutationLockAcquired: async () => {
        if (blockedFirstMutation) return;
        blockedFirstMutation = true;
        firstLockAcquired.resolve();
        await releaseFirstLock.promise;
      },
    });
    const secondWriteQueued = deferred();
    const wsB = workspace(counters, {
      onWorkspaceMutationQueued: () => secondWriteQueued.resolve(),
    });

    const firstWrite = wsA.writeTextFile({ path: "notes/race.md", text: "one\n" });
    await firstLockAcquired.promise;
    const secondWrite = wsB.writeTextFile({ path: "notes/race.md", text: "two\n" });
    await secondWriteQueued.promise;
    releaseFirstLock.resolve();
    await Promise.all([firstWrite, secondWrite]);

    const liveText = await wsA.readTextFile({ path: "notes/race.md" });
    expect(liveText).toBe("two\n");
    const main = await wsA.versions.getMainVersion();
    expect(main).not.toBeNull();
    await expect(
      wsA.versions.readTextFile({
        versionId: main?.id ?? "",
        path: "notes/race.md",
      }),
    ).resolves.toMatchObject({ text: liveText });
    const histories = await wsA.history.list();
    const fileChanges = histories.flatMap((record) => record.files);
    expect(fileChanges).toHaveLength(2);
    expect(fileChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          before: null,
          after: expect.objectContaining({ text: "one\n" }),
        }),
        expect.objectContaining({
          before: expect.objectContaining({ text: "one\n" }),
          after: expect.objectContaining({ text: "two\n" }),
        }),
      ]),
    );
  });

  itAnchoredFilesystem("reports missing restore snapshots explicitly", async () => {
    const ws = workspace();
    const restore = ws.restoreTextFile({ changeSetId: "missing", path: "notes/today.md" });

    await expect(restore).rejects.toBeInstanceOf(VersionedFileWorkspaceError);
    await expect(restore).rejects.toMatchObject({ code: "restore-file-not-found" });
  });
});
