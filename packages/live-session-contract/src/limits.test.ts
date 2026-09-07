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
