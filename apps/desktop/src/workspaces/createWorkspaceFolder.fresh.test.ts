import { existsSync } from "node:fs";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceManifest } from "@dohc/workspace-core";
import { createWorkspaceFolderWithFreshness, FOLDER_CHANGED } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";
import { folderIdentity } from "./workspaceTrust";

// Runs between New workspace's emptiness check and its manifest write, where
// a sync client or another program can change the folder.
let meanwhile: ((rootPath: string) => Promise<void>) | null = null;
vi.mock("./workspaceMetadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceMetadata")>();
  return {
    ...actual,
    resolveWorkspaceMetadataDir: async (rootPath: string, ...rest: [] | [{ create: false }]) => {
      const run = meanwhile;
      meanwhile = null;
      await run?.(rootPath);
      return (actual.resolveWorkspaceMetadataDir as (path: string, ...more: typeof rest) => Promise<string>)(rootPath, ...rest);
    },
  };
});

afterEach(() => { meanwhile = null; });

const linkType = process.platform === "win32" ? "junction" : "dir";

async function create(rootPath: string) {
  const homeDir = await createTestScratch("dohc-fresh-home-");
  return createWorkspaceFolderWithFreshness({ rootPath, homeDir, kind: "personal", computer: { installId: "install-here", label: "This Mac" } });
}

describe("New workspace's claim that it made a folder from nothing", () => {
  it("names a folder it created, by that folder's identity", async () => {
    const root = join(await createTestScratch("dohc-fresh-"), "Trip");
    const { workspace, fresh } = await create(root);
    expect(fresh).toEqual({ folder: await folderIdentity(workspace.rootPath) });
  });

  it("names an empty folder it made a workspace of", async () => {
    const root = join(await createTestScratch("dohc-fresh-"), "Trip");
    await mkdir(root);
    expect((await create(root)).fresh).not.toBeNull();
  });

  it("names no folder that already held files", async () => {
    const root = join(await createTestScratch("dohc-fresh-"), "Trip");
    await mkdir(root);
    await writeFile(join(root, "package.json"), "{}");
    expect((await create(root)).fresh).toBeNull();
  });

  it("names no folder that a file arrived in between the check and the manifest", async () => {
    const root = join(await createTestScratch("dohc-fresh-"), "Trip");
    meanwhile = async (rootPath) => { await writeFile(join(rootPath, "package.json"), "{}"); };
    const { workspace, fresh } = await create(root);
    expect(workspace.workspaceId).toBeTruthy();
    expect(fresh).toBeNull();
  });

  it("names no folder whose manifest arrived in between, and keeps that manifest's identity", async () => {
    const root = join(await createTestScratch("dohc-fresh-"), "Trip");
    const manifest = createWorkspaceManifest({ workspaceId: "synced-trip", kind: "personal" });
    meanwhile = async (rootPath) => {
      await mkdir(join(rootPath, ".dohc"), { recursive: true });
      await writeFile(join(rootPath, ".dohc", "manifest.json"), JSON.stringify(manifest));
    };
    const { workspace, fresh } = await create(root);
    expect(workspace.workspaceId).toBe("synced-trip");
    expect(fresh).toBeNull();
  });

  it("makes no workspace when a link replaces the folder in between", async () => {
    const scratch = await createTestScratch("dohc-fresh-");
    const root = join(scratch, "Trip");
    const elsewhere = join(scratch, "elsewhere");
    await mkdir(elsewhere);
    meanwhile = async (rootPath) => {
      await rename(rootPath, join(scratch, "moved-away"));
      await symlink(elsewhere, rootPath, linkType);
    };
    await expect(create(root)).rejects.toThrow(FOLDER_CHANGED);
    // The link's target got no manifest either.
    expect(existsSync(join(elsewhere, ".dohc", "manifest.json"))).toBe(false);
  });
});
