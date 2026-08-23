import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ShareMountRecord } from "./registryStore";
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import type { ShareViewFiles } from "./shareViewFiles";
import { createTestScratch } from "./testTemp";

describe("owned workspace complete source reads", () => {
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
    }).readCompleteSource("imports/notes.json");

    expect(source.path).toBe("imports/data.csv");
    expect(source.bytes.toString("utf8")).toBe("id,value\n1,local\n");
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
    }).readCompleteSource("shared-with-me/alice/notes.json");

    expect(source).toEqual({ path: "data.csv", bytes: ownerBytes });
    expect(read).toHaveBeenCalledWith(
      {
        kind: "mount",
        workspaceId: "host",
        shareId: mount.shareId,
      },
      { kind: "asset", path: "data.csv" },
    );
  });
});
