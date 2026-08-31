import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT,
  SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
  SHARE_DISCUSSION_NAME_BYTE_LIMIT,
  SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT,
  normalizeShareDiscussionBody,
  normalizeShareDiscussionDisplayName,
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
    { label: "a leading NUL", input: "\u0000hello", expected: null },
    { label: "an interior NUL", input: "hello\u0000world", expected: null },
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

describe("share discussion display names", () => {
  it("pins the durable limits", () => {
    expect(SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT).toBe(40);
    expect(SHARE_DISCUSSION_NAME_BYTE_LIMIT).toBe(160);
  });

  it.each([
    {
      label: "NFC composition",
      input: "Jose\u0301",
      expected: { ok: true, value: "José" },
    },
    {
      label: "leading, trailing, and repeated whitespace",
      input: "  Ada\t\n  Lovelace  ",
      expected: { ok: true, value: "Ada Lovelace" },
    },
    {
      label: "control removal",
      input: "A\u0000\u001fda",
      expected: { ok: true, value: "Ada" },
    },
    {
      label: "bidi-control removal",
      input: "A\u061c\u200e\u200f\u202a\u202e\u2066\u2069da",
      expected: { ok: true, value: "Ada" },
    },
    {
      label: "exactly 40 astral code points and 160 UTF-8 bytes",
      input: "😀".repeat(40),
      expected: { ok: true, value: "😀".repeat(40) },
    },
    {
      label: "41 astral code points",
      input: "😀".repeat(41),
      expected: { ok: false, reason: "too-long" },
    },
    {
      label: "a non-empty value that normalizes to empty",
      input: "\u0000\u202e",
      expected: { ok: false, reason: "empty" },
    },
    {
      label: "an exactly empty value",
      input: "",
      expected: { ok: false, reason: "empty" },
    },
    {
      label: "a non-string value",
      input: 40,
      expected: { ok: false, reason: "empty" },
    },
  ])("normalizes or rejects $label", ({ input, expected }) => {
    expect(normalizeShareDiscussionDisplayName(input)).toEqual(expected);
  });

  it("pins the exact UTF-8 byte boundary", () => {
    expect(Buffer.byteLength("😀".repeat(40), "utf8")).toBe(160);
    expect(Buffer.byteLength("😀".repeat(41), "utf8")).toBe(164);
  });
});
