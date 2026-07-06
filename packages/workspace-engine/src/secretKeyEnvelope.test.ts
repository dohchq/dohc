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

  // Honest scope note (gate fix): unwrapWorkspaceDataKey has no filesystem
  // side effects at all, so there is no "target root" to assert about here.
  // What this test locks is that a failed unwrap yields no key material and
  // leaves the SOURCE workspace fully usable. The enrollment-side property
  // ("a failed unwrap can never install a key") lives at
  // installWorkspaceDataKey and is locked by the dedicated test below.
  it("wrong passphrase fails closed and the source workspace stays usable", async () => {
    const source = await tempRoot("envelope-source");
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

  // The enrollment boundary itself: even if a broken caller shoved
  // failed-unwrap garbage at installWorkspaceDataKey, it validates BEFORE
  // touching the filesystem (the ENOENT check below is meaningful — this
  // function targets that root) and never overwrites an existing different
  // key.
  it("installWorkspaceDataKey rejects non-key material before writing and never overwrites a different key", async () => {
    const target = await tempRoot("install-target");
    for (const junk of [Buffer.alloc(0), randomBytes(16), randomBytes(64)]) {
      await expect(installWorkspaceDataKey(target, junk)).rejects.toMatchObject({
        code: "key-corrupt",
      });
    }
    await expect(access(join(target, SECRET_KEY_RELATIVE_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    await installWorkspaceDataKey(target, keyA);
    const installed = await readFile(join(target, SECRET_KEY_RELATIVE_PATH), "utf8");
    // Same key re-installs idempotently; a DIFFERENT key is refused and the
    // original stays in place.
    await installWorkspaceDataKey(target, keyA);
    await expect(installWorkspaceDataKey(target, keyB)).rejects.toMatchObject({
      code: "key-corrupt",
    });
    await expect(readFile(join(target, SECRET_KEY_RELATIVE_PATH), "utf8")).resolves.toBe(
      installed,
    );
  });

  // Gate fix (0P-D): raw causes (SyntaxError text, OpenSSL codes, scrypt
  // errors) must stay debug-internal — every public failure mode has one
  // indistinguishable shape across serialization boundaries.
  it("public error shape is uniform across malformed-JSON, base64, GCM, and KDF failures", async () => {
    const key = randomBytes(32);
    const { envelopeJson } = await wrapWorkspaceDataKey({
      dataKey: key,
      passphrase: "uniform passphrase",
      workspaceId: WORKSPACE_ID,
    });
    const withBadBase64 = { ...(JSON.parse(envelopeJson) as Record<string, unknown>) };
    withBadBase64.saltBase64 = "!!not-base64!!";
    const withBadTag = { ...(JSON.parse(envelopeJson) as Record<string, string>) };
    const tagBytes = Buffer.from(withBadTag.authTagBase64!, "base64");
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff;
    withBadTag.authTagBase64 = tagBytes.toString("base64");

    const attempts = [
      // malformed JSON
      { envelopeJson: "{ not json", passphrase: "uniform passphrase" },
      // malformed base64 field
      { envelopeJson: JSON.stringify(withBadBase64), passphrase: "uniform passphrase" },
      // GCM auth failure
      { envelopeJson: JSON.stringify(withBadTag), passphrase: "uniform passphrase" },
      // KDF input failure
      { envelopeJson, passphrase: "" },
    ];
    const shapes: Array<Record<string, unknown>> = [];
    for (const attempt of attempts) {
      const error = await unwrapWorkspaceDataKey({
        ...attempt,
        workspaceId: WORKSPACE_ID,
      }).then(
        () => {
          throw new Error("expected the unwrap to fail");
        },
        (thrown: unknown) => thrown as Error & { code?: string },
      );
      shapes.push({
        name: error.name,
        message: error.message,
        code: error.code,
        enumerableKeys: Object.keys(error),
        hasStandardCause: "cause" in error,
        json: JSON.stringify(error),
      });
    }
    for (const shape of shapes) {
      expect(shape).toEqual({
        name: "SecretKeyEnvelopeError",
        message: "Workspace secret key envelope could not be unwrapped.",
        code: "unwrap-failed",
        enumerableKeys: ["code", "name"],
        hasStandardCause: false,
        json: '{"code":"unwrap-failed","name":"SecretKeyEnvelopeError"}',
      });
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
