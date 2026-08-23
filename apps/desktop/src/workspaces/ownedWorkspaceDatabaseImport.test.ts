import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ShareMountRecord } from "./registryStore";
import {
  createShareViewFiles,
  type ShareViewFilesDependencies,
  type ShareViewFilesStore,
} from "./shareViewFiles";
import { resolveRegisteredShareViewFilesTarget } from "./shareViewFilesTarget";
import { importOwnedWorkspaceDatabase } from "./ownedWorkspaceDatabaseImport";
import { readDatabaseSnapshot } from "./workspaceDatabase";
import { createTestScratch } from "./testTemp";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaceTextLimits";

const SOURCE_PATH = "shared-with-me/alice/data.csv";

function mount(): ShareMountRecord {
  return {
    shareId: "share-database-import",
    label: "alice",
    granterEmail: "alice@example.com",
    relayUrl: "https://relay.example.com",
    grantedSelector: { access: "view", paths: [], versionId: null },
  };
}

function ownerFiles(input: {
  workspace: {
    workspaceId: string;
    rootPath: string;
    shareMounts: ShareMountRecord[];
  };
  sourceText: string;
}) {
  const store = {
    ensureMainVersion: vi.fn(async () => ({ id: "main" })),
    readTextFile: vi.fn(async ({ path }: { path: string }) =>
      path === "data.csv"
        ? {
            path,
            contentKind: "text" as const,
            text: input.sourceText,
          }
        : null,
    ),
    readBinaryFile: vi.fn(async () => null),
    listTextFileMetadata: vi.fn(async () => []),
  } as unknown as ShareViewFilesStore;
  const unused: Pick<
    ShareViewFilesDependencies,
    | "resolveRelay"
    | "pull"
    | "recordRefusals"
    | "markEnded"
    | "retireTarget"
    | "assertProjectionRoot"
    | "removeMount"
  > = {
    resolveRelay: async () => null,
    pull: async () => {
      throw new Error("Unexpected pull");
    },
    recordRefusals: async () => undefined,
    markEnded: async () => undefined,
    retireTarget: async () => undefined,
    assertProjectionRoot: async () => undefined,
    removeMount: async () => ({ folderLeft: false }),
  };
  return createShareViewFiles({
    ...unused,
    resolveTarget: (target) =>
      resolveRegisteredShareViewFilesTarget(input.workspace, target),
    openStore: () => store,
  });
}

describe("owned database import", () => {
  it("refuses leftover projection bytes after the mount registry becomes empty", async () => {
    const rootPath = await createTestScratch("dohc-owned-db-tombstone-");
    await mkdir(join(rootPath, "shared-with-me", "alice"), {
      recursive: true,
    });
    await writeFile(
      join(rootPath, "shared-with-me", "alice", "data.csv"),
      "id,value\n1,stale projection\n",
    );
    const unexpectedRead = vi.fn(async () => {
      throw new Error("Owner read should not run without a registered mount.");
    });
    const workspace = {
      workspaceId: "host-tombstone",
      rootPath,
      shareMounts: [],
    };

    await expect(
      importOwnedWorkspaceDatabase({
        workspace,
        files: { read: unexpectedRead },
        sourcePath: SOURCE_PATH,
        databasePath: "data.sqlite",
        tableName: "rows",
      }),
    ).rejects.toThrow(/cannot verify this mounted share/i);
    expect(unexpectedRead).not.toHaveBeenCalled();
    expect(existsSync(join(rootPath, "data.sqlite"))).toBe(false);
  });

  it("imports owner-store text instead of a hand-edited mount projection", async () => {
    const rootPath = await createTestScratch("dohc-owned-db-store-");
    const record = mount();
    const workspace = {
      workspaceId: "host-owner",
      rootPath,
      shareMounts: [record],
    };
    await mkdir(join(rootPath, "shared-with-me", record.label), {
      recursive: true,
    });
    await writeFile(
      join(rootPath, SOURCE_PATH),
      "id,value\n1,edited projection\n",
    );
    const files = ownerFiles({
      workspace,
      sourceText: "id,value\n1,canonical owner\n",
    });
    await importOwnedWorkspaceDatabase({
      workspace,
      files,
      sourcePath: SOURCE_PATH,
      databasePath: "data.sqlite",
      tableName: "rows",
    });

    const snapshot = await readDatabaseSnapshot(rootPath, "data.sqlite");
    expect(snapshot.tables[0]?.rows).toEqual([
      expect.objectContaining({ value: "canonical owner" }),
    ]);
  });

  it("imports a complete local source larger than the text editor limit", async () => {
    const rootPath = await createTestScratch("dohc-owned-db-large-");
    const sourcePath = "large.csv";
    await writeFile(
      join(rootPath, sourcePath),
      `id,value\n1,${"x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1)}\n2,complete\n`,
    );
    const unexpectedRead = vi.fn(async () => {
      throw new Error("Local imports must not ask the share owner.");
    });
    await expect(
      importOwnedWorkspaceDatabase({
        workspace: { workspaceId: "local-large", rootPath },
        files: { read: unexpectedRead },
        sourcePath,
        databasePath: "large.sqlite",
        tableName: "rows",
      }),
    ).resolves.toMatchObject({ path: "large.sqlite", rowCount: 2 });
    expect(unexpectedRead).not.toHaveBeenCalled();
  });

  it("imports a complete owner source larger than the text editor limit", async () => {
    const rootPath = await createTestScratch("dohc-owned-db-large-share-");
    const record = mount();
    const workspace = {
      workspaceId: "host-large-owner",
      rootPath,
      shareMounts: [record],
    };
    const files = ownerFiles({
      workspace,
      sourceText: `id,value\n1,${"x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1)}\n2,complete\n`,
    });

    await expect(
      importOwnedWorkspaceDatabase({
        workspace,
        files,
        sourcePath: SOURCE_PATH,
        databasePath: "large.sqlite",
        tableName: "rows",
      }),
    ).resolves.toMatchObject({ path: "large.sqlite", rowCount: 2 });
  });
});
