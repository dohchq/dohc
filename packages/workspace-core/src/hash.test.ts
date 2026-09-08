import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash";

// FIPS 180-2 known-answer vectors, independent of the implementation under
// test. Relay blobs, key envelopes, scan metadata, MCP tools, and the sqlite
// worker all share this digest; a byte-handling regression here corrupts
// every one of their content addresses at once.
const SHA256_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 known answers for text input", () => {
    expect(sha256Hex("abc")).toBe(SHA256_ABC);
    expect(sha256Hex("")).toBe(SHA256_EMPTY);
  });

  it("hashes a string as its UTF-8 bytes", () => {
    // U+00E9 encodes to 0xC3 0xA9 in UTF-8. The string form and its encoded
    // bytes must produce one digest, or string callers (key envelopes) drift
    // from byte callers (blobs) over the same content.
    expect(sha256Hex("é")).toBe(sha256Hex(Uint8Array.of(0xc3, 0xa9)));
  });

  it("hashes only a Uint8Array view's own bytes, never its backing buffer", () => {
    const backing = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00]);
    const view = backing.subarray(1, 4); // "abc" at a nonzero offset
    expect(sha256Hex(view)).toBe(SHA256_ABC);
  });
});
