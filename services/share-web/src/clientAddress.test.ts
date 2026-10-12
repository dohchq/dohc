import {describe, expect, it} from "vitest";
import {clientAddress} from "./clientAddress";
import {loadShareWebConfig} from "./config";

function trusted(value = "127.0.0.1"): ReadonlySet<string> {
  return loadShareWebConfig({
    NODE_ENV: "test", DOHC_SHARE_WEB_RELAY_URL: "http://relay.test",
    DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "https://relay.test", DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.test",
    DOHC_SHARE_WEB_TRUSTED_PROXIES: value,
  }).trustedProxies;
}

describe("share-web client addresses", () => {
  it("keeps distinct forwarded clients behind an IPv4-mapped trusted socket", () => {
    const proxies = trusted();
    expect(["198.51.100.1", "198.51.100.2"].map(client => clientAddress("::ffff:127.0.0.1", client, proxies)))
      .toEqual(["198.51.100.1", "198.51.100.2"]);
  });

  it.each(["::ffff:127.0.0.1", "::FFFF:7F00:1", "0:0:0:0:0:ffff:7f00:1"])("matches configured mapped proxy %s to a dotted socket", configured => {
    expect(clientAddress("127.0.0.1", "198.51.100.1", trusted(configured))).toBe("198.51.100.1");
  });

  it("matches canonical IPv6 forms throughout the trusted suffix", () => {
    const proxies = trusted("2001:0DB8:0:0:0:0:0:1,2001:db8::2");
    expect(clientAddress("2001:db8::1", "2001:0DB8:0:0:0:0:0:3, 2001:0db8::2", proxies)).toBe("2001:db8::3");
  });

  it("normalizes mapped forwarding hops before comparing their trust", () => {
    expect(clientAddress("127.0.0.1", "::ffff:198.51.100.1, ::FFFF:0A00:2", trusted("127.0.0.1,10.0.0.2")))
      .toBe("198.51.100.1");
  });

  it.each(["198.51.100.1", "::ffff:198.51.100.1", "2001:0DB8:0:0:0:0:0:3"])("ignores spoofed forwarding from untrusted peer %s", peer => {
    expect(clientAddress(peer, "127.0.0.1, 203.0.113.8", trusted()))
      .toBe(peer.includes("198.51.100.1") ? "198.51.100.1" : "2001:db8::3");
  });

  it("does not treat an IPv4-compatible IPv6 peer as an IPv4-mapped peer", () => {
    expect(clientAddress("::127.0.0.1", "198.51.100.1", trusted())).toBe("::7f00:1");
  });

  it.each(["203.0.113.1", "203.0.113.1, 198.51.100.1", "invalid-prefix, 198.51.100.1"])("ignores untrusted prefixes before the client in %s", prefix => {
    expect(clientAddress("127.0.0.1", `${prefix}, 198.51.100.2, 10.0.0.2`, trusted("127.0.0.1,10.0.0.2")))
      .toBe("198.51.100.2");
  });

  it("uses the nearest untrusted hop even when forwarding values repeat", () => {
    expect(clientAddress("127.0.0.1", "198.51.100.1, 198.51.100.2, 198.51.100.2", trusted())).toBe("198.51.100.2");
  });

  it.each(["not-an-ip", "127.1", "2130706433", "198.51.100.1:80", "[2001:db8::3]", "fe80::1%eth0", "198.51.100.01"])("falls back to the socket for malformed nearest hop %s", hop => {
    for (const peer of ["127.0.0.1", "::ffff:127.0.0.1"]) {
      expect(clientAddress(peer, `198.51.100.1, ${hop}`, trusted())).toBe("127.0.0.1");
    }
  });

  it.each([null, "", "127.0.0.1, ::ffff:127.0.0.1"])("keeps the missing-client result for %j", forwarded => {
    expect(clientAddress("::ffff:127.0.0.1", forwarded, trusted())).toBe("unknown");
  });

  it.each([undefined, "not-an-ip", "fe80::1%eth0"])("cannot obtain authority from forwarding without an IP socket: %j", peer => {
    expect(clientAddress(peer, "198.51.100.1", trusted())).toBe("unknown");
  });
});
