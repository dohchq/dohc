import { describe, expect, it } from "vitest";
import {
  canonicalCloudOrigin,
  resolveManagedCloudConfiguration,
} from "./cloudConfiguration";

describe("managed cloud configuration", () => {
  it("requires an explicit server and relay pair", () => {
    expect(resolveManagedCloudConfiguration({})).toEqual({
      status: "unconfigured",
    });
    expect(
      resolveManagedCloudConfiguration({ DOHC_CLOUD_URL: "https://cloud.example.test" }),
    ).toEqual({ status: "invalid" });
    expect(
      resolveManagedCloudConfiguration({
        DOHC_CLOUD_RELAY_URL: "https://relay.example.test",
      }),
    ).toEqual({ status: "invalid" });
  });

  it("canonicalizes a valid managed pair", () => {
    expect(
      resolveManagedCloudConfiguration({
        DOHC_CLOUD_URL: " HTTPS://Cloud.Example.Test:443/ ",
        DOHC_CLOUD_RELAY_URL: "https://Relay.Example.Test/",
      }),
    ).toEqual({
      status: "ready",
      serverUrl: "https://cloud.example.test",
      relayUrl: "https://relay.example.test",
    });
  });

  it("rejects malformed or secret-bearing managed endpoints", () => {
    for (const serverUrl of [
      "cloud.example.test",
      "https://",
      "file:///cloud",
      "https://user:pass@cloud.example.test",
      "https://cloud.example.test/api",
      "https://cloud.example.test?token=secret",
    ]) {
      expect(
        resolveManagedCloudConfiguration({
          DOHC_CLOUD_URL: serverUrl,
          DOHC_CLOUD_RELAY_URL: "https://relay.example.test",
        }),
      ).toEqual({ status: "invalid" });
    }
  });
});

describe("cloud origin", () => {
  it("keeps explicit loopback origins but never supplies one", () => {
    expect(canonicalCloudOrigin("http://localhost:1786/")).toBe(
      "http://localhost:1786",
    );
    expect(resolveManagedCloudConfiguration({})).toEqual({
      status: "unconfigured",
    });
  });
});
