import { expect, it } from "vitest";
import {
  SecretKeyEnvelopeError,
  envelopeKeyCheck,
  unwrapWorkspaceDataKey,
  workspaceDataKeyCheck,
  wrapWorkspaceDataKey,
} from "./secretKeyEnvelope";

it.each([
  ["parse", new SyntaxError("private envelope JSON")],
  [
    "authentication",
    Object.assign(new Error("private authentication failure"), { code: "ERR_OSSL_BAD_DECRYPT" }),
  ],
  [
    "key derivation",
    Object.assign(new Error("private key derivation failure"), {
      code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS",
    }),
  ],
] as const)("hides the %s cause in every serialized envelope error", (_kind, cause) => {
  const error = new SecretKeyEnvelopeError(cause);
  const publicFields = { name: "SecretKeyEnvelopeError", code: "unwrap-failed" };
  expect(JSON.parse(JSON.stringify(error))).toEqual(publicFields);
  expect({ ...error }).toEqual(publicFields);

  const cloned = structuredClone(error);
  expect(cloned).toBeInstanceOf(Error);
  expect(cloned.message).toBe("Workspace secret key envelope could not be unwrapped.");
  expect(Object.getOwnPropertyNames(cloned).sort()).toEqual(["message", "stack"]);
  expect({ ...cloned }).toEqual({});
  expect(JSON.stringify(cloned)).toBe("{}");
  expect(cloned.stack).not.toContain(cause.message);
});

it("gives a damaged envelope and a wrong passphrase the same public error", async () => {
  const workspaceId = "workspace-1";
  const { envelopeJson } = await wrapWorkspaceDataKey({
    dataKey: new Uint8Array(32).fill(7),
    passphrase: "right",
    workspaceId,
  });
  const failure = (input: { envelopeJson: string; passphrase: string }) =>
    unwrapWorkspaceDataKey({ ...input, workspaceId }).then(
      () => {
        throw new Error("the unwrap succeeded");
      },
      (error: unknown) => error,
    );

  for (const error of [
    await failure({ envelopeJson: "{", passphrase: "right" }),
    await failure({ envelopeJson, passphrase: "wrong" }),
  ]) {
    expect(error).toBeInstanceOf(SecretKeyEnvelopeError);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "SecretKeyEnvelopeError",
      code: "unwrap-failed",
    });
    expect(Object.getOwnPropertyNames(structuredClone(error)).sort()).toEqual(["message", "stack"]);
  }
});

it("names the wrapped key so a replacement can tell it wraps the same one", async () => {
  const workspaceId = "workspace-1";
  const dataKey = new Uint8Array(32).fill(7);
  const first = await wrapWorkspaceDataKey({ dataKey, passphrase: "first", workspaceId });
  const second = await wrapWorkspaceDataKey({ dataKey, passphrase: "second", workspaceId });
  const other = await wrapWorkspaceDataKey({
    dataKey: new Uint8Array(32).fill(8),
    passphrase: "first",
    workspaceId,
  });

  expect(envelopeKeyCheck(first.envelopeJson)).toBe(workspaceDataKeyCheck(dataKey, workspaceId));
  expect(envelopeKeyCheck(second.envelopeJson)).toBe(envelopeKeyCheck(first.envelopeJson));
  expect(envelopeKeyCheck(other.envelopeJson)).not.toBe(envelopeKeyCheck(first.envelopeJson));
  expect(workspaceDataKeyCheck(dataKey, "workspace-2")).not.toBe(
    workspaceDataKeyCheck(dataKey, workspaceId),
  );
});

it("reads no key check from a legacy or unreadable envelope", async () => {
  const { envelopeJson } = await wrapWorkspaceDataKey({
    dataKey: new Uint8Array(32).fill(7),
    passphrase: "right",
    workspaceId: "workspace-1",
  });
  const { keyCheckBase64: _dropped, ...legacy } = JSON.parse(envelopeJson);
  expect(envelopeKeyCheck(JSON.stringify(legacy))).toBeNull();
  expect(envelopeKeyCheck("{")).toBeNull();
  await expect(
    unwrapWorkspaceDataKey({
      envelopeJson: JSON.stringify(legacy),
      passphrase: "right",
      workspaceId: "workspace-1",
    }),
  ).resolves.toEqual(Buffer.alloc(32, 7));
});

it("refuses an envelope whose key check names a different key", async () => {
  const workspaceId = "workspace-1";
  const { envelopeJson } = await wrapWorkspaceDataKey({
    dataKey: new Uint8Array(32).fill(7),
    passphrase: "right",
    workspaceId,
  });
  const swapped = JSON.stringify({
    ...JSON.parse(envelopeJson),
    keyCheckBase64: workspaceDataKeyCheck(new Uint8Array(32).fill(8), workspaceId),
  });
  await expect(
    unwrapWorkspaceDataKey({ envelopeJson: swapped, passphrase: "right", workspaceId }),
  ).rejects.toBeInstanceOf(SecretKeyEnvelopeError);
});
