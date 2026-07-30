import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

export async function loadSecretDataKey(
  rootDir: string,
  options: { createIfMissing: boolean },
): Promise<Buffer> {
  const path = keyFilePath(rootDir);
  try {
    const content = await readFile(path, "utf8");
    await chmod(path, 0o600).catch(() => undefined);
    return parseKeyFile(content);
  } catch (error) {
    if (error instanceof SecretFileStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SecretFileStoreError(
        "key-corrupt",
        "The workspace secret key file could not be read; refusing to touch protected files.",
      );
    }
  }
  if (!options.createIfMissing) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is missing but protected data exists; failing closed.",
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(SECRET_KEY_BYTES);
  const payload = `${SECRET_KEY_FILE_PREFIX}${key.toString("base64")}\n`;
  try {
    await writeFile(path, payload, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const content = await readFile(path, "utf8");
      await chmod(path, 0o600).catch(() => undefined);
      return parseKeyFile(content);
    }
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be created; refusing to store protected files.",
    );
  }
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
    const existing = parseKeyFile(await readFile(path, "utf8"));
    await chmod(path, 0o600).catch(() => undefined);
    if (existing.equals(key)) return;
    throw new SecretFileStoreError(
      "key-corrupt",
      "A different workspace secret key already exists locally; refusing to overwrite protected state.",
    );
  } catch (error) {
    if (error instanceof SecretFileStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SecretFileStoreError(
        "key-corrupt",
        "The workspace secret key file could not be read; refusing to install a replacement.",
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = `${SECRET_KEY_FILE_PREFIX}${key.toString("base64")}\n`;
  try {
    await writeFile(path, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return installWorkspaceDataKey(rootDir, key);
    }
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be installed.",
    );
  }
}
