import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { TokenCipher } from "./cloudCredentialStore";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const SealedJson = z
  .object({
    key: z.string().min(1),
    nonce: z.string().min(1),
    data: z.string().min(1),
  })
  .strict();
export type SealedJson = z.output<typeof SealedJson>;

export class SealedJsonOpenError extends Error {
  constructor() {
    super("Sealed data could not be opened.");
    this.name = "SealedJsonOpenError";
  }
}

const aadBytes = (aad: readonly string[]) => Buffer.from(JSON.stringify(aad), "utf8");

export function sealJson(cipher: TokenCipher, aad: readonly string[], value: unknown): SealedJson {
  const key = randomBytes(KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const gcm = createCipheriv("aes-256-gcm", key, nonce);
  gcm.setAAD(aadBytes(aad));
  const data = Buffer.concat([
    gcm.update(JSON.stringify(value), "utf8"),
    gcm.final(),
    gcm.getAuthTag(),
  ]);
  return {
    key: cipher.encrypt(key.toString("base64")),
    nonce: nonce.toString("base64"),
    data: data.toString("base64"),
  };
}

export function openJson(cipher: TokenCipher, aad: readonly string[], sealed: SealedJson): unknown {
  try {
    const key = Buffer.from(cipher.decrypt(sealed.key), "base64");
    const nonce = Buffer.from(sealed.nonce, "base64");
    const data = Buffer.from(sealed.data, "base64");
    if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES || data.length <= TAG_BYTES) {
      throw new SealedJsonOpenError();
    }
    const gcm = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    gcm.setAAD(aadBytes(aad));
    gcm.setAuthTag(data.subarray(data.length - TAG_BYTES));
    const plain = Buffer.concat([
      gcm.update(data.subarray(0, data.length - TAG_BYTES)),
      gcm.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as unknown;
  } catch {
    throw new SealedJsonOpenError();
  }
}
