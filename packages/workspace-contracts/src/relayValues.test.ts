import { describe, expect, it } from "vitest";
import {
  canonicalRelayUrl,
  MAX_RELAY_URL_LENGTH,
  relayUrlsMatch,
} from "./relayValues";

describe("relay URL identity", () => {
  it("canonicalizes HTTP(S) host casing and trailing slashes", () => {
    expect(canonicalRelayUrl("https://Relay.Example.Test///")).toBe(
      "https://relay.example.test",
    );
    expect(canonicalRelayUrl("http://Relay.Example.Test/path///")).toBe(
      "http://relay.example.test/path",
    );
  });

  it("rejects oversized, secret-bearing, and non-HTTP values", () => {
    for (const value of [
      "x".repeat(MAX_RELAY_URL_LENGTH + 1),
      "https://user:pass@relay.example.test",
      "https://relay.example.test?token=secret",
      "https://relay.example.test#secret",
      "file:///relay",
      "not-a-url",
    ]) {
      expect(canonicalRelayUrl(value)).toBeNull();
    }
  });

  it("rejects a bounded raw URL when serialization expands past the bound", () => {
    const value = `https://relay.example.test/${"é".repeat(400)}`;

    expect(value.length).toBeLessThanOrEqual(MAX_RELAY_URL_LENGTH);
    expect(new URL(value).toString().length).toBeGreaterThan(
      MAX_RELAY_URL_LENGTH,
    );
    expect(canonicalRelayUrl(value) === null).toBe(true);
  });

  it("accepts a canonical URL at the exact bound", () => {
    const prefix = "https://relay.example.test/";
    const value = `${prefix}${"x".repeat(MAX_RELAY_URL_LENGTH - prefix.length)}`;

    expect(value).toHaveLength(MAX_RELAY_URL_LENGTH);
    expect(canonicalRelayUrl(value)).toBe(value);
  });

  it("is fixed after one canonicalization", () => {
    const canonical = canonicalRelayUrl(
      "  HTTPS://Relay.Example.Test:443/path///  ",
    );

    expect(canonical).toBe("https://relay.example.test/path");
    expect(canonicalRelayUrl(canonical!)).toBe(canonical);
  });

  it("elides the default port and preserves a non-default port", () => {
    expect(canonicalRelayUrl("https://relay.example.test:443/path")).toBe(
      "https://relay.example.test/path",
    );
    expect(canonicalRelayUrl("https://relay.example.test:8443/path")).toBe(
      "https://relay.example.test:8443/path",
    );
  });

  it("matches canonical equivalents and refuses invalid identities", () => {
    expect(
      relayUrlsMatch(
        "https://Relay.Example.Test///",
        "https://relay.example.test",
      ),
    ).toBe(true);
    expect(
      relayUrlsMatch(
        "https://relay-a.example.test",
        "https://relay-b.example.test",
      ),
    ).toBe(false);
    expect(relayUrlsMatch("not-a-url", "not-a-url")).toBe(false);
    expect(
      relayUrlsMatch("not-a-url", "https://relay.example.test"),
    ).toBe(false);
    expect(
      relayUrlsMatch("https://relay.example.test", "not-a-url"),
    ).toBe(false);
  });
});
