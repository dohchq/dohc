import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCloudCredentialStore,
  type CloudCredentials,
  type TokenCipher,
} from "./cloudCredentialStore";
import { nativeTmpdir } from "./testTemp";

// Stands in for safeStorage: reversible, with a marker so decrypt() can
// reject ciphertext it did not produce (a foreign keychain's token).
const fakeCipher: TokenCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(`fake:${plain}`).toString("base64"),
  decrypt: (cipher) => {
    const decoded = Buffer.from(cipher, "base64").toString("utf8");
    if (!decoded.startsWith("fake:")) throw new Error("unrecognized ciphertext");
    return decoded.slice("fake:".length);
  },
};

const credentials: CloudCredentials = {
  serverUrl: "https://cloud.dohc.example",
  email: "ice@example.com",
  token: "session-token-123",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(nativeTmpdir(), "dohc-cloud-"));
});

function credentialFile(): string {
  return join(dir, "dohc-cloud.json");
}

describe("cloud credential store", () => {
  it("round-trips credentials through the injected cipher", async () => {
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    await store.save(credentials);
    expect(await store.load()).toEqual(credentials);

    const onDisk = await readFile(credentialFile(), "utf8");
    expect(onDisk).not.toContain(credentials.token);
    expect(JSON.parse(onDisk).token).toMatch(/^enc:/);
  });

  it("falls back to documented plaintext when the keychain is unavailable", async () => {
    const unavailable: TokenCipher = { ...fakeCipher, isAvailable: () => false };
    const store = createCloudCredentialStore({ dir, cipher: unavailable });
    await store.save(credentials);

    const onDisk = JSON.parse(await readFile(credentialFile(), "utf8"));
    expect(onDisk.token).toBe(`plain:${credentials.token}`);
    expect(await store.load()).toEqual(credentials);
  });

  it("round-trips with no cipher at all", async () => {
    const store = createCloudCredentialStore({ dir });
    await store.save(credentials);
    expect(await store.load()).toEqual(credentials);
  });

  it("loads null when the file is missing", async () => {
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    expect(await store.load()).toBeNull();
  });

  it("reads corrupt JSON as logged-out instead of throwing", async () => {
    await writeFile(credentialFile(), "{ this is not json");
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    expect(await store.load()).toBeNull();
  });

  it("reads an undecryptable token as logged-out", async () => {
    await writeFile(
      credentialFile(),
      JSON.stringify({
        ...credentials,
        version: 1,
        token: `enc:${Buffer.from("sealed-elsewhere").toString("base64")}`,
      }),
    );
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    expect(await store.load()).toBeNull();
  });

  it("reads an encrypted token as logged-out when no cipher is injected", async () => {
    await createCloudCredentialStore({ dir, cipher: fakeCipher }).save(credentials);
    const store = createCloudCredentialStore({ dir });
    expect(await store.load()).toBeNull();
  });

  it("reads empty-string fields as logged-out", async () => {
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    const valid = { ...credentials, version: 1, token: `plain:${credentials.token}` };
    for (const broken of [
      { ...valid, serverUrl: "" },
      { ...valid, email: "" },
      { ...valid, token: "" },
      { ...valid, token: "plain:" },
    ]) {
      await writeFile(credentialFile(), JSON.stringify(broken));
      expect(await store.load()).toBeNull();
    }
  });

  it("clears credentials and is idempotent", async () => {
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    await store.save(credentials);
    await store.clear();
    expect(await store.load()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
    await store.save(credentials);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "writes the credential file 0600 (owner-only) and heals lax perms on load",
    async () => {
      const { statSync, chmodSync } = await import("node:fs");
      const store = createCloudCredentialStore({ dir, cipher: fakeCipher });
      await store.save(credentials);
      expect(statSync(credentialFile()).mode & 0o777).toBe(0o600);

      // A pre-existing world-readable file is healed to 0600 on the next load.
      chmodSync(credentialFile(), 0o644);
      await store.load();
      expect(statSync(credentialFile()).mode & 0o777).toBe(0o600);
    },
  );
});
