import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import { materializeSharedViewPaths } from "./sharedView";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import {
  routeWorkspaceFileCreate,
  routeWorkspaceFileImport,
  routeWorkspacePathDelete,
  routeWorkspacePathMove,
} from "./workspaceFileOps";

// The four remaining writes a share view admits (#802), driven the way
// `shareViewTextWrite.e2e.test.ts` drives the text save.
//
// "The recipient can send this change" is not a UI state: it is a moment in
// this replica's engine store and a row in its `replication_log`, because the
// submit lane reads exactly that log. So every case here asserts the journal
// and the projection, never the return value alone.

const engine = requireEngineBinaryOrSkip();

const requireModule = createRequire(import.meta.url);

interface Harness {
  workspaceId: string;
  rootPath: string;
  store: CaptureVersionedTextStore;
  sessions: EngineWorkspaceSessions;
}

const lifecycles: EngineDaemonLifecycle[] = [];
const sessionSets: EngineWorkspaceSessions[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sessionSets.splice(0).map((sessions) => sessions.closeAll().catch(() => undefined)),
  );
  await Promise.all(
    lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * A real daemon, a real engine store, and — for a share view — the sync
 * identity its journal needs. `workspace_journals_file_moments_in_tx` journals
 * a file moment only for a workspace that replicates, and for a share view the
 * `share_view_file_lane` row recorded here is what makes that true.
 */
async function harness(prefix: string, access?: "comment" | "edit"): Promise<Harness> {
  const rootPath = await createTestScratch(prefix);
  roots.push(rootPath);
  const workspaceId = `${prefix}${process.pid}-${Date.now()}`;
  const lifecycle = new EngineDaemonLifecycle({
    command: engine.require(),
    requestTimeoutMs: 10_000,
  });
  lifecycles.push(lifecycle);
  await lifecycle.start();
  const routes = new RelayTransportRouteGuard();
  const sessions = new EngineWorkspaceSessions(
    new RelayConfiguredDaemonClientSource(lifecycle, routes),
  );
  sessionSets.push(sessions);
  if (access) {
    const client = new EngineRelayClient({
      sessions,
      routes,
      allowInsecureLoopbackForTests: true,
      requestDeadlineMs: 10_000,
    }).bind({
      workspaceId,
      rootPath,
      relay: { baseUrl: "http://127.0.0.1:9", token: "share-view-test-token" },
    });
    await client.recordShareViewIdentity({
      grantedSelector: { paths: ["docs"], versionId: null, access },
    });
  }
  const { store } = createCaptureLiveStores({ workspaceId, rootPath }, sessions);
  return { workspaceId, rootPath, store, sessions };
}

/** The granter's files, as the share's pull leaves them: moments and a projection. */
async function seedSharedFiles(
  harnessed: Harness,
  files: readonly { path: string; text: string }[],
): Promise<void> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  for (const file of files) {
    await harnessed.store.writeTextFile({
      workspaceId: harnessed.workspaceId,
      versionId: main.id,
      path: file.path,
      text: file.text,
      metadata: { origin: "sync" },
    });
  }
  await materializeSharedViewPaths(
    harnessed.rootPath,
    harnessed.workspaceId,
    files.map((file) => ({
      path: file.path,
      operation: "write" as const,
      contentKind: "text" as const,
    })),
    harnessed.store,
  );
}

function scope(harnessed: Harness, access: "edit" = "edit") {
  return {
    workspaceId: harnessed.workspaceId,
    rootPath: harnessed.rootPath,
    shareView: { access, ended: false },
    shareViewStore: () => harnessed.store,
  };
}

async function storePaths(harnessed: Harness): Promise<string[]> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  const files = await harnessed.store.listTextFiles({
    workspaceId: harnessed.workspaceId,
    versionId: main.id,
  });
  return files.map((file) => file.path).sort();
}

// `replication_log` is what `push_share_ops` scans, so counting its rows is
// the difference between "the engine has the change" and "the recipient can
// send it".
function replicationLogRows(rootPath: string): number {
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => {
      prepare(sql: string): { get(): Record<string, unknown> | undefined };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(rootPath, ".dohc", "engine", "engine.db"), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT COUNT(*) AS rows FROM replication_log").get();
    return Number(row?.rows ?? 0);
  } finally {
    database.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

describe("share-view file operations through the real store", () => {
  it.skipIf(engine.missing)(
    "makes a recipient's new file a proposable moment, not just a file",
    async () => {
      const view = await harness("dohc-share-create-", "edit");
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
      const journalBefore = replicationLogRows(view.rootPath);

      const path = await routeWorkspaceFileCreate({
        ...scope(view),
        relativePath: "docs/added.md",
        initialText: "recipient\n",
      });

      expect(path).toBe("docs/added.md");
      expect(await storePaths(view)).toEqual(["docs/added.md", "docs/note.md"]);
      expect(
        replicationLogRows(view.rootPath),
        "MUTATION: a create that only writes the file is a change the submit lane cannot see",
      ).toBeGreaterThan(journalBefore);
      await expect(
        readFile(join(view.rootPath, "docs", "added.md"), "utf8"),
      ).resolves.toBe("recipient\n");
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "leaves a file the recipient put in the folder by hand alone",
    async () => {
      const view = await harness("dohc-share-create-local-", "edit");
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
      // A local addition: the projection holds it, the store does not, and
      // `repairSharedViewProjection` leaves it there because it is user data.
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");
      const journalBefore = replicationLogRows(view.rootPath);

      const path = await routeWorkspaceFileCreate({
        ...scope(view),
        relativePath: "docs/mine.md",
        initialText: "# overwritten\n",
      });

      expect(path).toBe("docs/mine.md");
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
        "MUTATION: a create that journals over an occupied path destroys the recipient's own file",
      ).resolves.toBe("mine\n");
      expect(replicationLogRows(view.rootPath)).toBe(journalBefore);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "renames a file in the store and moves its projection with it",
    async () => {
      const view = await harness("dohc-share-rename-", "edit");
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
      const journalBefore = replicationLogRows(view.rootPath);

      const path = await routeWorkspacePathMove({
        ...scope(view),
        fromPath: "docs/note.md",
        toPath: "docs/renamed.md",
      });

      expect(path).toBe("docs/renamed.md");
      expect(
        await storePaths(view),
        "MUTATION: a rename that only moves the file leaves the store naming the old path",
      ).toEqual(["docs/renamed.md"]);
      expect(replicationLogRows(view.rootPath)).toBeGreaterThan(journalBefore);
      await expect(
        readFile(join(view.rootPath, "docs", "renamed.md"), "utf8"),
      ).resolves.toBe("granter\n");
      expect(await exists(join(view.rootPath, "docs", "note.md"))).toBe(false);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "renames a folder as the files under it, and leaves no empty directory behind",
    async () => {
      const view = await harness("dohc-share-rename-dir-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
      ]);

      await routeWorkspacePathMove({
        ...scope(view),
        fromPath: "docs/plans",
        toPath: "docs/roadmap",
      });

      expect(
        await storePaths(view),
        "MUTATION: renaming only the directory leaves every file under it naming the old path",
      ).toEqual(["docs/roadmap/one.md", "docs/roadmap/two.md"]);
      expect(await readdir(join(view.rootPath, "docs"))).toEqual(["roadmap"]);
      await expect(
        readFile(join(view.rootPath, "docs", "roadmap", "two.md"), "utf8"),
      ).resolves.toBe("two\n");
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "deletes a file as a moment and removes its projection",
    async () => {
      const view = await harness("dohc-share-delete-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
        { path: "docs/keep.md", text: "keep\n" },
      ]);
      const journalBefore = replicationLogRows(view.rootPath);

      const result = await routeWorkspacePathDelete({
        ...scope(view),
        relativePath: "docs/note.md",
        trashItem: async () => {
          throw new Error("a share view's delete must not reach the ordinary trash path");
        },
      });

      expect(result).toEqual({ trashed: false });
      expect(
        await storePaths(view),
        "MUTATION: a delete that only removes the file leaves the store still holding it",
      ).toEqual(["docs/keep.md"]);
      expect(replicationLogRows(view.rootPath)).toBeGreaterThan(journalBefore);
      expect(await exists(join(view.rootPath, "docs", "note.md"))).toBe(false);
      await expect(
        readFile(join(view.rootPath, "docs", "keep.md"), "utf8"),
      ).resolves.toBe("keep\n");
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "refuses to send a change for a path no moment describes, and leaves the file alone",
    async () => {
      const view = await harness("dohc-share-delete-local-", "edit");
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");

      await expect(
        routeWorkspacePathDelete({
          ...scope(view),
          relativePath: "docs/mine.md",
          trashItem: async () => undefined,
        }),
        "MUTATION: deleting a path the store never had removes a file the granter can never be told about",
      ).rejects.toThrow(/not part of this shared view/);
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
      ).resolves.toBe("mine\n");

      await expect(
        routeWorkspacePathMove({
          ...scope(view),
          fromPath: "docs/mine.md",
          toPath: "docs/renamed.md",
        }),
      ).rejects.toThrow(/not part of this shared view/);
      expect(await exists(join(view.rootPath, "docs", "renamed.md"))).toBe(false);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "deletes a folder as the files under it, and removes the directory",
    async () => {
      const view = await harness("dohc-share-delete-dir-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
        { path: "docs/keep.md", text: "keep\n" },
      ]);

      await routeWorkspacePathDelete({
        ...scope(view),
        relativePath: "docs/plans",
        trashItem: async () => {
          throw new Error("a share view's delete must not reach the ordinary trash path");
        },
      });

      expect(
        await storePaths(view),
        "MUTATION: deleting only the directory leaves every file under it in the store",
      ).toEqual(["docs/keep.md"]);
      expect(await readdir(join(view.rootPath, "docs"))).toEqual(["keep.md"]);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "imports text and binary sources as moments, renames a collision, and refuses what the engine cannot own",
    async () => {
      const view = await harness("dohc-share-import-", "edit");
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
      const sourceDir = await createTestScratch("dohc-share-import-src-");
      roots.push(sourceDir);
      await writeFile(join(sourceDir, "added.md"), "imported\n", "utf8");
      await writeFile(join(sourceDir, "note.md"), "collides\n", "utf8");
      await writeFile(join(sourceDir, "picture.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
      // A local addition whose name an import would otherwise take.
      await writeFile(join(sourceDir, "mine.md"), "imported mine\n", "utf8");
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");
      // A directory: nothing the engine can own, and nothing that may land on
      // disk on its way to being refused.
      await mkdir(join(sourceDir, "folder"));
      const journalBefore = replicationLogRows(view.rootPath);

      const outcome = await routeWorkspaceFileImport({
        ...scope(view),
        absolutePaths: [
          join(sourceDir, "added.md"),
          join(sourceDir, "note.md"),
          join(sourceDir, "mine.md"),
          join(sourceDir, "picture.png"),
          join(sourceDir, "folder"),
        ],
        screenAgainstRoots: null,
        targetDir: "docs",
      });

      expect(outcome.imported.sort()).toEqual([
        "docs/added.md",
        "docs/mine (2).md",
        "docs/note (2).md",
        "docs/picture.png",
      ]);
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
        "MUTATION: an import that only asks the store overwrites the recipient's own file",
      ).resolves.toBe("mine\n");
      expect(
        outcome.skipped,
        "MUTATION: a source the engine cannot own is counted as imported",
      ).toBe(1);
      expect(await storePaths(view)).toEqual([
        "docs/added.md",
        "docs/mine (2).md",
        "docs/note (2).md",
        "docs/note.md",
        "docs/picture.png",
      ]);
      expect(
        replicationLogRows(view.rootPath),
        "MUTATION: an import that only copies files is a change the submit lane cannot see",
      ).toBeGreaterThan(journalBefore);
      await expect(
        readFile(join(view.rootPath, "docs", "note (2).md"), "utf8"),
      ).resolves.toBe("collides\n");
      await expect(
        readFile(join(view.rootPath, "docs", "note.md"), "utf8"),
        "MUTATION: an import that overwrites replaces the granter's file with the recipient's",
      ).resolves.toBe("granter\n");
      await expect(
        readFile(join(view.rootPath, "docs", "picture.png")),
      ).resolves.toEqual(Buffer.from([0x89, 0x50, 0x00, 0x01]));
      expect(await exists(join(view.rootPath, "docs", "folder"))).toBe(false);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "leaves an ordinary workspace's file operations on disk, where the watcher records them",
    async () => {
      const workspace = await harness("dohc-ordinary-file-ops-");
      const ordinary = {
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        shareView: null,
        shareViewStore: () => workspace.store,
      };
      // The store is opened first so the daemon's own open-time reconciliation
      // is counted here rather than mistaken for a routed write below.
      const before = await storePaths(workspace);

      await routeWorkspaceFileCreate({
        ...ordinary,
        relativePath: "note.md",
        initialText: "hello\n",
      });
      await routeWorkspacePathMove({
        ...ordinary,
        fromPath: "note.md",
        toPath: "renamed.md",
      });

      await expect(
        readFile(join(workspace.rootPath, "renamed.md"), "utf8"),
      ).resolves.toBe("hello\n");
      expect(
        await storePaths(workspace),
        "MUTATION: an ordinary workspace writing engine-direct journals every change twice — once here, once from the watcher",
      ).toEqual(before);
    },
    60_000,
  );
});
