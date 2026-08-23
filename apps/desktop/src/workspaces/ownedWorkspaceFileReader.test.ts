import { mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ShareMountRecord } from "./registryStore";
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import type { ShareViewFiles } from "./shareViewFiles";
import { prepareShareProjectionRead } from "./shareMounts";
import { createTestScratch } from "./testTemp";
import { WORKSPACE_ASSET_MAX_BYTES } from "./workspaceAssets";

describe("owned workspace asset reads", () => {
  it("pairs local bytes with the resolved target path", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-local-");
    await mkdir(join(rootPath, "imports"), { recursive: true });
    await writeFile(join(rootPath, "imports", "data.csv"), "id,value\n1,local\n");
    await symlink(
      join(rootPath, "imports", "data.csv"),
      join(rootPath, "imports", "notes.json"),
    );
    const read = vi.fn(async () => {
      throw new Error("A local source must not read a share owner.");
    });

    const source = await createOwnedWorkspaceFileReader({
      workspace: { workspaceId: "local", rootPath },
      files: { read: read as ShareViewFiles["read"] },
    }).readAsset("imports/notes.json");

    expect(source).toEqual({
      path: "imports/data.csv",
      kind: "asset",
      bytes: Buffer.from("id,value\n1,local\n"),
      mediaType: "application/octet-stream",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("pairs owner bytes with the resolved mount-relative target path", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-mount-");
    const mount: ShareMountRecord = {
      shareId: "share-alias",
      label: "alice",
      granterEmail: "alice@example.com",
      relayUrl: "https://relay.example.com",
      grantedSelector: { access: "view", paths: [], versionId: null },
    };
    const mountRoot = join(rootPath, "shared-with-me", mount.label);
    await mkdir(mountRoot, { recursive: true });
    await writeFile(join(mountRoot, "data.csv"), "stale projection");
    await symlink(join(mountRoot, "data.csv"), join(mountRoot, "notes.json"));
    const ownerBytes = Buffer.from("id,value\n1,owner\n");
    const read = vi.fn(async () => ({
      kind: "asset" as const,
      bytes: ownerBytes,
      mediaType: "text/csv",
    }));

    const source = await createOwnedWorkspaceFileReader({
      workspace: { workspaceId: "host", rootPath, shareMounts: [mount] },
      files: { read: read as ShareViewFiles["read"] },
    }).readAsset("shared-with-me/alice/notes.json");

    expect(source).toEqual({
      path: "data.csv",
      kind: "asset",
      bytes: ownerBytes,
      mediaType: "text/csv",
    });
    expect(read).toHaveBeenCalledWith(
      {
        kind: "mount",
        workspaceId: "host",
        shareId: mount.shareId,
      },
      { kind: "asset", path: "data.csv" },
    );
  });

  it("reads a missing mount projection from its owner without a local stat", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-missing-mount-");
    const mount: ShareMountRecord = {
      shareId: "share-missing-projection",
      label: "alice",
      granterEmail: "alice@example.com",
      relayUrl: "https://relay.example.com",
      grantedSelector: { access: "view", paths: [], versionId: null },
    };
    const ownerBytes = Buffer.from("owner bytes");
    const read = vi.fn(async () => ({
      kind: "asset" as const,
      bytes: ownerBytes,
      mediaType: "application/octet-stream",
    }));

    const source = await createOwnedWorkspaceFileReader({
      workspace: { workspaceId: "host", rootPath, shareMounts: [mount] },
      files: { read: read as ShareViewFiles["read"] },
    }).readAsset("shared-with-me/alice/missing.bin");

    expect(source).toEqual({
      path: "missing.bin",
      kind: "asset",
      bytes: ownerBytes,
      mediaType: "application/octet-stream",
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps a prepared local read local when its alias is retargeted into the projection", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-retarget-");
    const localPath = join(rootPath, "imports", "data.csv");
    const cachePath = join(
      rootPath,
      "shared-with-me",
      "alice",
      "data.csv",
    );
    const aliasPath = join(rootPath, "source.csv");
    await mkdir(join(rootPath, "imports"), { recursive: true });
    await mkdir(join(rootPath, "shared-with-me", "alice"), {
      recursive: true,
    });
    await writeFile(localPath, "id,value\n1,local owner\n");
    await writeFile(cachePath, "id,value\n1,recipient cache\n");
    await symlink(localPath, aliasPath);

    const prepared = await prepareShareProjectionRead(
      rootPath,
      "source.csv",
      [],
      true,
    );
    expect(prepared.kind).toBe("local");

    await rm(aliasPath);
    await symlink(cachePath, aliasPath);

    if (prepared.kind !== "local") throw new Error("Expected a local read.");
    await expect(prepared.source.readAsset()).resolves.toMatchObject({
      path: "imports/data.csv",
      bytes: Buffer.from("id,value\n1,local owner\n"),
    });
    await expect(
      prepareShareProjectionRead(rootPath, "source.csv", [], true),
    ).rejects.toThrow(/no share owns it/i);
  });

  it("refuses a prepared local read when its canonical target becomes a projection symlink", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-target-swap-");
    const localPath = join(rootPath, "imports", "data.csv");
    const cachePath = join(rootPath, "shared-with-me", "alice", "data.csv");
    await mkdir(join(rootPath, "imports"), { recursive: true });
    await mkdir(join(rootPath, "shared-with-me", "alice"), {
      recursive: true,
    });
    await writeFile(localPath, "id,value\n1,local owner\n");
    await writeFile(cachePath, "id,value\n1,recipient cache\n");
    const prepared = await prepareShareProjectionRead(
      rootPath,
      "imports/data.csv",
      [],
      true,
    );
    if (prepared.kind !== "local") throw new Error("Expected a local read.");

    await rm(localPath);
    await symlink(cachePath, localPath);

    await expect(prepared.source.readAsset()).rejects.toThrow(/file changed/i);
  });

  it("refuses a prepared local read when its canonical target becomes an outside symlink", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-outside-swap-");
    const outside = await createTestScratch("dohc-owned-file-outside-");
    const localPath = join(rootPath, "data.csv");
    const outsidePath = join(outside, "secret.csv");
    await writeFile(localPath, "id,value\n1,local owner\n");
    await writeFile(outsidePath, "id,value\n1,outside secret\n");
    const prepared = await prepareShareProjectionRead(
      rootPath,
      "data.csv",
      [],
      true,
    );
    if (prepared.kind !== "local") throw new Error("Expected a local read.");

    await rm(localPath);
    await symlink(outsidePath, localPath);

    await expect(prepared.source.readAsset()).rejects.toThrow(/file changed/i);
  });

  it("bounds a prepared asset read after the file grows in place", async () => {
    const rootPath = await createTestScratch("dohc-owned-file-growth-");
    const localPath = join(rootPath, "growing.bin");
    await writeFile(localPath, "small");
    const prepared = await prepareShareProjectionRead(
      rootPath,
      "growing.bin",
      [],
      false,
    );
    if (prepared.kind !== "local") throw new Error("Expected a local read.");

    await truncate(localPath, WORKSPACE_ASSET_MAX_BYTES + 1);

    await expect(prepared.source.readAsset()).rejects.toThrow(/too large/i);
  });
});
