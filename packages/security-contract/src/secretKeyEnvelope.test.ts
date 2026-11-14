import { expect, it } from "vitest";
import { SecretKeyEnvelopeError } from "./secretKeyEnvelope";

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
