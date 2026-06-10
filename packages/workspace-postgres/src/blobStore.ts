import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type StoredBlob = {
  objectKey: string;
  sha256: string;
  size: number;
};

export type BlobStore = {
  put(bytes: Uint8Array): Promise<StoredBlob>;
  get(objectKey: string): Promise<Uint8Array>;
  delete?(objectKey: string): Promise<void>;
};

export function createLocalBlobStore(
  root = process.env.DOHC_BLOB_DIR ?? resolve(process.cwd(), ".dohc-dev/blobs"),
): BlobStore {
  return {
    async put(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const objectKey = `${sha256.slice(0, 2)}/${sha256}`;
      const fullPath = resolve(root, objectKey);
      await mkdir(resolve(root, sha256.slice(0, 2)), { recursive: true });
      await writeFile(fullPath, bytes);
      return { objectKey, sha256, size: bytes.byteLength };
    },
    async get(objectKey) {
      assertSafeObjectKey(objectKey);
      return new Uint8Array(await readFile(resolve(root, objectKey)));
    },
    async delete(objectKey) {
      assertSafeObjectKey(objectKey);
      await rm(resolve(root, objectKey), { force: true });
    },
  };
}

function assertSafeObjectKey(objectKey: string) {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(objectKey)) {
    throw new Error(`invalid blob object key: ${objectKey}`);
  }
}
