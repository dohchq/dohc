import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./base64";

describe("renderer base64", () => {
  it("round-trips binary data across encoder chunk boundaries", () => {
    const bytes = Uint8Array.from({ length: 100_003 }, (_, index) => index % 256);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64ToBytes(encoded)).toEqual(bytes);
  });

  it("rejects malformed input instead of returning partial recovery bytes", () => {
    expect(() => base64ToBytes("not base64!" )).toThrow();
  });
});
