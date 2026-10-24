import { randomBytes } from "node:crypto";
import { chmod, lstat, realpath, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicCreateFile } from "../atomicReplaceFile";
import type { SecretFileStoreErrorCode } from "@dohc/workspace-contracts/engine";

export const SECRET_FILE_STORE_RELATIVE_PATH = ".dohc/engine/engine.db";
export const SECRET_KEY_RELATIVE_PATH = ".dohc/engine/secret.key";

const SECRET_KEY_FILE_PREFIX = "dohc-secret-key-v1:";
const SECRET_KEY_BYTES = 32;

export class SecretFileStoreError extends Error {
  readonly code: SecretFileStoreErrorCode;

  constructor(code: SecretFileStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretFileStoreError";
    this.code = code;
  }
}

// exFAT and FAT32 have no hard links, so the key is written in place there.
// The exclusive create still never replaces a key; a reader that comes before
// the write finds a key that fails closed for that try.
function hardLinksUnsupported({ code, syscall }: NodeJS.ErrnoException): boolean {
  // libuv maps Windows ERROR_INVALID_FUNCTION (1) to EISDIR and ERROR_NOT_SUPPORTED (50) to ENOTSUP.
  // Off Windows, match materialize.rs::hard_links_unsupported; Windows EPERM remains a permissions failure.
  return syscall === "link" && (
    code === "ENOTSUP" || code === "ENOSYS" ||
    (process.platform === "win32"
      ? code === "EISDIR"
      : code === "EPERM" || code === "EOPNOTSUPP")
  );
}

function keyFilePath(rootDir: string): string {
  return join(resolve(rootDir), SECRET_KEY_RELATIVE_PATH);
}

function parseKeyFile(content: string): Buffer {
  const trimmed = content.trim();
  if (!trimmed.startsWith(SECRET_KEY_FILE_PREFIX)) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is malformed; refusing to touch protected files. (dohc never regenerates a key over an existing file — that would orphan every protected snapshot.)",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(trimmed.slice(SECRET_KEY_FILE_PREFIX.length), "base64");
  } catch {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is malformed; refusing to touch protected files.",
    );
  }
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is malformed; refusing to touch protected files.",
    );
  }
  return key;
}

// Match the Rust key directory check: aliases above the workspace are allowed,
// but the key folder must be the workspace's own real .dohc/engine.
async function verifyKeyDir(rootDir: string, path: string): Promise<void> {
  let realParent: string;
  let expected: string;
  try {
    realParent = await realpath(dirname(path));
    expected = join(await realpath(rootDir), ".dohc", "engine");
  } catch (error) {
    throw new SecretFileStoreError(
      "key-corrupt",
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "The .dohc/engine folder is missing. Restore this workspace's .dohc/engine folder, then try again."
        : "dohc couldn't verify .dohc/engine. Restore this workspace's .dohc/engine folder, then try again.",
    );
  }
  if (realParent !== expected) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "dohc didn't use .dohc/engine/secret.key because its folder resolves through a link. Move the folder the link points to into this workspace in place of the link.",
    );
  }
}

// Windows can follow a dangling file link even with "wx". Only an absent
// entry is a missing key; inspect before every read, including an EEXIST retry.
async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new SecretFileStoreError(
        "key-corrupt",
        "dohc didn't use .dohc/engine/secret.key because it isn't a regular file. Replace it with this workspace's key file.",
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadSecretDataKey(
  rootDir: string,
  options: { createIfMissing: boolean },
): Promise<Buffer> {
  const path = keyFilePath(rootDir);
  try {
    await verifyKeyDir(rootDir, path);
    if (await fileExists(path)) {
      const content = await readFile(path, "utf8");
      await chmod(path, 0o600).catch(() => undefined);
      return parseKeyFile(content);
    }
  } catch (error) {
    if (error instanceof SecretFileStoreError) throw error;
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be read; refusing to touch protected files.",
    );
  }
  if (!options.createIfMissing) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is missing but protected data exists; failing closed.",
    );
  }
  // The engine creates and protects `.dohc/engine` when it opens the
  // workspace, which callers do first. Writing here never creates it.
  const key = randomBytes(SECRET_KEY_BYTES);
  const payload = `${SECRET_KEY_FILE_PREFIX}${key.toString("base64")}\n`;
  let created: boolean;
  try {
    created = await atomicCreateFile(path, payload, 0o600, { directWriteAfter: hardLinksUnsupported });
  } catch {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be created; refusing to store protected files.",
    );
  }
  return created ? key : loadSecretDataKey(rootDir, { createIfMissing: false });
}

export async function installWorkspaceDataKey(
  rootDir: string,
  keyInput: Uint8Array,
): Promise<void> {
  const key = Buffer.from(keyInput);
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretFileStoreError("key-corrupt", "Workspace secret key has an invalid length.");
  }
  const path = keyFilePath(rootDir);
  try {
    await verifyKeyDir(rootDir, path);
    if (await fileExists(path)) {
      const existing = parseKeyFile(await readFile(path, "utf8"));
      await chmod(path, 0o600).catch(() => undefined);
      if (existing.equals(key)) return;
      throw new SecretFileStoreError(
        "key-corrupt",
        "A different workspace secret key already exists locally; refusing to overwrite protected state.",
      );
    }
  } catch (error) {
    if (error instanceof SecretFileStoreError) throw error;
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be read; refusing to install a replacement.",
    );
  }
  // As above, the engine has already created `.dohc/engine`.
  const payload = `${SECRET_KEY_FILE_PREFIX}${key.toString("base64")}\n`;
  let created: boolean;
  try {
    created = await atomicCreateFile(path, payload, 0o600, { directWriteAfter: hardLinksUnsupported });
  } catch {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be installed.",
    );
  }
  if (!created) return installWorkspaceDataKey(rootDir, key);
}
