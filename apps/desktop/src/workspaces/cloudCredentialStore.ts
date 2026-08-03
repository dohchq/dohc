import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// dohc Cloud session credentials for this desktop install. The token is
// sealed with Electron safeStorage when the OS keychain is available, but
// safeStorage cannot be imported under vitest, so the cipher is injected;
// this module stays unit-testable with a temp dir and a fake cipher.

export interface CloudCredentials {
  serverUrl: string;
  relayUrl?: string;
  email: string;
  // The Better Auth user id (an opaque uuid). This is the stable author key,
  // so a signed-in session cannot exist without it.
  userId: string;
  token: string;
}

export interface TokenCipher {
  isAvailable(): boolean;
  // encrypt() must return a string safe to embed in JSON (base64).
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const FILE_NAME = "dohc-cloud.json";
const INVALID_FILE_NAME = "dohc-cloud-invalid.json";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createCloudCredentialStore(options: {
  dir: string;
  cipher?: TokenCipher;
}) {
  const { dir, cipher } = options;
  const file = join(dir, FILE_NAME);
  const invalidFile = join(dir, INVALID_FILE_NAME);

  return {
    async load(): Promise<CloudCredentials | null> {
      // Unlike the workspace registry, a missing, corrupt, or foreign
      // credential file is not data loss — it just means "logged out" — so
      // load() never throws; the worst outcome is signing in again.
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
        // Heal lax perms on existing installs: the file holds a full account
        // credential, so it must be owner-only. No-op/ignored on Windows.
        await chmod(file, 0o600).catch(() => undefined);
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.version !== 1) return null;
      if (
        !nonEmptyString(obj.serverUrl) ||
        !nonEmptyString(obj.email) ||
        !nonEmptyString(obj.userId) ||
        !nonEmptyString(obj.token)
      ) {
        return null;
      }
      let token: string;
      if (obj.token.startsWith("enc:")) {
        // A token sealed on another machine, or orphaned by a keychain
        // reset, is undecryptable; that must read as logged-out, not crash.
        if (!cipher) return null;
        try {
          token = cipher.decrypt(obj.token.slice("enc:".length));
        } catch {
          return null;
        }
      } else if (obj.token.startsWith("plain:")) {
        token = obj.token.slice("plain:".length);
      } else {
        return null;
      }
      if (!nonEmptyString(token)) return null;
      return {
        serverUrl: obj.serverUrl,
        ...(nonEmptyString(obj.relayUrl) ? { relayUrl: obj.relayUrl } : {}),
        email: obj.email,
        userId: obj.userId,
        token,
      };
    },

    async save(credentials: CloudCredentials): Promise<void> {
      if (
        !credentials ||
        !nonEmptyString(credentials.serverUrl) ||
        !nonEmptyString(credentials.email) ||
        !nonEmptyString(credentials.userId) ||
        !nonEmptyString(credentials.token) ||
        (credentials.relayUrl !== undefined &&
          !nonEmptyString(credentials.relayUrl))
      ) {
        throw new Error(
          "Cannot save cloud credentials: serverUrl, email, userId, and token must be non-empty strings; relayUrl must be non-empty when set.",
        );
      }
      // The OS keychain may be absent (Linux without a secret service, CI).
      // The "plain:" prefix documents that fallback on disk so it is never
      // silently lossy, and load() can tell the two formats apart.
      const token = cipher?.isAvailable()
        ? `enc:${cipher.encrypt(credentials.token)}`
        : `plain:${credentials.token}`;
      const payload = {
        version: 1,
        serverUrl: credentials.serverUrl,
        ...(credentials.relayUrl ? { relayUrl: credentials.relayUrl } : {}),
        email: credentials.email,
        userId: credentials.userId,
        token,
      };
      // 0700 dir + 0600 file: the session token is a full account credential,
      // so it must never be world-readable (the plain: fallback fires exactly
      // on Linux/WSL without a secret service). Mode args are ignored on
      // Windows, so this stays cross-platform safe.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Atomic: write a temp file then rename over the target so a crash or
      // concurrent reader never sees a half-written credential file. The 0600
      // mode is set on the temp file so the rename preserves it.
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    },

    async clear(): Promise<void> {
      try {
        await unlink(file);
      } catch (error) {
        // Clearing an already-logged-out store is a no-op, not a failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },

    // The invalid-session marker: a session the relay proved dead whose
    // credential record could not be deleted. Persisted beside the record so
    // a RESTART cannot read the dead record back as connected — the marker
    // holds a token hash, never the token, so it needs no sealing.
    async loadInvalidMarker() {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(invalidFile, "utf8"));
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.version !== 1) return null;
      if (
        !nonEmptyString(obj.serverUrl) ||
        !nonEmptyString(obj.userId) ||
        !nonEmptyString(obj.tokenHash)
      ) {
        return null;
      }
      return {
        serverUrl: obj.serverUrl,
        userId: obj.userId,
        tokenHash: obj.tokenHash,
      };
    },

    async saveInvalidMarker(marker: {
      serverUrl: string;
      userId: string;
      tokenHash: string;
    }) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const payload = { version: 1, ...marker };
      const tmp = `${invalidFile}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, invalidFile);
    },

    async clearInvalidMarker() {
      try {
        await unlink(invalidFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
