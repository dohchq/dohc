import { describe, expect, it } from "vitest";
import { loadShareWebConfig } from "./config";

describe("share-web configuration", () => {
  it("parses exact public hosts and development defaults", () => {
    const config = loadShareWebConfig({
      NODE_ENV: "development",
      DOHC_SHARE_WEB_DEV: "1",
      DOHC_SHARE_WEB_RELAY_URL: "http://127.0.0.1:1788",
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
      DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
    });

    expect(config.trustedProxies).toEqual(new Set());
    expect(config.relayExchangeKey).toBeUndefined();
  });

  it("requires a relay exchange key in production", () => {
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "production",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
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
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test, other.example.test",
      }),
    ).toThrow(/exact comma-separated Host/u);
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
        DOHC_SHARE_WEB_TRUSTED_PROXIES: "127.0.0.1, 10.0.0.2",
      }),
    ).toThrow(/exact comma-separated peer addresses/u);
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "production",
        DOHC_SHARE_WEB_DEV: "1",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: "production-relay-exchange-key-at-least-32",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow(/requires NODE_ENV=development or test/u);
  });
});
