import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "./workspaceTextLimits";

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
