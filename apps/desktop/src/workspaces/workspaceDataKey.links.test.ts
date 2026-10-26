import { link, open, lstat, mkdir, realpath, readFile, readlink, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_KEY_RELATIVE_PATH, installWorkspaceDataKey, loadSecretDataKey } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath), link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => {
  vi.mocked(realpath).mockReset();
  vi.mocked(link).mockReset();
  vi.mocked(open).mockReset();
});
const key = Buffer.alloc(32, 7);
const payload = `dohc-secret-key-v1:${key.toString("base64")}\n`;
const operations = [
  { name: "load and create", run: (root: string) => loadSecretDataKey(root, { createIfMissing: true }) },
  { name: "load without creating", run: (root: string) => loadSecretDataKey(root, { createIfMissing: false }) },
  { name: "install", run: (root: string) => installWorkspaceDataKey(root, key) },
];

describe.each(operations)("$name key custody", ({ run }) => {
  it.each([false, true])("refuses a key link without changing its target (target exists: %s)", async (exists) => {
    const base = await createTestScratch("dohc-data-key-link-");
    const root = join(base, "workspace"), path = join(root, SECRET_KEY_RELATIVE_PATH);
    const target = join(base, "outside.key");
    await mkdir(dirname(path), { recursive: true });
    if (exists) await writeFile(target, payload);
    await symlink(target, path, "file");
    const link = await readlink(path);
    const before = exists ? await lstat(target) : null;
    const error = await run(root).then(() => null, (error: unknown) => error);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe(link);
    if (exists) {
      expect(await readFile(target, "utf8")).toBe(payload);
      const after = await lstat(target);
      expect(after.mtimeMs).toBe(before!.mtimeMs);
      expect(after.mode).toBe(before!.mode);
    } else {
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(error).toMatchObject({
      name: "SecretFileStoreError",
      code: "key-corrupt",
      message: "dohc didn't use .dohc/engine/secret.key because it isn't a regular file. Replace it with this workspace's key file.",
    });
  });

  describe.each([".dohc", ".dohc/engine"])("linked ancestor %s", (ancestor) => {
    it.each([false, true])("refuses without reading or writing a foreign key (target exists: %s)", async (exists) => {
      const base = await createTestScratch("dohc-data-key-ancestor-");
      const root = join(base, "workspace");
      const target = join(base, "foreign");
      const targetKey = join(target, ancestor === ".dohc" ? "engine/secret.key" : "secret.key");
      const linkPath = join(root, ancestor);
      await mkdir(dirname(linkPath), { recursive: true });
      await mkdir(dirname(targetKey), { recursive: true });
      const foreignPayload = `dohc-secret-key-v1:${Buffer.alloc(32, 9).toString("base64")}\n`;
      if (exists) await writeFile(targetKey, foreignPayload);
      await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
      const before = exists ? await lstat(targetKey) : null;
      const entries = await readdir(dirname(targetKey));

      await expect(run(root)).rejects.toMatchObject({
        name: "SecretFileStoreError",
        code: "key-corrupt",
        message: "dohc didn't use .dohc/engine/secret.key because its folder resolves through a link. Move the folder the link points to into this workspace in place of the link.",
      });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readdir(dirname(targetKey))).toEqual(entries);
      if (exists) {
        expect(await readFile(targetKey, "utf8")).toBe(foreignPayload);
        const after = await lstat(targetKey);
        expect(after.mtimeMs).toBe(before!.mtimeMs);
        expect(after.mode).toBe(before!.mode);
      } else {
        await expect(lstat(targetKey)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it.each([false, true])("names a missing key folder (metadata folder exists: %s)", async (metadataExists) => {
    const root = await createTestScratch("dohc-data-key-missing-folder-");
    if (metadataExists) await mkdir(join(root, ".dohc"));
    await expect(run(root)).rejects.toMatchObject({
      name: "SecretFileStoreError",
      code: "key-corrupt",
      message: "The .dohc/engine folder is missing. Restore this workspace's .dohc/engine folder, then try again.",
    });
    expect(open).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    await expect(lstat(join(root, ".dohc", "engine"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the general words for a folder check denied by the filesystem", async () => {
    const root = await createTestScratch("dohc-data-key-folder-denied-");
    await mkdir(join(root, ".dohc", "engine"), { recursive: true });
    vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(run(root)).rejects.toMatchObject({
      name: "SecretFileStoreError",
      code: "key-corrupt",
      message: "dohc couldn't verify .dohc/engine. Restore this workspace's .dohc/engine folder, then try again.",
    });
    expect(open).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  });

  it("accepts a workspace reached through an alias above its own key folder", async () => {
    const base = await createTestScratch("dohc-data-key-root-alias-");
    const root = join(base, "workspace");
    const alias = join(base, "alias");
    const path = join(root, SECRET_KEY_RELATIVE_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, payload);
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const result = await run(alias);
    if (result !== undefined) expect(result).toEqual(key);
    expect(await readFile(path, "utf8")).toBe(payload);
  });

  it("refuses a directory at the key path", async () => {
    const root = await createTestScratch("dohc-data-key-folder-");
    const path = join(root, SECRET_KEY_RELATIVE_PATH);
    await mkdir(path, { recursive: true });
    await expect(run(root)).rejects.toMatchObject({ name: "SecretFileStoreError", code: "key-corrupt" });
    expect((await lstat(path)).isDirectory()).toBe(true);
  });
});

describe.each(["load", "install"])("%s key creation race", (operation) => {
  it("reads a regular key created by a competing process", async () => {
    const root = await createTestScratch("dohc-data-key-race-");
    const path = join(root, SECRET_KEY_RELATIVE_PATH);
    await mkdir(dirname(path), { recursive: true });
    vi.mocked(link).mockImplementationOnce(async (...args) => {
      await actualFs.writeFile(path, payload);
      return actualFs.link(...args);
    });
    if (operation === "load") {
      expect(await loadSecretDataKey(root, { createIfMissing: true })).toEqual(key);
    } else {
      await installWorkspaceDataKey(root, key);
    }
    expect(await readFile(path, "utf8")).toBe(payload);
  });

  it("refuses a link discovered after EEXIST", async () => {
    const base = await createTestScratch("dohc-data-key-race-link-");
    const root = join(base, "workspace");
    const path = join(root, SECRET_KEY_RELATIVE_PATH), target = join(base, "outside.key");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(target, payload);
    vi.mocked(link).mockImplementationOnce(async (...args) => {
      await symlink(target, path, "file");
      return actualFs.link(...args);
    });
    const result = operation === "load"
      ? loadSecretDataKey(root, { createIfMissing: true })
      : installWorkspaceDataKey(root, key);
    await expect(result).rejects.toMatchObject({ name: "SecretFileStoreError", code: "key-corrupt" });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(payload);
  });
});
