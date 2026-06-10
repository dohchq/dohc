import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// dohc Cloud session credentials for this desktop install. The token is
// sealed with Electron safeStorage when the OS keychain is available, but
// safeStorage cannot be imported under vitest, so the cipher is injected;
// this module stays unit-testable with a temp dir and a fake cipher.

export interface CloudCredentials {
  serverUrl: string;
  email: string;
  token: string;
}

export interface TokenCipher {
  isAvailable(): boolean;
  // encrypt() must return a string safe to embed in JSON (base64).
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const FILE_NAME = "dohc-cloud.json";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createCloudCredentialStore(options: {
  dir: string;
  cipher?: TokenCipher;
}) {
  const { dir, cipher } = options;
  const file = join(dir, FILE_NAME);

  return {
    async load(): Promise<CloudCredentials | null> {
      // Unlike the workspace registry, a missing, corrupt, or foreign
      // credential file is not data loss — it just means "logged out" — so
      // load() never throws; the worst outcome is signing in again.
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
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
      return { serverUrl: obj.serverUrl, email: obj.email, token };
    },

    async save(credentials: CloudCredentials): Promise<void> {
      // The OS keychain may be absent (Linux without a secret service, CI).
      // The "plain:" prefix documents that fallback on disk so it is never
      // silently lossy, and load() can tell the two formats apart.
      const token = cipher?.isAvailable()
        ? `enc:${cipher.encrypt(credentials.token)}`
        : `plain:${credentials.token}`;
      const payload = {
        version: 1,
        serverUrl: credentials.serverUrl,
        email: credentials.email,
        token,
      };
      await mkdir(dir, { recursive: true });
      // Atomic: write a temp file then rename over the target so a crash or
      // concurrent reader never sees a half-written credential file.
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
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
  };
}
