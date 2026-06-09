import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type StoredBlob = {
  objectKey: string;
  sha256: string;
  size: number;
};

export type BlobStore = {
  put(bytes: Uint8Array): Promise<StoredBlob>;
  get(objectKey: string): Promise<Uint8Array>;
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
      return new Uint8Array(await readFile(resolve(root, objectKey)));
    },
  };
}
