import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { exceedsUtf8Bytes, utf8ByteLength } from "./workspaceTextLimits";

describe("utf8ByteLength", () => {
  it.each([
    "plain ASCII",
    "caf\u00e9",
    "\ud83d\udca1",
    "\ud800",
    "\udc00",
    "a\ud83d\udca1\u6c34\ud800z",
  ])("matches Node's UTF-8 byte contract for %j", (value) => {
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, "utf8"));
  });
});

describe("exceedsUtf8Bytes", () => {
  it.each([
    "plain ASCII",
    "caf\u00e9",
    "\u6c34",
    "\ud83d\udca1",
    "\ud800",
    "\udc00",
    "a\ud83d\udca1\u6c34\ud800z",
  ])("is exact at the UTF-8 boundary for %j", (value) => {
    const bytes = Buffer.byteLength(value, "utf8");
    expect(exceedsUtf8Bytes(value, bytes)).toBe(false);
    expect(exceedsUtf8Bytes(value, bytes - 1)).toBe(true);
  });

  it("settles an oversized ASCII body from its code-unit count", () => {
    expect(exceedsUtf8Bytes("x".repeat(10 * 1024 * 1024), 128 * 1024)).toBe(
      true,
    );
  });
});
