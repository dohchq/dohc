import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_KEY_RELATIVE_PATH, installWorkspaceDataKey, loadSecretDataKey } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => vi.mocked(writeFile).mockReset());
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
    expect(error).toMatchObject({ name: "SecretFileStoreError", code: "key-corrupt" });
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
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await actualFs.writeFile(path, payload);
      return actualFs.writeFile(...args);
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
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await symlink(target, path, "file");
      return actualFs.writeFile(...args);
    });
    const result = operation === "load"
      ? loadSecretDataKey(root, { createIfMissing: true })
      : installWorkspaceDataKey(root, key);
    await expect(result).rejects.toMatchObject({ name: "SecretFileStoreError", code: "key-corrupt" });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(payload);
  });
});
