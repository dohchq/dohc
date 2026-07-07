import { describe, expect, it } from "vitest";
import {
  MIN_SECRET_PASSPHRASE_LENGTH,
  validateSecretPassphrase,
} from "./secretPassphrase";

describe("validateSecretPassphrase", () => {
  it("rejects an empty passphrase with the required message", () => {
    expect(validateSecretPassphrase("")).toBe(
      "Passphrase required to protect synced secrets.",
    );
  });

  it("rejects a passphrase shorter than the floor", () => {
    const tooShort = "a".repeat(MIN_SECRET_PASSPHRASE_LENGTH - 1);
    expect(validateSecretPassphrase(tooShort)).toBe(
      `Passphrase must be at least ${MIN_SECRET_PASSPHRASE_LENGTH} characters.`,
    );
  });

  it("accepts a passphrase at exactly the floor", () => {
    expect(
      validateSecretPassphrase("a".repeat(MIN_SECRET_PASSPHRASE_LENGTH)),
    ).toBeNull();
  });

  it("accepts a normal passphrase", () => {
    expect(validateSecretPassphrase("correct horse battery staple")).toBeNull();
  });
});
