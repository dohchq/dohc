import { describe, expect, it } from "vitest";
import { buildSyncCode, parseSyncCode, relayUrlsMatch } from "./syncCode";

describe("syncCode", () => {
  it("round-trips a workspace id and relay URL", () => {
    const code = buildSyncCode({
      workspaceId: "workspace-a1",
      relayUrl: "http://localhost:1788",
    });
    expect(code).toBe("dohc-sync:workspace-a1:http://localhost:1788");
    expect(parseSyncCode(code)).toEqual({
      workspaceId: "workspace-a1",
      relayUrl: "http://localhost:1788",
    });
  });

  it("parses despite surrounding whitespace and trailing slashes (copy/paste reality)", () => {
    expect(parseSyncCode("  dohc-sync:ws-2:https://sync.example.com/  \n")).toEqual({
      workspaceId: "ws-2",
      relayUrl: "https://sync.example.com",
    });
  });

  it("keeps the relay URL intact past its own colons", () => {
    const parsed = parseSyncCode("dohc-sync:ws:https://sync.example.com:8443");
    expect(parsed).toEqual({ workspaceId: "ws", relayUrl: "https://sync.example.com:8443" });
  });

  it("rejects malformed codes instead of guessing", () => {
    expect(parseSyncCode("")).toBeNull();
    expect(parseSyncCode("not a code")).toBeNull();
    expect(parseSyncCode("dohc-sync:only-an-id")).toBeNull();
    expect(parseSyncCode("dohc-sync::http://relay.test")).toBeNull();
    expect(parseSyncCode("dohc-sync:has space:http://relay.test")).toBeNull();
    expect(parseSyncCode("dohc-sync:ws:ftp://relay.test")).toBeNull();
    expect(parseSyncCode("dohc-sync:ws:not-a-url")).toBeNull();
  });

  // Security gate (0P-C gate fix): a pasted code is untrusted input and the
  // built code is copyable/screenshot-readable. Credentials, query strings,
  // and fragments must never ride a relay URL — in, out, or in comparison.
  it("rejects relay URLs carrying credentials, query strings, or fragments", () => {
    expect(parseSyncCode("dohc-sync:ws:https://user:pass@relay.test")).toBeNull();
    expect(parseSyncCode("dohc-sync:ws:https://user@relay.test")).toBeNull();
    expect(parseSyncCode("dohc-sync:ws:https://relay.test?token=secret")).toBeNull();
    expect(parseSyncCode("dohc-sync:ws:https://relay.test#fragment")).toBeNull();

    expect(() =>
      buildSyncCode({ workspaceId: "ws", relayUrl: "https://user:pass@relay.test" }),
    ).toThrow();
    expect(() =>
      buildSyncCode({ workspaceId: "ws", relayUrl: "https://relay.test?token=secret" }),
    ).toThrow();
    expect(() =>
      buildSyncCode({ workspaceId: "ws", relayUrl: "https://relay.test#fragment" }),
    ).toThrow();

    // The authz comparison refuses secret-bearing or non-relay components on
    // EITHER side — never "matches" through them.
    expect(relayUrlsMatch("https://user:pass@relay.test", "https://relay.test")).toBe(false);
    expect(relayUrlsMatch("https://relay.test", "https://relay.test?token=x")).toBe(false);
    expect(relayUrlsMatch("https://relay.test#f", "https://relay.test#f")).toBe(false);
  });

  it("refuses to build a code from values it could not parse back", () => {
    expect(() => buildSyncCode({ workspaceId: "has:colon", relayUrl: "http://x.test" })).toThrow();
    expect(() => buildSyncCode({ workspaceId: "ws", relayUrl: "file:///etc" })).toThrow();
  });

  it("compares relay URLs trailing-slash-insensitively", () => {
    expect(relayUrlsMatch("http://relay.test/", "http://relay.test")).toBe(true);
    expect(relayUrlsMatch("http://relay.test", "http://other.test")).toBe(false);
  });

  it("compares canonical relay identities (case-insensitive host)", () => {
    expect(relayUrlsMatch("http://Relay.Test", "http://relay.test")).toBe(true);
    expect(relayUrlsMatch("not-a-url", "not-a-url")).toBe(false);
  });
});
