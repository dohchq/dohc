import { describe, expect, it } from "vitest";
import { MAX_RELAY_URL_LENGTH } from "@dohc/workspace-contracts/relay-values";
import { loadShareWebConfig } from "./config";

describe("share-web configuration", () => {
  it("requires and canonicalizes the public relay coordinate separately", () => {
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "http://sync-relay:1788",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow("DOHC_SHARE_WEB_PUBLIC_RELAY_URL must be set.");

    const config = loadShareWebConfig({
      NODE_ENV: "test",
      DOHC_SHARE_WEB_RELAY_URL: "http://sync-relay:1788",
      DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://Relay.Example.Test///",
      DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
    });

    expect(config.relayUrl).toBe("http://sync-relay:1788/");
    expect(config.publicRelayUrl).toBe("https://relay.example.test");
  });

  it.each([
    ["credentials", "https://user:pass@relay.example.test"],
    ["query", "https://relay.example.test?token=secret"],
    ["fragment", "https://relay.example.test#secret"],
    ["non-HTTP scheme", "file:///relay"],
    ["over 2048 characters", `https://relay.example.test/${"x".repeat(2048)}`],
  ])("rejects a public relay URL with %s", (_label, publicRelayUrl) => {
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "http://sync-relay:1788",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: publicRelayUrl,
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow(/DOHC_SHARE_WEB_PUBLIC_RELAY_URL/u);
  });

  it("rejects a public relay URL that serialization expands past the bound", () => {
    const publicRelayUrl = `https://relay.example.test/${"é".repeat(400)}`;

    expect(publicRelayUrl.length).toBeLessThanOrEqual(MAX_RELAY_URL_LENGTH);
    expect(new URL(publicRelayUrl).toString().length).toBeGreaterThan(
      MAX_RELAY_URL_LENGTH,
    );
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "http://sync-relay:1788",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: publicRelayUrl,
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow(/DOHC_SHARE_WEB_PUBLIC_RELAY_URL/u);
  });

  it("parses exact public hosts and development defaults", () => {
    const config = loadShareWebConfig({
      NODE_ENV: "development",
      DOHC_SHARE_WEB_DEV: "1",
      DOHC_SHARE_WEB_RELAY_URL: "http://127.0.0.1:1788",
      DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "http://127.0.0.1:1788",
      DOHC_SHARE_WEB_PUBLIC_HOSTS: "localhost:1790,Share.Example.Test",
      DOHC_SHARE_WEB_TRUSTED_PROXIES: "127.0.0.1,10.0.0.2",
      DOHC_SHARE_WEB_PORT: "0",
    });
    expect(config.publicHosts).toEqual(new Set(["localhost:1790", "share.example.test"]));
    expect(config.trustedProxies).toEqual(new Set(["127.0.0.1", "10.0.0.2"]));
    expect(config.bind).toBe("127.0.0.1");
    expect(config.port).toBe(0);
  });

  it("uses no trusted proxies when the list is unset", () => {
    const config = loadShareWebConfig({
      NODE_ENV: "test",
      DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
      DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
      DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
    });

    expect(config.trustedProxies).toEqual(new Set());
    expect(config.relayExchangeKey).toBeUndefined();
  });

  it("uses no trusted proxies for the self-host empty value", () => {
    const config = loadShareWebConfig({
      NODE_ENV: "test",
      DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
      DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
      DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      DOHC_SHARE_WEB_TRUSTED_PROXIES: "",
    });

    expect(config.trustedProxies).toEqual(new Set());
  });

  it.each([
    ["a leading empty segment", ",127.0.0.1"],
    ["a trailing empty segment", "127.0.0.1,"],
    ["an interior empty segment", "127.0.0.1,,10.0.0.2"],
    ["leading whitespace", " 127.0.0.1"],
    ["trailing whitespace", "127.0.0.1 "],
    ["whitespace after a comma", "127.0.0.1, 10.0.0.2"],
    ["only whitespace", " "],
  ])("rejects a trusted-proxy list with %s", (_case, trustedProxies) => {
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
        DOHC_SHARE_WEB_TRUSTED_PROXIES: trustedProxies,
      }),
    ).toThrow(/exact comma-separated peer addresses/u);
  });

  it("requires a relay exchange key in production", () => {
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "production",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow(
      "DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY must be set outside development/test.",
    );
  });

  it("requires a configured relay exchange key to be at least 32 characters", () => {
    const loadWithExchangeKey = (relayExchangeKey: string) =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: relayExchangeKey,
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      });

    expect(() => loadWithExchangeKey("x".repeat(31))).toThrow(
      "DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY must be at least 32 characters.",
    );
    expect(loadWithExchangeKey("x".repeat(32)).relayExchangeKey).toBe("x".repeat(32));
  });

  it("rejects inexact host lists and production development mode", () => {
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test, other.example.test",
      }),
    ).toThrow(/exact comma-separated Host/u);
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "production",
        DOHC_SHARE_WEB_DEV: "1",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: "production-relay-exchange-key-at-least-32",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow(/requires NODE_ENV=development or test/u);
  });
});
