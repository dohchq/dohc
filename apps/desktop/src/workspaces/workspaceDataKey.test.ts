import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SECRET_KEY_RELATIVE_PATH,
  installWorkspaceDataKey,
  loadSecretDataKey,
} from "./workspaceDataKey";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-desktop-data-key-"));
  roots.push(root);
  return root;
}

describe("desktop workspace data-key custody", () => {
  it("rejects invalid key lengths before it touches the filesystem", async () => {
    const root = await tempRoot();
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

  it("reinstalls the same key and refuses to overwrite a different key", async () => {
    const root = await tempRoot();
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
