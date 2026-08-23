import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { overlayCanonicalShareMountFiles } from "./shareMounts";
import type {
  ShareViewFileReadRequest,
  ShareViewFilesTarget,
} from "./shareViewFiles";
import {
  createOwnedWorkspaceFileReader,
  type OwnedWorkspaceFileReader,
} from "./ownedWorkspaceFileReader";
import { createOwnedWorkspaceSdkReadPort } from "./ownedWorkspaceSdkReadPort";
import { invokeWorkspaceSdkHost } from "./workspaceSdkHost";
import { PreparedWorkspaceFileRead } from "./workspaceAssets";
import {
  readDatabaseSnapshot,
  readDatabaseSnapshotFromBytes,
} from "./workspaceDatabase";
import { listFiles } from "./workspaceFiles";
import { createTestScratch } from "./testTemp";

const USER_AUTHOR: ChangeAuthor = { kind: "user", userId: "local" };
const WORKSPACE_ID = "workspace-sdk-owner-test";
const HEALTHY_SHARE_ID = "healthy-share";
const DAMAGED_SHARE_ID = "damaged-share";
const mounts = [
  { shareId: HEALTHY_SHARE_ID, label: "healthy" },
  { shareId: DAMAGED_SHARE_ID, label: "damaged" },
];

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function seedDatabase(path: string, marker: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE sentinel (id TEXT PRIMARY KEY, marker TEXT); INSERT INTO sentinel VALUES ('1', '${marker}');`,
    );
  } finally {
    database.close();
  }
}

function shareTarget(shareId: string): ShareViewFilesTarget {
  return { kind: "mount", workspaceId: WORKSPACE_ID, shareId };
}

function shareId(target: ShareViewFilesTarget): string {
  if (target.kind !== "mount") throw new Error("Expected a mount target");
  return target.shareId;
}

function readDatabaseThroughOwner(reader: OwnedWorkspaceFileReader) {
  return async (path: string) => {
    const source = await reader.readCompleteSource(path);
    return readDatabaseSnapshotFromBytes(path, source.bytes);
  };
}

async function unusedDatabaseRead(): Promise<never> {
  throw new Error("unused");
}

describe("createOwnedWorkspaceSdkReadPort", () => {
  it("skips a full owner listing for an unrestricted local search", async () => {
    const listOwnedFiles = vi.fn(async () => ({ files: [] }));
    const port = createOwnedWorkspaceSdkReadPort({
      readText: async () => {
        throw new Error("unused");
      },
      listFiles: listOwnedFiles,
      readDatabase: unusedDatabaseRead,
      hasShareState: false,
      searchSources: [],
      repairProjection: async () => {
        throw new Error("unused");
      },
    });

    const view = await port.prepareSearch();
    expect(view.listing).toBeNull();
    expect(view.allowPath("any/local/path.md")).toBe(true);
    expect(listOwnedFiles).not.toHaveBeenCalled();
  });

  it("lists through the owner when damaged share state has no search source", async () => {
    const listOwnedFiles = vi.fn(async () => ({
      files: [{ path: "notes/local.md", kind: "file" as const }],
      folders: ["notes"],
    }));
    const port = createOwnedWorkspaceSdkReadPort({
      readText: async () => {
        throw new Error("unused");
      },
      listFiles: listOwnedFiles,
      readDatabase: unusedDatabaseRead,
      hasShareState: true,
      searchSources: [],
      repairProjection: async () => {
        throw new Error("unused");
      },
    });

    const view = await port.prepareSearch();
    expect(view.listing).toEqual({
      files: [{ path: "notes/local.md", kind: "file" }],
      folders: ["notes"],
    });
    expect(view.allowPath("notes/local.md")).toBe(true);
    expect(view.allowPath("shared-with-me/damaged/stale.md")).toBe(false);
    expect(listOwnedFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary and healthy search results when another mount is damaged", async () => {
    const root = await createTestScratch("dohc-sdk-search-owner-");
    roots.push(root);
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "shared-with-me", "healthy"), { recursive: true });
    await mkdir(join(root, "shared-with-me", "damaged"), { recursive: true });
    await writeFile(join(root, "notes", "ordinary.md"), "ordinary needle\n");
    await writeFile(
      join(root, "shared-with-me", "damaged", "recipient-only.md"),
      "damaged needle\n",
    );

    const healthyCanonical: ListWorkspaceFilesResult = {
      files: [{ path: "missing.md", kind: "file" as const }],
      folders: [] as string[],
    };
    const listCanonical = vi.fn(async (mount: (typeof mounts)[number]) => {
      if (mount.shareId === DAMAGED_SHARE_ID) throw new Error("damaged owner");
      return healthyCanonical;
    });
    const repaired: string[] = [];
    const failures: string[] = [];
    const port = createOwnedWorkspaceSdkReadPort({
      readText: async () => {
        throw new Error("unused");
      },
      listFiles: async () =>
        overlayCanonicalShareMountFiles({
          disk: await listFiles(root),
          mounts,
          listCanonical,
        }),
      readDatabase: unusedDatabaseRead,
      hasShareState: true,
      searchSources: mounts.map((mount) => ({
        target: shareTarget(mount.shareId),
        prefix: `shared-with-me/${mount.label}`,
      })),
      repairProjection: async (target) => {
        const id = shareId(target);
        repaired.push(id);
        if (id === DAMAGED_SHARE_ID) throw new Error("damaged projection");
        await writeFile(
          join(root, "shared-with-me", "healthy", "missing.md"),
          "healthy needle\n",
        );
      },
      onSearchSourceFailure: (source) => failures.push(shareId(source.target)),
    });
    const context = {
      workspaceRoot: root,
      writable: false,
      author: USER_AUTHOR,
      reads: port,
    };

    const prepared = await port.prepareSearch();
    expect(prepared.listing?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes/ordinary.md" }),
        expect.objectContaining({ path: "shared-with-me/healthy/missing.md" }),
      ]),
    );
    expect(prepared.listing?.files).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "shared-with-me/damaged/recipient-only.md",
        }),
      ]),
    );
    repaired.length = 0;
    failures.length = 0;

    const allResults = await invokeWorkspaceSdkHost(
      context,
      "workspace.search",
      { query: "needle" },
    );
    expect(allResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes/ordinary.md" }),
        expect.objectContaining({ path: "shared-with-me/healthy/missing.md" }),
      ]),
    );
    expect(allResults).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "shared-with-me/damaged/recipient-only.md",
        }),
      ]),
    );
    expect(repaired).toEqual([HEALTHY_SHARE_ID, DAMAGED_SHARE_ID]);
    expect(failures).toEqual([DAMAGED_SHARE_ID]);
  });

  it("classifies a missing projected canonical file as a file after repair", async () => {
    const root = await createTestScratch("dohc-sdk-search-scope-");
    roots.push(root);
    const mountRoot = join(root, "shared-with-me", "healthy");
    await mkdir(mountRoot, { recursive: true });
    const mount = mounts[0]!;
    const canonical: ListWorkspaceFilesResult = {
      files: [{ path: "restored.md", kind: "file" as const }],
      folders: [] as string[],
    };
    const port = createOwnedWorkspaceSdkReadPort({
      readText: async () => {
        throw new Error("unused");
      },
      listFiles: async () =>
        overlayCanonicalShareMountFiles({
          disk: await listFiles(root),
          mounts: [mount],
          listCanonical: async () => canonical,
        }),
      readDatabase: unusedDatabaseRead,
      hasShareState: true,
      searchSources: [
        {
          target: shareTarget(mount.shareId),
          prefix: "shared-with-me/healthy",
        },
      ],
      repairProjection: async () => {
        await writeFile(join(mountRoot, "restored.md"), "restored needle\n");
      },
    });

    await expect(
      invokeWorkspaceSdkHost(
        {
          workspaceRoot: root,
          writable: false,
          author: USER_AUTHOR,
          reads: port,
        },
        "workspace.search",
        {
          query: "needle",
          path:
            process.platform === "win32"
              ? "SHARED-WITH-ME/HEALTHY/RESTORED.MD"
              : "shared-with-me/healthy/restored.md",
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ path: "shared-with-me/healthy/restored.md" }),
    ]);
  });

  it("reads a shared database from owner bytes and refuses a recipient-only database", async () => {
    const root = await createTestScratch("dohc-sdk-database-owner-");
    roots.push(root);
    const mountRoot = join(root, "shared-with-me", "healthy");
    await mkdir(mountRoot, { recursive: true });
    const canonicalSeed = join(root, "canonical-seed.sqlite");
    seedDatabase(canonicalSeed, "canonical owner");
    const canonicalWalMode = new DatabaseSync(canonicalSeed);
    canonicalWalMode.exec("PRAGMA journal_mode = WAL;");
    canonicalWalMode.close();
    const canonicalBytes = await readFile(canonicalSeed);
    const projectionPath = join(mountRoot, "canonical.sqlite");
    seedDatabase(projectionPath, "projection main");
    const recipientOnlyPath = join(mountRoot, "recipient-only.sqlite");
    seedDatabase(recipientOnlyPath, "recipient only");
    await symlink(projectionPath, join(root, "shared-alias.sqlite"), "file");
    const projection = new DatabaseSync(projectionPath);
    projection.exec(
      "PRAGMA journal_mode = WAL; UPDATE sentinel SET marker = 'projection wal';",
    );
    await expect(readFile(`${projectionPath}-wal`)).resolves.not.toHaveLength(0);
    await expect(
      readDatabaseSnapshot(
        root,
        "shared-with-me/healthy/canonical.sqlite",
      ),
    ).resolves.toMatchObject({
      tables: [
        {
          name: "sentinel",
          rows: [expect.objectContaining({ marker: "projection wal" })],
        },
      ],
    });

    const readOwner = vi.fn(
      async (
        _target: ShareViewFilesTarget,
        request: ShareViewFileReadRequest,
      ) => {
        if (request.kind !== "asset" || request.path !== "canonical.sqlite") {
          throw new Error(`Shared file not found: ${request.path}`);
        }
        return {
          kind: "asset" as const,
          bytes: canonicalBytes,
          mediaType: "application/octet-stream",
        };
      },
    );
    const mount = mounts[0]!;
    const reader = createOwnedWorkspaceFileReader({
      workspace: {
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        shareMounts: [mount],
      },
      files: { read: readOwner },
    });
    const port = createOwnedWorkspaceSdkReadPort({
      readText: async () => {
        throw new Error("unused");
      },
      listFiles: () => listFiles(root),
      readDatabase: readDatabaseThroughOwner(reader),
      hasShareState: true,
      searchSources: [
        {
          target: shareTarget(mount.shareId),
          prefix: "shared-with-me/healthy",
        },
      ],
      repairProjection: async () => {},
    });
    const context = {
      workspaceRoot: root,
      writable: false,
      author: USER_AUTHOR,
      reads: port,
    };

    try {
      const snapshot = await invokeWorkspaceSdkHost(context, "databases.read", {
        path: "shared-with-me/healthy/canonical.sqlite",
      });
      expect(snapshot).toMatchObject({
        path: "shared-with-me/healthy/canonical.sqlite",
        tables: [
          {
            name: "sentinel",
            rows: [expect.objectContaining({ marker: "canonical owner" })],
          },
        ],
      });
      expect(readOwner).toHaveBeenCalledTimes(1);

      const aliasSnapshot = await invokeWorkspaceSdkHost(
        context,
        "databases.read",
        { path: "shared-alias.sqlite" },
      );
      expect(aliasSnapshot).toMatchObject({
        path: "shared-alias.sqlite",
        tables: [
          {
            name: "sentinel",
            rows: [expect.objectContaining({ marker: "canonical owner" })],
          },
        ],
      });

      await expect(
        invokeWorkspaceSdkHost(context, "databases.read", {
          path: "shared-with-me/healthy/recipient-only.sqlite",
        }),
      ).rejects.toThrow(/shared file not found/i);
      expect(readOwner).toHaveBeenCalledTimes(3);
    } finally {
      projection.close();
    }
  });

  it("keeps an SDK database read with its prepared local owner after alias retargeting", async () => {
    const root = await createTestScratch("dohc-sdk-database-retarget-");
    roots.push(root);
    const localPath = join(root, "data", "local.sqlite");
    const cachePath = join(
      root,
      "shared-with-me",
      "owner",
      "cache.sqlite",
    );
    const aliasPath = join(root, "source.sqlite");
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(root, "shared-with-me", "owner"), { recursive: true });
    seedDatabase(localPath, "local owner");
    seedDatabase(cachePath, "recipient cache");
    await symlink(localPath, aliasPath, "file");

    const unexpectedOwnerRead = vi.fn(async () => {
      throw new Error("An unowned projection must not become local bytes.");
    });
    const reader = createOwnedWorkspaceFileReader({
      workspace: {
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        shareMounts: [],
      },
      files: { read: unexpectedOwnerRead },
    });
    const port = createOwnedWorkspaceSdkReadPort({
      readText: async () => {
        throw new Error("unused");
      },
      listFiles: () => listFiles(root),
      readDatabase: readDatabaseThroughOwner(reader),
      hasShareState: true,
      searchSources: [],
      repairProjection: async () => {},
    });

    const originalReadAsset = PreparedWorkspaceFileRead.prototype.readAsset;
    const retarget = vi
      .spyOn(PreparedWorkspaceFileRead.prototype, "readAsset")
      .mockImplementation(async function (this: PreparedWorkspaceFileRead) {
        await rm(aliasPath);
        await symlink(cachePath, aliasPath, "file");
        return originalReadAsset.call(this);
      });
    try {
      await expect(
        invokeWorkspaceSdkHost(
          {
            workspaceRoot: root,
            writable: false,
            author: USER_AUTHOR,
            reads: port,
          },
          "databases.read",
          { path: "source.sqlite" },
        ),
      ).resolves.toMatchObject({
        path: "source.sqlite",
        tables: [
          {
            name: "sentinel",
            rows: [expect.objectContaining({ marker: "local owner" })],
          },
        ],
      });
      expect(unexpectedOwnerRead).not.toHaveBeenCalled();
      await expect(reader.readCompleteSource("source.sqlite")).rejects.toThrow(
        /no share owns it/i,
      );
    } finally {
      retarget.mockRestore();
    }
  });

  it("removes its private database snapshot when SQLite rejects owner bytes", async () => {
    const prefix = "dohc-database-snapshot-";
    const before = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)),
    );

    await expect(
      readDatabaseSnapshotFromBytes(
        "shared-with-me/healthy/broken.sqlite",
        Buffer.from("not a sqlite database"),
      ),
    ).rejects.toThrow();

    const after = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)),
    );
    expect(after).toEqual(before);
  });
});
