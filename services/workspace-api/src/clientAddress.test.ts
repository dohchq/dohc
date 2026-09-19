import { describe, expect, it } from "vitest";
import { authClientAddress, sanitizeAuthHeaders, trustedAuthProxies } from "./clientAddress";

describe("auth client address", () => {
  const trusted = trustedAuthProxies("172.30.42.2,127.0.0.1");
  it("uses the socket peer when the caller is not a trusted proxy", () => {
    expect(authClientAddress("192.0.2.7", "203.0.113.2", trusted)).toBe("192.0.2.7");
  });
  it("walks verified forwarding chains from the nearest hop", () => {
    expect(authClientAddress("::ffff:172.30.42.2", "198.51.100.8, 203.0.113.4, 127.0.0.1", trusted)).toBe("203.0.113.4");
  });
  it.each(["unparseable", "203.0.113.4, garbage", ["203.0.113.4"], "1".repeat(4097)])("refuses invalid proxy data %j", forwarded => {
    expect(authClientAddress("172.30.42.2", forwarded, trusted)).toBe("172.30.42.2");
  });
  it("overwrites a forged server-owned header", () => {
    const headers = {"x-dohc-auth-client-ip": "203.0.113.8", "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.10"};
    sanitizeAuthHeaders(headers, "192.0.2.7", trusted);
    expect(headers).toEqual({"x-dohc-auth-client-ip": "192.0.2.7"});
  });
  it.each(["10.0.0.0/8", "*", "localhost", "fe80::1%lo0"])("rejects broad or ambiguous trust %s", value => {
    expect(() => trustedAuthProxies(value)).toThrow("exact proxy IP addresses");
  });
});
