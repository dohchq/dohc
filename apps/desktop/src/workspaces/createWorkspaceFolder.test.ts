import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFolder } from "./createWorkspaceFolder";
import { readSyncHistory, recordSynced } from "./syncHistory";
import { createTestScratch } from "./testTemp";

let base: string;

beforeEach(async () => {
  base = await createTestScratch("dohc-create-");
});

describe("createWorkspaceFolder", () => {
  it.each([false, true])("refuses linked metadata before creating or adopting a manifest (manifest present: %s)", async (hasManifest) => {
    const root = join(base, "linked-workspace");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    const manifestPath = join(outside, "manifest.json");
    const manifest = JSON.stringify({
      version: 1,
      workspaceId: "outside-workspace",
      kind: "personal",
      mode: "local-first",
    });
    if (hasManifest) await writeFile(manifestPath, manifest);
    await symlink(outside, join(root, ".dohc"), process.platform === "win32" ? "junction" : "dir");

    await expect(createWorkspaceFolder({ rootPath: root, kind: "personal" })).rejects.toThrow();

    expect(await readdir(outside)).toEqual(hasManifest ? ["manifest.json"] : []);
    if (hasManifest) expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  });

  it("creates a fresh workspace with its manifest and nothing else in the folder", async () => {
    const root = join(base, "personal");
    const created = await createWorkspaceFolder({ rootPath: root, kind: "personal" });
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      version: 1,
      kind: "personal",
      mode: "local-first",
      workspaceId: created.workspaceId,
    });
    expect(await readdir(root)).toEqual([".dohc"]);
    expect(await readSyncHistory(root), "a new folder never synced").toBe("never-synced");
  });

  it("keeps a workspace's sync history in its folder, so a reattach still knows it synced", async () => {
    const root = join(base, "reattached");
    await createWorkspaceFolder({ rootPath: root, kind: "personal" });
    recordSynced(root);
    // Forgetting drops only the registry entry; attaching the folder again
    // adopts its manifest and leaves the record.
    await createWorkspaceFolder({ rootPath: root, kind: "personal" });
    expect(await readSyncHistory(root)).toBe("synced");

    const joined = join(base, "joined-history");
    await createWorkspaceFolder({ rootPath: joined, kind: "personal", workspaceId: "ws-synced-elsewhere" });
    expect(await readSyncHistory(joined), "a join synced").toBe("synced");

    const legacy = join(base, "legacy");
    await mkdir(join(legacy, ".dohc"), { recursive: true });
    expect(await readSyncHistory(legacy), "no record is no answer").toBe("absent");
    await writeFile(join(legacy, ".dohc", "sync-history.json"), "{\"version\": 2, \"synced\": false}");
    expect(await readSyncHistory(legacy)).toBe("unknown");
  });

  it("adopts an existing workspace instead of overwriting its identity", async () => {
    const root = join(base, "existing");
    await mkdir(join(root, ".dohc"), { recursive: true });
    const existing = {
      version: 1,
      workspaceId: "ws-existing-identity",
      kind: "personal",
      mode: "local-first",
    };
    await writeFile(
      join(root, ".dohc", "manifest.json"),
      JSON.stringify(existing),
    );

    const adopted = await createWorkspaceFolder({ rootPath: root, kind: "personal" });

    expect(adopted.workspaceId).toBe("ws-existing-identity");
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest.workspaceId).toBe("ws-existing-identity");
  });

  it("adopts a requested identity for a fresh folder (join flow)", async () => {
    const root = join(base, "joined");
    const created = await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-synced-elsewhere",
    });
    expect(created.workspaceId).toBe("ws-synced-elsewhere");
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest.workspaceId).toBe("ws-synced-elsewhere");
  });

  it("never rebinds an existing manifest to a requested identity", async () => {
    const root = join(base, "existing-vs-requested");
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(
      join(root, ".dohc", "manifest.json"),
      JSON.stringify({
        version: 1,
        workspaceId: "ws-already-here",
        kind: "personal",
        mode: "local-first",
      }),
    );
    const created = await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-somewhere-else",
    });
    expect(created.workspaceId).toBe("ws-already-here");
  });

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});
