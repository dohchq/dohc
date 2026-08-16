import { describe, expect, it } from "vitest";
import { findPairingUrl, redactT3Output } from "./accessBlock";

// The exact shape a real t3@0.0.33 printed on 2026-08-15 (token replaced).
const ACCESS_BLOCK = [
  "T3 Code server is ready.",
  "Connection string: http://127.0.0.1:52835",
  "Token: c2VjcmV0LXRva2VuLXZhbHVl",
  "Pairing URL: http://127.0.0.1:52835/pair#token=c2VjcmV0LXRva2VuLXZhbHVl",
  "",
].join("\n");

describe("findPairingUrl", () => {
  it("parses the pairing URL out of the real access block", () => {
    expect(findPairingUrl(ACCESS_BLOCK)).toBe(
      "http://127.0.0.1:52835/pair#token=c2VjcmV0LXRva2VuLXZhbHVl",
    );
  });

  it("returns null until the pairing line is complete", () => {
    const truncated = ACCESS_BLOCK.slice(0, ACCESS_BLOCK.indexOf("#token=") + 10);
    expect(findPairingUrl(truncated)).toBeNull();
  });

  it("finds the URL when the line arrived split across chunks", () => {
    const chunkA = ACCESS_BLOCK.slice(0, 120);
    const chunkB = ACCESS_BLOCK.slice(120);
    expect(findPairingUrl(chunkA)).toBeNull();
    expect(findPairingUrl(chunkA + chunkB)).toBe(
      "http://127.0.0.1:52835/pair#token=c2VjcmV0LXRva2VuLXZhbHVl",
    );
  });

  it("rejects non-loopback pairing URLs", () => {
    expect(
      findPairingUrl("Pairing URL: http://192.168.1.4:1234/pair#token=abc\n"),
    ).toBeNull();
  });
});

describe("redactT3Output", () => {
  it("removes the token line credential", () => {
    const redacted = redactT3Output(ACCESS_BLOCK);
    expect(redacted).not.toContain("c2VjcmV0LXRva2VuLXZhbHVl");
    expect(redacted).toContain("Token: [redacted]");
  });

  it("removes the pairing fragment credential", () => {
    const redacted = redactT3Output(ACCESS_BLOCK);
    expect(redacted).toContain(
      "Pairing URL: http://127.0.0.1:52835/pair#token=[redacted]",
    );
  });

  it("redacts a fragment embedded in later log lines", () => {
    const line = 'navigated to "http://127.0.0.1:52835/pair#token=abc123&x=1"';
    expect(redactT3Output(line)).not.toContain("abc123");
  });

  it("leaves credential-free output unchanged", () => {
    const line = "[00:49:43.143] INFO (#339): Listening on http://127.0.0.1:52835";
    expect(redactT3Output(line)).toBe(line);
  });
});
