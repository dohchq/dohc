import { expect, it, vi } from "vitest";
import { hashLiveTicketToken, mintLiveTicketToken } from "./liveTicketSecurity.js";

const token = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
const key = Uint8Array.from({ length: 32 }, (_, index) => index);

it("encodes exactly one 32-byte entropy draw as lowercase hex", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 32);
  const entropy = vi.fn(() => bytes);
  const minted = mintLiveTicketToken(entropy);
  expect(minted).toBe(token);
  expect(entropy).toHaveBeenCalledOnce();
  expect(entropy).toHaveBeenCalledWith(32);
  bytes.fill(0);
  expect(minted).toBe(token);
});

it("encodes only the selected entropy view", () => {
  const allocation = Uint8Array.from({ length: 64 }, (_, index) => index);
  expect(mintLiveTicketToken(() => allocation.subarray(32))).toBe(token);
});

it.each([0, 31, 33, 64])("refuses %i entropy bytes without another draw", length => {
  const entropy = vi.fn(() => new Uint8Array(length));
  expect(() => mintLiveTicketToken(entropy)).toThrow("exactly 32 bytes");
  expect(entropy).toHaveBeenCalledOnce();
});

it.each([null, undefined, "a".repeat(32), new ArrayBuffer(32), Array(32).fill(0)])(
  "refuses a non-byte entropy result",
  value => {
    const entropy = vi.fn(() => value as unknown as Uint8Array);
    expect(() => mintLiveTicketToken(entropy)).toThrow(TypeError);
    expect(entropy).toHaveBeenCalledOnce();
  },
);

it("propagates entropy failure without retrying", () => {
  const failure = new Error("entropy unavailable");
  const entropy = vi.fn(() => { throw failure; });
  expect(() => mintLiveTicketToken(entropy)).toThrow(failure);
  expect(entropy).toHaveBeenCalledOnce();
});

it("matches the domain-separated HMAC over decoded token bytes", () => {
  // Independent .NET HMACSHA256 vector: key bytes 0..31, token bytes 32..63.
  expect(hashLiveTicketToken(token, key)).toBe("FyR9Ep2ThvcRw-y4GvoU2Qk2YwMOa8dj9aL0My0lv5Y");
  expect(hashLiveTicketToken(token, new Uint8Array(32))).not.toBe(hashLiveTicketToken(token, key));
});

it.each([token.toUpperCase(), ` ${token}`, `${token}\n`, `0x${token}`, token.slice(2), "g".repeat(64)])(
  "refuses a noncanonical token before hashing",
  value => {
    expect(() => hashLiveTicketToken(value, key)).toThrow(TypeError);
    expect(hashLiveTicketToken(token, key)).toBe("FyR9Ep2ThvcRw-y4GvoU2Qk2YwMOa8dj9aL0My0lv5Y");
  },
);
