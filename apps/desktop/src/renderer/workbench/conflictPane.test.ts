import { describe, expect, it } from "vitest";
import {
  CONFLICT_PREVIEW_MAX_CHARS,
  CONFLICT_PREVIEW_MAX_LINES,
  conflictPreview,
  exceedsUtf8Bytes,
  utf8ByteLength,
} from "./conflictPane";

function lines(count: number, lineChars: number): string {
  const line = "x".repeat(lineChars);
  return `${Array.from({ length: count }, () => line).join("\n")}\n`;
}

describe("conflictPreview", () => {
  it("paints a small side whole and hides nothing", () => {
    const text = "one\ntwo\nthree\n";
    expect(conflictPreview(text, 1)).toEqual({ text, hiddenChars: 0 });
  });

  it("paints an empty side whole", () => {
    expect(conflictPreview("", 1)).toEqual({ text: "", hiddenChars: 0 });
  });

  it("cuts a line-heavy side at the line window, on a line boundary", () => {
    const text = lines(CONFLICT_PREVIEW_MAX_LINES * 3, 10);
    const preview = conflictPreview(text, 1);
    expect(preview.text.split("\n").length - 1).toBe(CONFLICT_PREVIEW_MAX_LINES);
    expect(preview.text.endsWith("\n")).toBe(true);
    expect(preview.text.length + preview.hiddenChars).toBe(text.length);
    expect(preview.hiddenChars).toBeGreaterThan(0);
  });

  it("cuts a character-heavy side at the character window, on a line boundary", () => {
    // 100 lines of 10,000 characters: far under the LINE window, far over the
    // character one. Only the character bound sees this shape.
    const text = lines(100, 10_000);
    const preview = conflictPreview(text, 1);
    expect(preview.text.length).toBeLessThanOrEqual(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.text.split("\n").length - 1).toBeLessThan(100);
    expect(preview.text.endsWith("\n")).toBe(true);
    expect(preview.text.length + preview.hiddenChars).toBe(text.length);
  });

  it("cuts inside a single line wider than the whole window", () => {
    const text = "y".repeat(CONFLICT_PREVIEW_MAX_CHARS * 4);
    const preview = conflictPreview(text, 1);
    expect(preview.text).toHaveLength(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.hiddenChars).toBe(CONFLICT_PREVIEW_MAX_CHARS * 3);
  });

  it("bounds a 10 MiB side to one window", () => {
    const text = lines(250_000, 41);
    expect(text.length).toBeGreaterThan(10 * 1024 * 1024);
    const preview = conflictPreview(text, 1);
    expect(preview.text.length).toBeLessThanOrEqual(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.hiddenChars).toBe(text.length - preview.text.length);
  });

  it("each window shows more and holds back less", () => {
    const text = lines(CONFLICT_PREVIEW_MAX_LINES * 5, 10);
    const first = conflictPreview(text, 1);
    const second = conflictPreview(text, 2);
    expect(second.text.startsWith(first.text)).toBe(true);
    expect(second.text.length).toBeGreaterThan(first.text.length);
    expect(second.hiddenChars).toBeLessThan(first.hiddenChars);
    // Enough windows always reach the end of the side.
    expect(conflictPreview(text, 5)).toEqual({ text, hiddenChars: 0 });
  });
});

describe("utf8ByteLength", () => {
  const encoder = new TextEncoder();
  const samples = [
    "",
    "plain ascii\n",
    "café", // two bytes
    "日本語の文書", // three bytes
    "🌱 seedling", // surrogate pair, four bytes
    "\ud83c", // lone high surrogate
    "\udfe1", // lone low surrogate
    "\ud83c abc", // high surrogate not followed by a low one
  ];

  it("matches TextEncoder on every shape", () => {
    for (const sample of samples) {
      expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).length);
    }
  });
});

describe("exceedsUtf8Bytes", () => {
  const encoder = new TextEncoder();

  it("agrees with an exact encode across the boundary", () => {
    // "é" is one code unit and two UTF-8 bytes, so the cheap code-unit
    // comparisons cannot settle these — the exact walk has to.
    for (let count = 1; count <= 40; count += 1) {
      const text = "é".repeat(count);
      const bytes = encoder.encode(text).length;
      expect(exceedsUtf8Bytes(text, bytes)).toBe(false);
      expect(exceedsUtf8Bytes(text, bytes - 1)).toBe(true);
    }
  });

  it("is exact at the cap for a body of astral characters", () => {
    // 4 bytes across 2 code units: the shape the cheap bounds get wrong in
    // both directions if the walk is skipped.
    const text = "🌱".repeat(50_000);
    expect(encoder.encode(text).length).toBe(200_000);
    expect(exceedsUtf8Bytes(text, 200_000)).toBe(false);
    expect(exceedsUtf8Bytes(text, 199_999)).toBe(true);
  });

  it("settles a 10 MiB body from its code-unit count alone", () => {
    const text = "x".repeat(10 * 1024 * 1024);
    expect(exceedsUtf8Bytes(text, 128 * 1024)).toBe(true);
  });

  it("never reports an empty body as over any cap", () => {
    expect(exceedsUtf8Bytes("", 0)).toBe(false);
  });
});
