import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { SyncRelayStorage } from "./storage";
import type { WorkspaceSecretUsage } from "@dohc/workspace-contracts/workspace-secrets";

export const LINK_KEY_SECRET_KEY_ID = "relay-link-v1";
const WORKSPACE_SECRET_HKDF_INFO = "dohc-workspace-secret-seal-v1";
const SECRET_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const MIN_SECRET_KEY_BYTES = 32;

export interface WorkspaceSecretKeyring {
  readonly activeId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

const deriveSealingKey = (key: string | Uint8Array) =>
  Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), WORKSPACE_SECRET_HKDF_INFO, 32));

/**
 * The keys that seal workspace secrets. `secretKeys` is DOHC_RELAY_SECRET_KEYS,
 * "id:key,id:key", whose first key seals; the link key always opens secrets
 * sealed under `relay-link-v1` and seals only when `secretKeys` is unset.
 * Throws on a malformed `secretKeys`.
 */
export function workspaceSecretKeyring(input: {
  readonly linkKey: string | Uint8Array | null | undefined;
  readonly secretKeys?: string | undefined;
}): WorkspaceSecretKeyring | null {
  const keys = new Map<string, Buffer>();
  if (input.linkKey) keys.set(LINK_KEY_SECRET_KEY_ID, deriveSealingKey(input.linkKey));
  const configured = input.secretKeys?.trim() ?? "";
  if (configured === "") {
    return keys.size === 0 ? null : { activeId: LINK_KEY_SECRET_KEY_ID, keys };
  }
  let activeId: string | null = null;
  for (const entry of configured.split(",")) {
    const separator = entry.indexOf(":");
    const id = separator === -1 ? "" : entry.slice(0, separator).trim();
    const key = separator === -1 ? "" : entry.slice(separator + 1).trim();
    if (!SECRET_KEY_ID_PATTERN.test(id) || id === LINK_KEY_SECRET_KEY_ID) {
      throw new Error(
        `DOHC_RELAY_SECRET_KEYS has an invalid key id "${id}". Use 1-32 lowercase letters, digits, and dashes, other than ${LINK_KEY_SECRET_KEY_ID}.`,
      );
    }
    if (Buffer.byteLength(key, "utf8") < MIN_SECRET_KEY_BYTES) {
      throw new Error(
        `DOHC_RELAY_SECRET_KEYS key "${id}" is ${Buffer.byteLength(key, "utf8")} bytes; each key needs at least ${MIN_SECRET_KEY_BYTES} bytes.`,
      );
    }
    if (keys.has(id)) throw new Error(`DOHC_RELAY_SECRET_KEYS names key "${id}" twice.`);
    keys.set(id, deriveSealingKey(key));
    activeId ??= id;
  }
  return { activeId: activeId!, keys };
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
    readonly keyring: WorkspaceSecretKeyring;
  },
): string {
  const key = input.keyring.keys.get(input.keyId);
  if (!key) throw new Error(`Workspace secret key "${input.keyId}" is not configured.`);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
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
    readonly keyring: WorkspaceSecretKeyring;
  },
): string | null {
  const key = input.keyring.keys.get(input.keyId);
  if (!key) return null;
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
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(buildSecretAad(input));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

export interface WorkspaceSecretResealCounts {
  readonly resealed: number;
  readonly current: number;
  readonly unreadable: number;
  readonly changed: number;
}

/**
 * Seals every workspace secret under the keyring's active key, and checks that
 * the ones already under it open. A secret no configured key opens is left as
 * it is and counted as unreadable.
 */
export function resealWorkspaceSecrets(
  storage: Pick<SyncRelayStorage, "listWorkspaceSecretSeals" | "replaceWorkspaceSecretSeal">,
  keyring: WorkspaceSecretKeyring,
): WorkspaceSecretResealCounts {
  let resealed = 0;
  let current = 0;
  let unreadable = 0;
  let changed = 0;
  for (const seal of storage.listWorkspaceSecretSeals()) {
    const plaintext = unsealWorkspaceSecret({ ...seal, sealed: seal.sealedValue, keyring });
    if (plaintext === null) {
      unreadable += 1;
      continue;
    }
    if (seal.keyId === keyring.activeId) {
      current += 1;
      continue;
    }
    const sealedValue = sealWorkspaceSecret({
      ...seal,
      keyId: keyring.activeId,
      plaintext,
      keyring,
    });
    if (storage.replaceWorkspaceSecretSeal(seal, { keyId: keyring.activeId, sealedValue })) {
      resealed += 1;
    } else {
      changed += 1;
    }
  }
  return { resealed, current, unreadable, changed };
}
