import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SECRET_KEY_RELATIVE_PATH,
  createSecretFileStore,
  installWorkspaceDataKey,
  readWorkspaceDataKeyForEnrollment,
} from "./secretFileStore";
import {
  SECRET_KEY_ENVELOPE_FORMAT,
  SECRET_KEY_ENVELOPE_SCRYPT_N,
  SECRET_KEY_ENVELOPE_SCRYPT_P,
  SECRET_KEY_ENVELOPE_SCRYPT_R,
  unwrapWorkspaceDataKey,
  wrapWorkspaceDataKey,
} from "./secretKeyEnvelope";
import { createVersionedTextStore } from "./versionedTextStore";

const WORKSPACE_ID = "workspace-envelope";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-${label}-`));
  roots.push(root);
  return root;
}

async function createProtectedWorkspace(root: string): Promise<Buffer> {
  const versions = createVersionedTextStore(root);
  const secrets = createSecretFileStore(root);
  try {
    await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await secrets.writeSecretFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: ".env",
      text: "TOKEN=envelope-secret\n",
      metadata: { origin: "local-file" },
    });
  } finally {
    await secrets.close();
    await versions.close();
  }
  const key = await readWorkspaceDataKeyForEnrollment(root, WORKSPACE_ID);
  if (!key) throw new Error("expected enrollment key");
  return key;
}

describe("secret key envelope", () => {
  it("wraps and unwraps a workspace data key with workspace-bound AAD", async () => {
    const key = randomBytes(32);
    const { envelopeJson } = await wrapWorkspaceDataKey({
      dataKey: key,
      passphrase: "correct horse battery staple",
      workspaceId: WORKSPACE_ID,
    });
    const parsed = JSON.parse(envelopeJson) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      format: SECRET_KEY_ENVELOPE_FORMAT,
      scryptN: SECRET_KEY_ENVELOPE_SCRYPT_N,
      scryptR: SECRET_KEY_ENVELOPE_SCRYPT_R,
      scryptP: SECRET_KEY_ENVELOPE_SCRYPT_P,
    });
    await expect(
      unwrapWorkspaceDataKey({
        envelopeJson,
        passphrase: "correct horse battery staple",
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual(key);
    await expect(
      unwrapWorkspaceDataKey({
        envelopeJson,
        passphrase: "correct horse battery staple",
        workspaceId: `${WORKSPACE_ID}-other`,
      }),
    ).rejects.toMatchObject({ code: "unwrap-failed" });
  });

  it("wrong passphrase fails closed and writes no local key file", async () => {
    const source = await tempRoot("envelope-source");
    const target = await tempRoot("envelope-target");
    const key = await createProtectedWorkspace(source);
    const { envelopeJson } = await wrapWorkspaceDataKey({
      dataKey: key,
      passphrase: "right passphrase",
      workspaceId: WORKSPACE_ID,
    });
    await expect(
      unwrapWorkspaceDataKey({
        envelopeJson,
        passphrase: "wrong passphrase",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({ code: "unwrap-failed" });
    await expect(access(join(target, SECRET_KEY_RELATIVE_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const reopened = createSecretFileStore(source);
    try {
      await expect(
        reopened.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).resolves.toEqual({ present: true, text: "TOKEN=envelope-secret\n" });
    } finally {
      await reopened.close();
    }
  });

  it("rejects tampered ciphertext, auth tag, and salt with one generic error", async () => {
    const key = randomBytes(32);
    const { envelopeJson } = await wrapWorkspaceDataKey({
      dataKey: key,
      passphrase: "tamper passphrase",
      workspaceId: WORKSPACE_ID,
    });
    for (const field of ["ciphertextBase64", "authTagBase64", "saltBase64"] as const) {
      const parsed = JSON.parse(envelopeJson) as Record<string, string>;
      const bytes = Buffer.from(parsed[field], "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      parsed[field] = bytes.toString("base64");
      await expect(
        unwrapWorkspaceDataKey({
          envelopeJson: JSON.stringify(parsed),
          passphrase: "tamper passphrase",
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toMatchObject({ code: "unwrap-failed" });
    }
  });

  it("manual key-file fallback still round-trips without an envelope", async () => {
    const source = await tempRoot("manual-source");
    const target = await tempRoot("manual-target");
    const keyFileText = await readFile(
      join(source, SECRET_KEY_RELATIVE_PATH),
      "utf8",
    ).catch(async () => {
      await createProtectedWorkspace(source);
      return readFile(join(source, SECRET_KEY_RELATIVE_PATH), "utf8");
    });
    const key = Buffer.from(keyFileText.trim().slice("dohc-secret-key-v1:".length), "base64");
    await installWorkspaceDataKey(target, key);
    await expect(readFile(join(target, SECRET_KEY_RELATIVE_PATH), "utf8")).resolves.toBe(
      keyFileText,
    );
  });
});
