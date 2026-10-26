import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISK_ROOT_REFUSAL, FILESYSTEM_ROOT_REFUSAL, HOME_FOLDER_REFUSAL } from "@dohc/workspace-core";
import { canonicalWorkspaceRoot, createWorkspaceFolder } from "./createWorkspaceFolder";
import { readSyncHistory, recordSynced, scheduleComputer } from "./syncHistory";
import { createTestScratch } from "./testTemp";

// Seams for a folder swapped mid-open and for a mounted disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), mkdir: vi.fn(actual.mkdir), readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const computer = { installId: "install-here", label: "This Mac" };
let base: string;
let homeDir: string;
const linkType = process.platform === "win32" ? "junction" : "dir";

beforeEach(async () => {
  base = await createTestScratch("dohc-create-");
  homeDir = await createTestScratch("dohc-create-home-");
});

afterEach(() => {
  for (const seam of [lstat, mkdir, readFile, stat]) vi.mocked(seam).mockReset();
});

// stat answers as the filesystem does, except a bigint stat of `path` reports `answer`'s.
function statOf(path: string, answer: (real: import("node:fs").BigIntStats) => Promise<import("node:fs").BigIntStats>) {
  vi.mocked(stat).mockImplementation((async (target: string, options?: { bigint?: boolean }) => {
    const real = await actualFs.stat(target, options);
    return target === path && options?.bigint ? answer(real as import("node:fs").BigIntStats) : real;
  }) as typeof stat);
}

describe("createWorkspaceFolder", () => {
  it.each(["link", "shares", "notices"])("refuses a manifest with reserved id %s without changing it", async (workspaceId) => {
    const root = join(base, workspaceId);
    await mkdir(join(root, ".dohc"), { recursive: true });
    const manifestPath = join(root, ".dohc", "manifest.json");
    const manifest = JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" });
    await writeFile(manifestPath, manifest);

    await expect(createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" })).rejects.toMatchObject({
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

    await expect(createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" })).rejects.toMatchObject({
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

    await expect(createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" })).rejects.toThrow();

    expect(await readdir(outside)).toEqual(hasManifest ? ["manifest.json"] : []);
    if (hasManifest) expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  });

  it("creates a fresh workspace with its manifest and nothing else in the folder", async () => {
    const root = join(base, "personal");
    const created = await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" });
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
    // Its schedules run on the computer that made it, whichever computer reads the folder.
    expect(await scheduleComputer(root, { installId: "install-desk", label: "Desk" })).toEqual({ kind: "computer", computer });
    // So do its Collections, whose store it makes later.
    expect(JSON.parse(await readFile(join(root, ".dohc", "collections.json"), "utf8")))
      .toEqual({ version: 1, workspaceId: created.workspaceId, installId: computer.installId, label: computer.label, storeId: null });
  });

  it("names the computer that keeps Collections only for a workspace it makes, never one it adopts or joins", async () => {
    const root = join(base, "kept");
    await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" });
    const record = await readFile(join(root, ".dohc", "collections.json"), "utf8");
    await createWorkspaceFolder({ rootPath: root, homeDir, computer: { installId: "install-desk", label: "Desk" }, kind: "personal" });
    expect(await readFile(join(root, ".dohc", "collections.json"), "utf8"), "attaching again keeps the record").toBe(record);
    const joined = join(base, "joined-collections");
    await createWorkspaceFolder({ rootPath: joined, homeDir, computer, kind: "personal", workspaceId: "ws-synced-elsewhere" });
    expect(await readdir(join(joined, ".dohc"))).not.toContain("collections.json");
  });

  it("keeps a workspace's sync history in its folder, so a reattach still knows it synced", async () => {
    const root = join(base, "reattached");
    await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" });
    await recordSynced(root);
    // Forgetting drops only the registry entry; attaching the folder again
    // adopts its manifest and leaves the record.
    await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" });
    expect(await readSyncHistory(root)).toBe("synced");

    const joined = join(base, "joined-history");
    await createWorkspaceFolder({ rootPath: joined, homeDir, computer, kind: "personal", workspaceId: "ws-synced-elsewhere" });
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

    const adopted = await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" });

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
      computer,
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
      computer,
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

    const created = await createWorkspaceFolder({ rootPath: link, homeDir, computer, kind: "personal" });

    expect(created.rootPath).toBe(canonicalWorkspaceRoot(real));
    expect(created.rootPath).not.toBe(link);
    expect(await readdir(real)).toEqual([".dohc"]);
    expect(await createWorkspaceFolder({ rootPath: real, homeDir, computer, kind: "personal" })).toEqual(created);
    expect(await createWorkspaceFolder({ rootPath: link, homeDir, computer, kind: "personal" })).toEqual(created);
  });

  it("refuses a link to the home folder or the filesystem root and writes nothing there", async () => {
    await writeFile(join(homeDir, "notes.md"), "mine");
    const toHome = join(base, "home-link");
    await symlink(homeDir, toHome, linkType);
    await expect(createWorkspaceFolder({ rootPath: toHome, homeDir, computer, kind: "personal" }))
      .rejects.toThrow("workspace root cannot be the home directory itself");
    expect(await readdir(homeDir)).toEqual(["notes.md"]);

    const toDisk = join(base, "disk-link");
    await symlink(parse(base).root, toDisk, linkType);
    await expect(createWorkspaceFolder({ rootPath: toDisk, homeDir, computer, kind: "personal" }))
      .rejects.toThrow("workspace root cannot be the filesystem root");
  });

  it("refuses the home folder named through a link to it", async () => {
    const homeLink = join(base, "home-alias");
    await symlink(homeDir, homeLink, linkType);
    await expect(createWorkspaceFolder({ rootPath: homeDir, homeDir: homeLink, computer, kind: "personal" }))
      .rejects.toThrow("workspace root cannot be the home directory itself");
    expect(await readdir(homeDir)).toEqual([]);
  });

  it.each(["a link to the home folder", "another folder"] as const)(
    "writes nothing when %s replaces the folder while its manifest is inspected",
    async (replacement) => {
      const root = join(base, "swapped");
      const moved = join(base, "moved");
      await mkdir(root);
      // Each replacement has a .dohc folder, so a write that followed the path would land.
      const replaced = replacement === "another folder" ? root : homeDir;
      vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
        if (basename(String(args[0])) === "manifest.json") {
          await rename(root, moved);
          await mkdir(join(replaced, ".dohc"), { recursive: true });
          if (replacement === "a link to the home folder") await symlink(homeDir, root, linkType);
        }
        return actualFs.lstat(...args);
      }) as typeof lstat);

      await expect(createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" }))
        .rejects.toThrow("The folder changed while dohc was opening it. Open it again.");
      expect(await readdir(join(replaced, ".dohc"))).toEqual([]);
      expect(await readdir(join(moved, ".dohc"))).toEqual([]);
    },
  );

  it("refuses a folder where another disk is mounted, wherever it is, and writes nothing", async () => {
    const mounted = join(homeDir, "disk");
    await mkdir(mounted);
    // The folder's parent reports another device, as a disk mounted in home or /mnt does.
    statOf(dirname(canonicalWorkspaceRoot(mounted)), async (parent) => {
      parent.dev += 1n;
      return parent;
    });

    await expect(createWorkspaceFolder({ rootPath: mounted, homeDir, computer, kind: "personal" }))
      .rejects.toThrow(DISK_ROOT_REFUSAL);
    expect(await readdir(mounted)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses a link to a mounted filesystem such as /dev", async () => {
    const link = join(base, "device-link");
    await symlink("/dev", link, linkType);
    await expect(createWorkspaceFolder({ rootPath: link, homeDir, computer, kind: "personal" }))
      .rejects.toThrow(DISK_ROOT_REFUSAL);
  });

  // /Volumes reports the system's device, so only its identity marks it.
  it.skipIf(process.platform !== "darwin")("refuses macOS's /Volumes, directly and through a link", async () => {
    const link = join(base, "volumes-link");
    await symlink("/Volumes", link, linkType);
    for (const rootPath of ["/Volumes", link]) {
      await expect(createWorkspaceFolder({ rootPath, homeDir, computer, kind: "personal" })).rejects.toThrow(DISK_ROOT_REFUSAL);
    }
  });

  // On a case-sensitive disk, /volumes is a folder of its own; only /Volumes's identity marks it.
  it.skipIf(process.platform !== "darwin")("refuses /Volumes by identity, not by name", async () => {
    const other = join(base, "mounts");
    await mkdir(other);
    statOf("/Volumes", async () => await actualFs.stat(other, { bigint: true }));
    await expect(createWorkspaceFolder({ rootPath: other, homeDir, computer, kind: "personal" })).rejects.toThrow(DISK_ROOT_REFUSAL);
    expect(await readdir(other)).toEqual([]);
  });

  it("refuses the filesystem root under another name, as a bind mount of / gives it", async () => {
    const root = join(base, "bound-root");
    await mkdir(root);
    statOf("/", async () => await actualFs.stat(root, { bigint: true }));
    await expect(createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" }))
      .rejects.toThrow(FILESYSTEM_ROOT_REFUSAL);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a folder that is the home folder under another name, and writes nothing", async () => {
    const root = join(base, "alias");
    const otherName = join(base, "home-by-another-name");
    await mkdir(root);
    await mkdir(otherName);
    // A bind mount or firmlink gives one folder two real paths.
    statOf(otherName, async () => await actualFs.stat(root, { bigint: true }));

    await expect(createWorkspaceFolder({ rootPath: root, homeDir: otherName, computer, kind: "personal" }))
      .rejects.toThrow(HOME_FOLDER_REFUSAL);
    expect(await readdir(root)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")("refuses the home folder through macOS's data volume alias", async () => {
    const alias = `/System/Volumes/Data${canonicalWorkspaceRoot(homeDir)}`;
    expect(existsSync(alias)).toBe(true);
    await expect(createWorkspaceFolder({ rootPath: alias, homeDir, computer, kind: "personal" }))
      .rejects.toThrow(HOME_FOLDER_REFUSAL);
    expect(await readdir(homeDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps a backslash that is part of a folder's name", async () => {
    const root = join(base, "trip\\2026");
    const created = await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" });
    expect(created.rootPath).toBe(canonicalWorkspaceRoot(root));
    expect(created.rootPath.endsWith("/trip\\2026")).toBe(true);
    expect(await readdir(base)).toEqual(["trip\\2026"]);
    expect(await readdir(root)).toEqual([".dohc"]);
  });

  it("checks an existing folder before creating anything, and creates only a missing one", async () => {
    const toHome = join(base, "home-link");
    await symlink(homeDir, toHome, linkType);
    await expect(createWorkspaceFolder({ rootPath: toHome, homeDir, computer, kind: "personal" }))
      .rejects.toThrow(HOME_FOLDER_REFUSAL);
    expect(vi.mocked(mkdir).mock.calls.map(([path]) => path)).not.toContain(toHome);

    const fresh = join(base, "new", "Trip");
    await createWorkspaceFolder({ rootPath: fresh, homeDir, computer, kind: "personal" });
    expect(await readdir(fresh)).toEqual([".dohc"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "stops before writing when it cannot resolve the home folder",
    async () => {
      const locked = join(base, "locked");
      const root = join(base, "workspace");
      await mkdir(join(locked, "home"), { recursive: true });
      await mkdir(root);
      await chmod(locked, 0o000);
      try {
        await expect(createWorkspaceFolder({ rootPath: root, homeDir: join(locked, "home"), computer, kind: "personal" }))
          .rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(locked, 0o700);
      }
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", homeDir, computer, kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});

describe("manifest entry custody", () => {
  it.each([false, true])("refuses a linked manifest without changing its target (target exists: %s)", async (exists) => {
    const root = join(base, "workspace"), path = join(root, ".dohc", "manifest.json");
    const target = join(base, "outside.json");
    const content = JSON.stringify({ version: 1, workspaceId: "outside", kind: "personal", mode: "local-first" });
    await mkdir(dirname(path), { recursive: true });
    if (exists) await writeFile(target, content);
    await symlink(target, path, "file");
    const link = await readlink(path);
    const error = await createWorkspaceFolder({ rootPath: root, homeDir, computer, kind: "personal" })
      .then(() => null, (error: unknown) => error);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe(link);
    if (exists) expect(await readFile(target, "utf8")).toBe(content);
    else await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, ".dohc"))).toEqual(["manifest.json"]);
    expect(error).toMatchObject({
      name: "WorkspaceManifestError",
      code: "unreadable",
      message: "dohc didn't open .dohc/manifest.json because it isn't a regular file. Replace it with this workspace's manifest file.",
    });
  });
});
