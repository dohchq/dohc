import { describe, expect, it } from "vitest";
import { normalizeEmail, presentsSignUpInviteKey, signUpInviteKey } from "./signUp";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

describe("sign-up invite key", () => {
  it("derives one key per secret, never the secret itself", () => {
    const key = signUpInviteKey(SECRET);
    expect(signUpInviteKey(SECRET)).toBe(key);
    expect(key).not.toContain(SECRET);
    expect(signUpInviteKey(`${SECRET}x`)).not.toBe(key);
  });

  it("accepts only the exact key", () => {
    const key = signUpInviteKey(SECRET);
    expect(presentsSignUpInviteKey(key, key)).toBe(true);
    for (const presented of [null, "", `${key}x`, key.slice(1), signUpInviteKey(`${SECRET}x`)]) {
      expect(presentsSignUpInviteKey(presented, key)).toBe(false);
    }
  });
});

describe("normalizeEmail", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(normalizeEmail("  Ada@Example.COM\n")).toBe("ada@example.com");
  });
});
