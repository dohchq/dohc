import { describe, expect, it } from "vitest";
import { senderAddressKey } from "./clientAddress";

describe("senderAddressKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::5", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["not an address", "unknown"],
  ])("keys %s as %s", (address, key) => {
    expect(senderAddressKey(address)).toBe(key);
  });

  it("gives every address in one /64 the same key", () => {
    expect(senderAddressKey("2001:db8:1:2::1")).toBe(senderAddressKey("2001:db8:1:2:ffff::9"));
    expect(senderAddressKey("2001:db8:1:2::1")).not.toBe(senderAddressKey("2001:db8:1:3::1"));
  });
});
