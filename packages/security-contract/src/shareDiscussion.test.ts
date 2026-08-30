import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT,
  SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
  normalizeShareDiscussionBody,
} from "./shareDiscussion";

const exactRawByteBoundary = `${"\u1100\u1161\u11a8".repeat(888)}abcdefgh`;
const overRawByteBoundary = "\u1100\u1161\u11a8".repeat(889);

describe("share discussion bodies", () => {
  it("pins the durable limits", () => {
    expect(SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT).toBe(2_000);
    expect(SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT).toBe(8_000);
  });

  it.each([
    { label: "empty", input: "", expected: null },
    { label: "one code point", input: "x", expected: "x" },
    {
      label: "exactly 2,000 emoji and 8,000 raw bytes",
      input: "😀".repeat(2_000),
      expected: "😀".repeat(2_000),
    },
    {
      label: "2,001 normalized code points",
      input: "a".repeat(2_001),
      expected: null,
    },
    {
      label: "exactly 8,000 decomposed raw bytes",
      input: exactRawByteBoundary,
      expected: exactRawByteBoundary.normalize("NFC"),
    },
    {
      label: "8,001 decomposed raw bytes despite a short NFC form",
      input: overRawByteBoundary,
      expected: null,
    },
    {
      label: "a combining sequence",
      input: "e\u0301",
      expected: "é",
    },
  ])("normalizes or rejects $label", ({ input, expected }) => {
    expect(normalizeShareDiscussionBody(input)).toBe(expected);
  });

  it("measures the decomposed raw-byte cases before normalization", () => {
    expect(Buffer.byteLength(exactRawByteBoundary, "utf8")).toBe(8_000);
    expect(Array.from(exactRawByteBoundary.normalize("NFC"))).toHaveLength(896);
    expect(Buffer.byteLength(overRawByteBoundary, "utf8")).toBe(8_001);
    expect(Array.from(overRawByteBoundary.normalize("NFC"))).toHaveLength(889);
  });
});
