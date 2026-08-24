import { describe, expect, it } from "vitest";
import { loadShareWebConfig } from "./config";

describe("share-web configuration", () => {
  it("parses exact public hosts and development defaults", () => {
    const config = loadShareWebConfig({
      NODE_ENV: "development",
      DOHC_SHARE_WEB_DEV: "1",
      DOHC_SHARE_WEB_RELAY_URL: "http://127.0.0.1:1788",
      DOHC_SHARE_WEB_PUBLIC_HOSTS: "localhost:1790,share.example.test",
      DOHC_SHARE_WEB_PORT: "0",
    });
    expect(config.publicHosts).toEqual(new Set(["localhost:1790", "share.example.test"]));
    expect(config.bind).toBe("127.0.0.1");
    expect(config.port).toBe(0);
  });

  it("rejects inexact host lists and production development mode", () => {
    expect(() =>
      loadShareWebConfig({
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test, other.example.test",
      }),
    ).toThrow(/exact comma-separated Host/u);
    expect(() =>
      loadShareWebConfig({
        NODE_ENV: "production",
        DOHC_SHARE_WEB_DEV: "1",
        DOHC_SHARE_WEB_RELAY_URL: "https://relay.example.test",
        DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.example.test",
      }),
    ).toThrow(/requires NODE_ENV=development or test/u);
  });
});
