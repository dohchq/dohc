import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenCipher } from "./cloudCredentialStore";
import {
  createLocalWorkspaceSecretStore,
  WorkspaceSecretConflictError,
  WorkspaceSecretLimitError,
  WorkspaceSecretNotFoundError,
  WorkspaceSecretStorageUnavailableError,
  WorkspaceSecretVaultCorruptError,
} from "./localWorkspaceSecretStore";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-workspace-secrets-"));
  dirs.push(dir);
  return dir;
}

function fakeCipher(available = true): TokenCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`sealed:${plain}`, "utf8").toString("base64"),
    decrypt: (cipher) => {
      const decoded = Buffer.from(cipher, "base64").toString("utf8");
      if (!decoded.startsWith("sealed:")) throw new Error("corrupt");
      return decoded.slice("sealed:".length);
    },
  };
}

describe("localWorkspaceSecretStore", () => {
  it("seals values outside workspace, enforces create/replace, never returns plaintext, and removes", async () => {
    const dir = await tempDir();
    let clock = 1000;
    const store = createLocalWorkspaceSecretStore({
      dir,
      cipher: fakeCipher(true),
      nowMs: () => clock,
    });

    expect(await store.list("ws-1")).toEqual([]);
    await expect(
      store.set("ws-1", {
        name: "RESEND_API_KEY",
        mode: "replace",
        usage: "http-header",
        value: "re_secret_abc123",
        allowedHosts: ["api.resend.com"],
      }),
    ).rejects.toBeInstanceOf(WorkspaceSecretNotFoundError);

    const afterSet = await store.set("ws-1", {
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_secret_abc123",
      allowedHosts: ["API.Resend.com"],
    });
    expect(afterSet).toEqual([
      {
        name: "RESEND_API_KEY",
        usage: "http-header",
        allowedHosts: ["api.resend.com"],
        generation: 1,
        createdAtMs: 1000,
        updatedAtMs: 1000,
      },
    ]);

    await expect(
      store.set("ws-1", {
        name: "RESEND_API_KEY",
        mode: "create",
        usage: "http-header",
        value: "re_secret_overwrite",
        allowedHosts: ["evil.example.com"],
      }),
    ).rejects.toBeInstanceOf(WorkspaceSecretConflictError);

    const files = await readdir(join(dir, "workspace-secrets"));
    expect(files).toHaveLength(1);
    const onDisk = await readFile(join(dir, "workspace-secrets", files[0]!), "utf8");
    expect(onDisk).not.toContain("re_secret_abc123");

    const resolved = await store.readSecretForExecution("ws-1", "RESEND_API_KEY");
    expect(resolved?.value).toBe("re_secret_abc123");

    clock = 2000;
    const afterRotate = await store.set("ws-1", {
      name: "RESEND_API_KEY",
      mode: "replace",
      usage: "http-url",
      value: "https://hooks.slack.com/services/T0/B0/XX",
    });
    expect(afterRotate[0]).toMatchObject({
      name: "RESEND_API_KEY",
      usage: "http-url",
      allowedHosts: [],
      generation: 2,
      createdAtMs: 1000,
      updatedAtMs: 2000,
    });

    expect(await store.remove("ws-1", "RESEND_API_KEY")).toEqual([]);
    expect(await readdir(join(dir, "workspace-secrets"))).toEqual([]);
  });

  it("refuses reads and writes without overwriting an unreadable or schema-invalid vault", async () => {
    const dir = await tempDir();
    const store = createLocalWorkspaceSecretStore({
      dir,
      cipher: fakeCipher(true),
    });

    await store.set("ws-1", {
      name: "ORIGINAL_SECRET",
      mode: "create",
      usage: "http-url",
      value: "https://hooks.slack.com/services/T0/B0/KEEP",
    });
    const [vaultFile] = await readdir(join(dir, "workspace-secrets"));
    const vaultPath = join(dir, "workspace-secrets", vaultFile!);
    const invalidContent = `${JSON.stringify({ version: 99, workspaceId: "ws-1", entries: { ORIGINAL_SECRET: { ciphertext: "keep-me" } } })}\n`;
    await writeFile(vaultPath, invalidContent, "utf8");

    await expect(store.list("ws-1")).rejects.toBeInstanceOf(WorkspaceSecretVaultCorruptError);
    await expect(
      store.set("ws-1", {
        name: "NEW_SECRET",
        mode: "create",
        usage: "http-url",
        value: "https://hooks.slack.com/services/T0/B0/NEW",
      }),
    ).rejects.toBeInstanceOf(WorkspaceSecretVaultCorruptError);
    await expect(store.remove("ws-1", "ORIGINAL_SECRET")).rejects.toBeInstanceOf(
      WorkspaceSecretVaultCorruptError,
    );
    expect(await store.readSecretForExecution("ws-1", "ORIGINAL_SECRET")).toBeNull();
    expect(await readFile(vaultPath, "utf8")).toBe(invalidContent);

    const invalidKeyVault = `${JSON.stringify({
      version: 1,
      workspaceId: "ws-1",
      entries: {
        "bad-name": {
          usage: "http-url",
          allowedHosts: [],
          sealedValue: "abc",
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      },
    })}\n`;
    await writeFile(vaultPath, invalidKeyVault, "utf8");
    await expect(store.list("ws-1")).rejects.toBeInstanceOf(WorkspaceSecretVaultCorruptError);
    expect(await readFile(vaultPath, "utf8")).toBe(invalidKeyVault);

    const emptyHostsHeaderVault = `${JSON.stringify({
      version: 1,
      workspaceId: "ws-1",
      entries: {
        HEADER_SECRET: {
          usage: "http-header",
          allowedHosts: [],
          sealedValue: "abc",
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      },
    })}\n`;
    await writeFile(vaultPath, emptyHostsHeaderVault, "utf8");
    await expect(store.list("ws-1")).rejects.toBeInstanceOf(WorkspaceSecretVaultCorruptError);
    expect(await readFile(vaultPath, "utf8")).toBe(emptyHostsHeaderVault);

    const protoKeyVault =
      '{"version":1,"workspaceId":"ws-1","entries":{"__proto__":{"usage":"http-url","allowedHosts":[],"sealedValue":"abc","generation":1,"createdAtMs":1,"updatedAtMs":1}}}\n';
    await writeFile(vaultPath, protoKeyVault, "utf8");
    await expect(store.list("ws-1")).rejects.toBeInstanceOf(WorkspaceSecretVaultCorruptError);
    await expect(
      store.set("ws-1", {
        name: "AFTER_PROTO",
        mode: "create",
        usage: "http-url",
        value: "https://hooks.slack.com/services/T0/B0/NEW",
      }),
    ).rejects.toBeInstanceOf(WorkspaceSecretVaultCorruptError);
    expect(await readFile(vaultPath, "utf8")).toBe(protoKeyVault);
  });

  it("fails closed when system keychain is unavailable", async () => {
    const dir = await tempDir();
    const store = createLocalWorkspaceSecretStore({
      dir,
      cipher: fakeCipher(false),
    });

    expect(store.canKeep()).toBe(false);
    await expect(store.list("ws-1")).rejects.toBeInstanceOf(WorkspaceSecretStorageUnavailableError);
    await expect(
      store.set("ws-1", {
        name: "HOOK_URL",
        mode: "create",
        usage: "http-url",
        value: "https://hooks.slack.com/services/A/B/C",
      }),
    ).rejects.toBeInstanceOf(WorkspaceSecretStorageUnavailableError);
    expect(await store.readSecretForExecution("ws-1", "HOOK_URL")).toBeNull();
  });

  it("enforces the 50-secret limit", async () => {
    const dir = await tempDir();
    const store = createLocalWorkspaceSecretStore({
      dir,
      cipher: fakeCipher(true),
    });
    for (let i = 0; i < 50; i++) {
      await store.set("ws-cap", {
        name: `SECRET_${i}`,
        mode: "create",
        usage: "http-url",
        value: `https://hooks.slack.com/services/A/B/${i}`,
      });
    }
    await expect(
      store.set("ws-cap", {
        name: "SECRET_50",
        mode: "create",
        usage: "http-url",
        value: "https://hooks.slack.com/services/A/B/50",
      }),
    ).rejects.toBeInstanceOf(WorkspaceSecretLimitError);
  });
});
