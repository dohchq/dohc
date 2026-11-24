import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { WorkspaceSecretUsage } from "@dohc/workspace-contracts/workspace-secrets";

export const WORKSPACE_SECRET_KEY_ID = "relay-link-v1";
const WORKSPACE_SECRET_HKDF_INFO = "dohc-workspace-secret-seal-v1";

let sealingKeyCache: { key: string; derived: Buffer } | null = null;

function workspaceSecretSealingKey(linkKey: string | Uint8Array): Buffer {
  if (typeof linkKey === "string") {
    if (sealingKeyCache?.key !== linkKey) {
      sealingKeyCache = {
        key: linkKey,
        derived: Buffer.from(
          hkdfSync("sha256", linkKey, Buffer.alloc(0), WORKSPACE_SECRET_HKDF_INFO, 32),
        ),
      };
    }
    return sealingKeyCache.derived;
  }
  return Buffer.from(hkdfSync("sha256", linkKey, Buffer.alloc(0), WORKSPACE_SECRET_HKDF_INFO, 32));
}

export interface WorkspaceSecretAadInput {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly usage: WorkspaceSecretUsage;
  readonly allowedHosts: readonly string[];
  readonly generation: number;
  readonly keyId: string;
}

function buildSecretAad(input: WorkspaceSecretAadInput): Buffer {
  return Buffer.from(
    JSON.stringify([
      input.workspaceId,
      input.ownerUserId,
      input.name,
      input.usage,
      [...input.allowedHosts],
      input.generation,
      input.keyId,
    ]),
    "utf8",
  );
}

export function sealWorkspaceSecret(
  input: WorkspaceSecretAadInput & {
    readonly plaintext: string;
    readonly linkKey: string | Uint8Array;
  },
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", workspaceSecretSealingKey(input.linkKey), nonce);
  cipher.setAAD(buildSecretAad(input));
  const encrypted = Buffer.concat([
    cipher.update(input.plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `v1.${nonce.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function unsealWorkspaceSecret(
  input: WorkspaceSecretAadInput & {
    readonly sealed: string;
    readonly linkKey: string | Uint8Array;
  },
): string | null {
  try {
    const parts = input.sealed.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "v1" ||
      !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/u.test(part))
    ) {
      return null;
    }
    const nonce = Buffer.from(parts[1]!, "base64url");
    const encrypted = Buffer.from(parts[2]!, "base64url");
    if (nonce.length !== 12 || encrypted.length <= 16) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      workspaceSecretSealingKey(input.linkKey),
      nonce,
    );
    decipher.setAAD(buildSecretAad(input));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}
