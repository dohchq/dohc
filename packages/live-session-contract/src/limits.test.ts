import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import {
  LIVE_MARKDOWN_MAX_BYTES,
  exceedsLiveMarkdownLimit,
  exceedsUtf8Bytes,
  utf8ByteLength,
} from "./limits.js";

test("admits exactly 2 MiB of projected UTF-8 Markdown", () => {
  expect(LIVE_MARKDOWN_MAX_BYTES).toBe(2 * 1024 * 1024);

  const ascii = "a".repeat(LIVE_MARKDOWN_MAX_BYTES);
  const emoji = "💡".repeat(LIVE_MARKDOWN_MAX_BYTES / 4);
  const loneSurrogates =
    "\ud800".repeat(Math.floor(LIVE_MARKDOWN_MAX_BYTES / 3)) + "aa";

  for (const exactLimit of [ascii, emoji, loneSurrogates]) {
    expect(utf8ByteLength(exactLimit)).toBe(
      new TextEncoder().encode(exactLimit).length,
    );
    expect.soft(exceedsLiveMarkdownLimit(exactLimit)).toBe(false);
    expect(exceedsUtf8Bytes(exactLimit, LIVE_MARKDOWN_MAX_BYTES)).toBe(false);

    const overLimit = `${exactLimit}a`;
    expect.soft(exceedsLiveMarkdownLimit(overLimit)).toBe(true);
    expect(exceedsUtf8Bytes(overLimit, LIVE_MARKDOWN_MAX_BYTES)).toBe(true);
  }
});

test("the engine admits the same Markdown size as the desktop app", () => {
  const rust = readFileSync(
    new URL("../../../crates/dohc-engine-collab/src/limits.rs", import.meta.url),
    "utf8",
  );
  const value = /pub const MAX_PUBLIC_MARKDOWN_BYTES: usize = ([\d_ *]+);/.exec(rust)?.[1];
  expect(value, "MAX_PUBLIC_MARKDOWN_BYTES in limits.rs").toBeDefined();
  const bytes = value!
    .split("*")
    .reduce((product, factor) => product * Number(factor.replaceAll("_", "")), 1);
  expect(bytes).toBe(LIVE_MARKDOWN_MAX_BYTES);
});
