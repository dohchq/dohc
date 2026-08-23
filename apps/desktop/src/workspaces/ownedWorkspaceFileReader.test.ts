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
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import {
  importToDatabase,
  readDatabaseSnapshot,
} from "./workspaceDatabase";
import { createTestScratch } from "./testTemp";

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

async function importThroughOwner(input: {
  rootPath: string;
  reader: ReturnType<typeof createOwnedWorkspaceFileReader>;
}) {
  const source = await input.reader.readText(SOURCE_PATH);
  if (source.truncated) throw new Error("Test source was truncated.");
  return importToDatabase(
    input.rootPath,
    { path: SOURCE_PATH, body: source.text },
    "data.sqlite",
    "rows",
  );
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
    const reader = createOwnedWorkspaceFileReader({
      workspace: {
        workspaceId: "host-tombstone",
        rootPath,
        shareMounts: [],
      },
      files: { read: unexpectedRead },
    });

    await expect(importThroughOwner({ rootPath, reader })).rejects.toThrow(
      /cannot verify this mounted share/i,
    );
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
    const reader = createOwnedWorkspaceFileReader({ workspace, files });

    await importThroughOwner({ rootPath, reader });

    const snapshot = await readDatabaseSnapshot(rootPath, "data.sqlite");
    expect(snapshot.tables[0]?.rows).toEqual([
      expect.objectContaining({ value: "canonical owner" }),
    ]);
  });
});
