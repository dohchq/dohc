import { describe, expect, it } from "vitest";
import { likelySecretPrefix, SECRET_PREFIXES } from "./secretPrefix";

const body = "A1b2C3d4E5f6G7h8I9j0_-xyz";

describe("likelySecretPrefix", () => {
  it.each(SECRET_PREFIXES)("finds %s and returns only the prefix", (prefix) => {
    const found = likelySecretPrefix(`token = ${prefix}${body}\n`);
    expect(found).toBe(prefix);
    expect(found).not.toContain(body);
  });

  it("misses a body shorter than 20 characters", () => {
    expect(likelySecretPrefix(`ghp_${"a".repeat(19)}`)).toBeNull();
    expect(likelySecretPrefix(`ghp_${"a".repeat(20)}`)).toBe("ghp_");
  });

  it("misses a prefix inside a longer word", () => {
    expect(likelySecretPrefix(`xghp_${body}`)).toBeNull();
    expect(likelySecretPrefix(`my_sk_live_${body}`)).toBeNull();
    expect(likelySecretPrefix(`axoxb-${body}`)).toBeNull();
  });

  it("finds a token after punctuation", () => {
    expect(likelySecretPrefix(`KEY="xoxp-${body}"`)).toBe("xoxp-");
  });

  it("misses ordinary text", () => {
    expect(likelySecretPrefix("Set GITHUB_TOKEN in .env, not here.")).toBeNull();
  });
});
