import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalWorkspaceRoot, createWorkspaceFolder } from "./createWorkspaceFolder";
import { readSyncHistory, recordSynced } from "./syncHistory";
import { createTestScratch } from "./testTemp";

let base: string;
let homeDir: string;
const linkType = process.platform === "win32" ? "junction" : "dir";

beforeEach(async () => {
  base = await createTestScratch("dohc-create-");
  homeDir = await createTestScratch("dohc-create-home-");
});

describe("createWorkspaceFolder", () => {
  it.each(["link", "shares", "notices"])("refuses a manifest with reserved id %s without changing it", async (workspaceId) => {
    const root = join(base, workspaceId);
    await mkdir(join(root, ".dohc"), { recursive: true });
    const manifestPath = join(root, ".dohc", "manifest.json");
    const manifest = JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" });
    await writeFile(manifestPath, manifest);

    await expect(createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" })).rejects.toMatchObject({
      name: "ReservedWorkspaceIdError",
      message: `Its workspace ID, ${workspaceId}, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again.`,
    });
    expect(await readFile(manifestPath, "utf8")).toBe(manifest);
    expect(await readdir(join(root, ".dohc"))).toEqual(["manifest.json"]);
  });

  it.each([
    ["not JSON", "{ version: 1", "unreadable", "this folder has a corrupt .dohc/manifest.json"],
    ["missing its kind", JSON.stringify({ version: 1, workspaceId: "ws-1", mode: "local-first" }), "unreadable",
      "this folder has an invalid .dohc/manifest.json: manifest kind is invalid"],
    ["from a newer dohc", JSON.stringify({ version: 2, workspaceId: "ws-1" }), "newer-version",
      "this workspace was created by a newer version of dohc (manifest v2)"],
  ])("refuses a manifest %s by its code, without changing it", async (_case, manifest, code, message) => {
    const root = join(base, "refused");
    await mkdir(join(root, ".dohc"), { recursive: true });
    const manifestPath = join(root, ".dohc", "manifest.json");
    await writeFile(manifestPath, manifest);

    await expect(createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" })).rejects.toMatchObject({
      name: "WorkspaceManifestError",
      code,
      message,
    });
    expect(await readFile(manifestPath, "utf8")).toBe(manifest);
    expect(await readdir(join(root, ".dohc"))).toEqual(["manifest.json"]);
  });

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
    await symlink(outside, join(root, ".dohc"), linkType);

    await expect(createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" })).rejects.toThrow();

    expect(await readdir(outside)).toEqual(hasManifest ? ["manifest.json"] : []);
    if (hasManifest) expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  });

  it("creates a fresh workspace with its manifest and nothing else in the folder", async () => {
    const root = join(base, "personal");
    const created = await createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" });
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
    await createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" });
    await recordSynced(root);
    // Forgetting drops only the registry entry; attaching the folder again
    // adopts its manifest and leaves the record.
    await createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" });
    expect(await readSyncHistory(root)).toBe("synced");

    const joined = join(base, "joined-history");
    await createWorkspaceFolder({ rootPath: joined, homeDir, kind: "personal", workspaceId: "ws-synced-elsewhere" });
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

    const adopted = await createWorkspaceFolder({ rootPath: root, homeDir, kind: "personal" });

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
      homeDir,
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
      homeDir,
      kind: "personal",
      workspaceId: "ws-somewhere-else",
    });
    expect(created.workspaceId).toBe("ws-already-here");
  });

  it("creates and adopts a folder reached through a link under its real path", async () => {
    const real = join(base, "real");
    const link = join(base, "link");
    await mkdir(real);
    await symlink(real, link, linkType);

    const created = await createWorkspaceFolder({ rootPath: link, homeDir, kind: "personal" });

    expect(created.rootPath).toBe(canonicalWorkspaceRoot(real));
    expect(created.rootPath).not.toBe(link);
    expect(await readdir(real)).toEqual([".dohc"]);
    expect(await createWorkspaceFolder({ rootPath: real, homeDir, kind: "personal" })).toEqual(created);
    expect(await createWorkspaceFolder({ rootPath: link, homeDir, kind: "personal" })).toEqual(created);
  });

  it("refuses a link to the home folder or the filesystem root and writes nothing there", async () => {
    await writeFile(join(homeDir, "notes.md"), "mine");
    const toHome = join(base, "home-link");
    await symlink(homeDir, toHome, linkType);
    await expect(createWorkspaceFolder({ rootPath: toHome, homeDir, kind: "personal" }))
      .rejects.toThrow("workspace root cannot be the home directory itself");
    expect(await readdir(homeDir)).toEqual(["notes.md"]);

    const toDisk = join(base, "disk-link");
    await symlink(parse(base).root, toDisk, linkType);
    await expect(createWorkspaceFolder({ rootPath: toDisk, homeDir, kind: "personal" }))
      .rejects.toThrow("workspace root cannot be the filesystem root");
  });

  it("refuses the home folder named through a link to it", async () => {
    const homeLink = join(base, "home-alias");
    await symlink(homeDir, homeLink, linkType);
    await expect(createWorkspaceFolder({ rootPath: homeDir, homeDir: homeLink, kind: "personal" }))
      .rejects.toThrow("workspace root cannot be the home directory itself");
    expect(await readdir(homeDir)).toEqual([]);
  });

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", homeDir, kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});
