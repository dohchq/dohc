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

  it("fills the character window when the next whole line will not fit", () => {
    // 100 lines of 10,000 characters: far under the LINE window, far over the
    // character one. Only the character bound sees this shape.
    const text = lines(100, 10_000);
    const preview = conflictPreview(text, 1);
    expect(preview.text).toHaveLength(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.text.length + preview.hiddenChars).toBe(text.length);
  });

  it("cuts inside a single line wider than the whole window", () => {
    const text = "y".repeat(CONFLICT_PREVIEW_MAX_CHARS * 4);
    const preview = conflictPreview(text, 1);
    expect(preview.text).toHaveLength(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.hiddenChars).toBe(CONFLICT_PREVIEW_MAX_CHARS * 3);
  });

  // Which characters the LINE window counts is a measured fact about the
  // renderer, not a reading of the spec — see the note on the constants. Only
  // LF forces a line box under the pane's `white-space: pre-wrap`; CRLF does
  // so through its LF.
  it.each([
    ["\n", 1],
    ["\r\n", 2],
  ])("bounds line boxes for a body broken by %j", (lineBreak, breakUnits) => {
    const text = `${"line".repeat(4)}${lineBreak}`.repeat(
      CONFLICT_PREVIEW_MAX_LINES * 3,
    );
    const preview = conflictPreview(text, 1);
    expect(preview.text.split("\n").length - 1).toBe(CONFLICT_PREVIEW_MAX_LINES);
    expect(preview.text.length).toBe(
      CONFLICT_PREVIEW_MAX_LINES * (16 + breakUnits),
    );
    expect(preview.hiddenChars).toBeGreaterThan(0);
    // CRLF must cost ONE line, not two. Counting each half separately would
    // halve the window for every Windows document.
    expect(preview.text.endsWith(lineBreak)).toBe(true);
  });

  // The other side of that measurement. A character that only SOFT wraps is
  // not a line box, so a body full of them is one line to the line window and
  // the CHARACTER window is what holds it. Bounded either way — and cutting
  // these at the line window would have shown far less of the file than it
  // safely could.
  it.each([
    ["CR", "\r"],
    ["U+2028 LINE SEPARATOR", "\u2028"],
    ["U+2029 PARAGRAPH SEPARATOR", "\u2029"],
    ["VT", "\u000b"],
    ["FF", "\u000c"],
    ["NEL", "\u0085"],
  ])("holds a body separated by %s at the character window", (_label, separator) => {
    const text = `${"line".repeat(4)}${separator}`.repeat(
      CONFLICT_PREVIEW_MAX_LINES * 3,
    );
    const preview = conflictPreview(text, 1);
    expect(preview.text).toHaveLength(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.text.length + preview.hiddenChars).toBe(text.length);
  });

  it("stops on the line boundary the LINE window makes", () => {
    // The line window bounds line boxes, so filling past it would paint the
    // very thing it exists to bound. It is the one cut that stays on a
    // boundary — progress is guaranteed there by the next window's lines.
    const text = lines(CONFLICT_PREVIEW_MAX_LINES * 3, 10);
    const preview = conflictPreview(text, 1);
    expect(preview.text.split("\n").length - 1).toBe(CONFLICT_PREVIEW_MAX_LINES);
    expect(preview.text.endsWith("\n")).toBe(true);
    expect(preview.text.length).toBeLessThan(CONFLICT_PREVIEW_MAX_CHARS);
  });

  it("never ends the preview on half a surrogate pair", () => {
    // A cut between the two halves of an astral character leaves a lone high
    // surrogate, which renders as one replacement glyph. One line, so the
    // window has no boundary to fall back to and must cut inside it.
    //
    // The leading "x" pushes every pair onto an odd index, so the window
    // lands INSIDE one. Without the guard the preview would end on the
    // leading half.
    const body = `x${"🌱".repeat(CONFLICT_PREVIEW_MAX_CHARS)}`;
    const preview = conflictPreview(body, 1);
    const lastUnit = preview.text.charCodeAt(preview.text.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit < 0xdc00).toBe(false);
    expect(preview.text).toHaveLength(CONFLICT_PREVIEW_MAX_CHARS - 1);
    expect(preview.text.length + preview.hiddenChars).toBe(body.length);
    // The whole preview still decodes: no replacement character anywhere.
    expect(preview.text).not.toContain("�");
    expect([...preview.text]).toHaveLength(CONFLICT_PREVIEW_MAX_CHARS / 2);
  });

  it("bounds a 10 MiB side to one window", () => {
    const text = lines(250_000, 41);
    expect(text.length).toBeGreaterThan(10 * 1024 * 1024);
    const preview = conflictPreview(text, 1);
    expect(preview.text.length).toBeLessThanOrEqual(CONFLICT_PREVIEW_MAX_CHARS);
    expect(preview.hiddenChars).toBe(text.length - preview.text.length);
  });

  // Every shape, including the one that used to stall: a short complete line
  // followed by a line far wider than the window. Requiring a line boundary
  // kept the cut on that first newline, so 58 of the first 59 presses of
  // "Show more" changed nothing.
  const shapes: [string, string][] = [
    ["many short lines", lines(CONFLICT_PREVIEW_MAX_LINES * 5, 10)],
    ["one 1 MiB line", "y".repeat(1024 * 1024)],
    ["a header then a 1 MiB line", `# header\n${"y".repeat(1024 * 1024)}`],
    ["long lines", lines(60, 20_000)],
    ["10 MiB, newline-heavy", lines(250_000, 41)],
    ["a CR-only body", "line\r".repeat(300_000)],
    ["a CRLF body", "line\r\n".repeat(200_000)],
  ];

  it.each(shapes)("every press of Show more reveals more of %s", (_label, text) => {
    let previous = conflictPreview(text, 1);
    expect(previous.hiddenChars).toBeGreaterThan(0);
    for (let windows = 2; windows <= 60; windows += 1) {
      const next = conflictPreview(text, windows);
      expect(next.text.startsWith(previous.text)).toBe(true);
      expect(next.text.length + next.hiddenChars).toBe(text.length);
      if (previous.hiddenChars === 0) {
        expect(next.hiddenChars).toBe(0);
        continue;
      }
      // The press must pay for itself: strictly more painted, strictly less
      // held back, every time, until the side is fully shown.
      expect(next.text.length).toBeGreaterThan(previous.text.length);
      expect(next.hiddenChars).toBeLessThan(previous.hiddenChars);
      previous = next;
    }
  });

  it("enough windows always reach the end of the side", () => {
    const text = lines(CONFLICT_PREVIEW_MAX_LINES * 5, 10);
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
