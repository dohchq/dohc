import { describe, expect, it } from "vitest";
import { MIN_SECRET_PASSPHRASE_LENGTH, validateSecretPassphrase } from "./secretPassphrase";

describe("validateSecretPassphrase", () => {
  it("refuses an empty passphrase and one shorter than 12 characters", () => {
    expect(MIN_SECRET_PASSPHRASE_LENGTH).toBe(12);
    expect(validateSecretPassphrase("")).toBe("Passphrase required to protect synced secrets.");
    expect(validateSecretPassphrase("a".repeat(11))).toBe(
      "Passphrase must be at least 12 characters.",
    );
  });

  it("accepts a passphrase of 12 characters or more", () => {
    expect(validateSecretPassphrase("a".repeat(12))).toBeNull();
    expect(validateSecretPassphrase("correct horse battery staple")).toBeNull();
  });
});
