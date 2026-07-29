import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import type { WorkspaceId } from "@dohc/workspace-contracts/engine";

export const SECRET_KEY_ENVELOPE_FORMAT = "dohc-key-envelope-v1";
export const SECRET_KEY_ENVELOPE_SCRYPT_N = 2 ** 17;
export const SECRET_KEY_ENVELOPE_SCRYPT_R = 8;
export const SECRET_KEY_ENVELOPE_SCRYPT_P = 1;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export class SecretKeyEnvelopeError extends Error {
  readonly code = "unwrap-failed";

  constructor(cause?: unknown) {
    super("Workspace secret key envelope could not be unwrapped.");
    this.name = "SecretKeyEnvelopeError";
    // The raw cause (JSON.parse SyntaxError text, OpenSSL error codes, scrypt
    // failures) stays debug-internal: it is deliberately NOT the standard
    // `cause` property and NOT enumerable, so structured clone across the IPC
    // boundary, JSON serialization, and object spread all produce a shape that
    // is identical for every failure mode. Nothing distinguishable about WHY
    // an unwrap failed may reach the renderer or a server.
    if (cause !== undefined) {
      Object.defineProperty(this, "debugCause", {
        value: cause,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }
}

export interface SecretKeyEnvelopeJson {
  format: typeof SECRET_KEY_ENVELOPE_FORMAT;
  saltBase64: string;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
}

function aad(workspaceId: WorkspaceId): Buffer {
  return Buffer.from(`${SECRET_KEY_ENVELOPE_FORMAT}\0${workspaceId}`, "utf8");
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function parseBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new SecretKeyEnvelopeError();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new SecretKeyEnvelopeError();
  return bytes;
}

function parseEnvelope(envelopeJson: string): SecretKeyEnvelopeJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch (error) {
    throw new SecretKeyEnvelopeError(error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretKeyEnvelopeError();
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.format !== SECRET_KEY_ENVELOPE_FORMAT ||
    envelope.scryptN !== SECRET_KEY_ENVELOPE_SCRYPT_N ||
    envelope.scryptR !== SECRET_KEY_ENVELOPE_SCRYPT_R ||
    envelope.scryptP !== SECRET_KEY_ENVELOPE_SCRYPT_P
  ) {
    throw new SecretKeyEnvelopeError();
  }
  for (const field of ["saltBase64", "ivBase64", "authTagBase64", "ciphertextBase64"]) {
    if (typeof envelope[field] !== "string") throw new SecretKeyEnvelopeError();
  }
  return envelope as unknown as SecretKeyEnvelopeJson;
}

async function deriveKek(input: {
  passphrase: string;
  salt: Buffer;
  n: number;
  r: number;
  p: number;
}): Promise<Buffer> {
  if (typeof input.passphrase !== "string" || input.passphrase.length === 0) {
    throw new SecretKeyEnvelopeError();
  }
  // N=2^17 r=8 p=1 uses roughly 128 MiB and is intended for a once-per-machine
  // desktop enrollment prompt, not a hot web-login path. Argon2id would be
  // stronger, but scrypt is Node's zero-dependency async KDF and matches the
  // 0P-D design's passphrase-wrapped key envelope.
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      input.passphrase,
      input.salt,
      KEY_BYTES,
      {
        N: input.n,
        r: input.r,
        p: input.p,
        maxmem: SCRYPT_MAXMEM,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(Buffer.from(derivedKey));
      },
    );
  });
}

export async function wrapWorkspaceDataKey(input: {
  dataKey: Uint8Array;
  passphrase: string;
  workspaceId: WorkspaceId;
}): Promise<{ envelopeJson: string }> {
  const dataKey = Buffer.from(input.dataKey);
  let kek: Buffer | null = null;
  try {
    // Everything that can throw stays inside the try so the `finally` always
    // zeros the copied dataKey — including an early length rejection and a
    // synchronous randomBytes() failure.
    if (dataKey.length !== KEY_BYTES) throw new SecretKeyEnvelopeError();
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    kek = await deriveKek({
      passphrase: input.passphrase,
      salt,
      n: SECRET_KEY_ENVELOPE_SCRYPT_N,
      r: SECRET_KEY_ENVELOPE_SCRYPT_R,
      p: SECRET_KEY_ENVELOPE_SCRYPT_P,
    });
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(aad(input.workspaceId));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const envelope: SecretKeyEnvelopeJson = {
      format: SECRET_KEY_ENVELOPE_FORMAT,
      saltBase64: b64(salt),
      scryptN: SECRET_KEY_ENVELOPE_SCRYPT_N,
      scryptR: SECRET_KEY_ENVELOPE_SCRYPT_R,
      scryptP: SECRET_KEY_ENVELOPE_SCRYPT_P,
      ivBase64: b64(iv),
      authTagBase64: b64(cipher.getAuthTag()),
      ciphertextBase64: b64(ciphertext),
    };
    return { envelopeJson: JSON.stringify(envelope) };
  } catch (error) {
    // Normalize like unwrap: never leak cipher/OpenSSL internals from the
    // wrap path either.
    if (error instanceof SecretKeyEnvelopeError) throw error;
    throw new SecretKeyEnvelopeError(error);
  } finally {
    // Best effort only: JS/V8 may have copied key material internally, so this
    // reduces exposure without claiming guaranteed erasure.
    kek?.fill(0);
    dataKey.fill(0);
  }
}

export async function unwrapWorkspaceDataKey(input: {
  envelopeJson: string;
  passphrase: string;
  workspaceId: WorkspaceId;
}): Promise<Buffer> {
  let kek: Buffer | null = null;
  try {
    const envelope = parseEnvelope(input.envelopeJson);
    const salt = parseBase64(envelope.saltBase64);
    const iv = parseBase64(envelope.ivBase64);
    const authTag = parseBase64(envelope.authTagBase64);
    const ciphertext = parseBase64(envelope.ciphertextBase64);
    kek = await deriveKek({
      passphrase: input.passphrase,
      salt,
      n: envelope.scryptN,
      r: envelope.scryptR,
      p: envelope.scryptP,
    });
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAAD(aad(input.workspaceId));
    decipher.setAuthTag(authTag);
    const dataKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (dataKey.length !== KEY_BYTES) throw new SecretKeyEnvelopeError();
    return dataKey;
  } catch (error) {
    if (error instanceof SecretKeyEnvelopeError) throw error;
    throw new SecretKeyEnvelopeError(error);
  } finally {
    // Best effort only; V8/OpenSSL may retain copies outside this Buffer.
    kek?.fill(0);
  }
}
