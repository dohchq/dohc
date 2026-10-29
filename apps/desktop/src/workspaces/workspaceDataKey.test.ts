import { randomBytes } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECRET_KEY_RELATIVE_PATH,
  installWorkspaceDataKey,
  loadSecretDataKey,
} from "./workspaceDataKey";

import { createTestScratch } from "./testTemp";
describe("desktop workspace data-key custody", () => {
  it("rejects invalid key lengths before it touches the filesystem", async () => {
    const root = await createTestScratch("dohc-desktop-data-key-");
    for (const key of [Buffer.alloc(0), randomBytes(16), randomBytes(64)]) {
      await expect(installWorkspaceDataKey(root, key)).rejects.toMatchObject({
        name: "SecretFileStoreError",
        code: "key-corrupt",
      });
    }
    await expect(access(join(root, SECRET_KEY_RELATIVE_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves creating the engine's folder to the engine", async () => {
    const root = await createTestScratch("dohc-desktop-data-key-");
    await expect(installWorkspaceDataKey(root, randomBytes(32))).rejects.toMatchObject({
      name: "SecretFileStoreError",
      code: "key-corrupt",
    });
    await expect(access(join(root, ".dohc"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reinstalls the same key and refuses to overwrite a different key", async () => {
    const root = await createTestScratch("dohc-desktop-data-key-");
    // The engine creates this folder when it opens the workspace.
    await mkdir(dirname(join(root, SECRET_KEY_RELATIVE_PATH)), { recursive: true, mode: 0o700 });
    const firstKey = randomBytes(32);
    const differentKey = randomBytes(32);

    await installWorkspaceDataKey(root, firstKey);
    const installed = await readFile(join(root, SECRET_KEY_RELATIVE_PATH), "utf8");
    await installWorkspaceDataKey(root, firstKey);
    await expect(installWorkspaceDataKey(root, differentKey)).rejects.toMatchObject({
      name: "SecretFileStoreError",
      code: "key-corrupt",
      message: expect.stringContaining("refusing to overwrite protected state"),
    });
    await expect(readFile(join(root, SECRET_KEY_RELATIVE_PATH), "utf8")).resolves.toBe(
      installed,
    );
    await expect(
      loadSecretDataKey(root, { createIfMissing: false }),
    ).resolves.toEqual(firstKey);
  });
});
