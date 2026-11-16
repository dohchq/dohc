import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** What share-web holds for one browser's link session. The relay checks the capability on every call. */
export interface SealedLinkSession {
  grantId: string;
  capabilityToken: string;
  expiresAtMs: number;
  /** Names the share-web process that made the seal. A share-web takes up only another process's seals. */
  sealedBy: string;
}

export interface LinkSessionSeal {
  /** The session, encrypted for the browser to hold beside the session token named in `binding`. */
  seal(binding: string, session: SealedLinkSession): string;
  /** The session a seal holds, or null for a seal this key did not make for `binding`. */
  unseal(binding: string, sealed: string): SealedLinkSession | null;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
// A sealed session is about 250 characters. A longer value is not ours, and is refused before any work.
const MAX_SEALED_CHARACTERS = 1024;

/**
 * Seals link sessions with a key made from share-web's seal secret. The secret outlasts a restart, so a browser's
 * cookie lets a share-web that has just started take the session up again. The secret is share-web's alone: what
 * a browser holds is then made from nothing the relay trusts.
 */
export function createLinkSessionSeal(sealSecret: string): LinkSessionSeal {
  const key = Buffer.from(hkdfSync("sha256", sealSecret, "", "dohc share-web link session v1", 32));
  return {
    seal(binding, session) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(binding, "utf8"));
      const body = Buffer.concat([
        cipher.update(
          JSON.stringify([
            session.grantId,
            session.capabilityToken,
            session.expiresAtMs,
            session.sealedBy,
          ]),
          "utf8",
        ),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },
    unseal(binding, sealed) {
      if (sealed.length > MAX_SEALED_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(sealed)) return null;
      const bytes = Buffer.from(sealed, "base64url");
      // Two spellings can decode to the same bytes. Only the one `seal` wrote is the seal.
      if (bytes.length <= IV_BYTES + TAG_BYTES || bytes.toString("base64url") !== sealed)
        return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
        decipher.setAAD(Buffer.from(binding, "utf8"));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const value: unknown = JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
            decipher.final(),
          ]).toString("utf8"),
        );
        if (!Array.isArray(value) || value.length !== 4) return null;
        const [grantId, capabilityToken, expiresAtMs, sealedBy] = value as unknown[];
        return typeof grantId === "string" &&
          typeof capabilityToken === "string" &&
          Number.isSafeInteger(expiresAtMs) &&
          typeof sealedBy === "string"
          ? { grantId, capabilityToken, expiresAtMs: expiresAtMs as number, sealedBy }
          : null;
      } catch {
        return null;
      }
    },
  };
}
