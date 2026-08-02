// What one conflict side is allowed to paint, and what a combined copy is
// allowed to hold (#536).
//
// PR #524 made a 2 MB - 10 MiB conflict side listable, which was right: those
// conflicts used to be unrecoverable. The conflict panes then painted whatever
// arrived. A side goes into one `<pre>` with `whitespace-pre-wrap
// break-words`, so the browser lays out every character of it even inside a
// `max-h-40` scroller — the scroll height is not known until it does. The
// sibling compare surface has been bounded since #516 (see unifiedDiff.tsx);
// these panes had no equivalent.
//
// Nothing here rejects work. The preview shows a window and says how much it
// held back, and `Show more` extends it — the same shape as the compare
// surface's display bound, except the rest stays reachable.

/// One preview window: whole lines, up to whichever of the two bounds ends
/// first. Both are needed. Characters bound the text the browser must lay out.
/// Lines bound the line boxes it lays them out into, which characters alone do
/// not — 200,000 newlines is 200,000 line boxes and 200,000 characters.
///
/// MEASURED by conflictPane.measure.test.ts against this repository's tracked
/// text (`.md`, `.ts`, `.tsx`, `.rs`; 914 files), the stand-in for the
/// documents a workspace holds — dohc has no user corpus yet:
///
///   lines: p50 191, p90 1,063, p99 4,414, max 13,404
///   chars: p50 7,026, p90 39,271, p99 174,756, max 469,068
///
/// Both windows sit above the 99th-percentile document, so 0.9% of them reach
/// the character window and 0.8% the line window. A body past either shows its
/// first window and a count of what is held back, and `Show more` reaches the
/// rest. That is a weaker cut than the compare surface makes today — it stops
/// at 800 diff lines and offers no way to see the rest at all.
export const CONFLICT_PREVIEW_MAX_CHARS = 200_000;
export const CONFLICT_PREVIEW_MAX_LINES = 5_000;

/// The engine's in-band text cap: `MAX_DESKTOP_CAPTURE_TEXT_BYTES` in
/// `crates/dohc-workspace-engine/src/lib.rs`, which the engine re-checks on
/// every `apply-merged`. Held here as well because a surface must not offer an
/// editing affordance whose apply the engine will refuse.
/// `engineTextLimits.test.ts` fails when this number and the Rust one drift
/// apart.
export const CONFLICT_COMBINED_MAX_BYTES = 128 * 1024;

export type ConflictPreview = {
  /// The text the pane paints.
  text: string;
  /// Characters the window held back. Zero means the pane shows the whole
  /// side. Characters, not lines, because counting the lines of what we are
  /// NOT painting would walk the whole body — the cost this bound removes.
  hiddenChars: number;
};

/// The first `windows` preview windows of one conflict side.
///
/// The cut lands on a line boundary. The one exception is a single line longer
/// than the character window, which is cut mid-line — there is no boundary to
/// land on.
export function conflictPreview(text: string, windows: number): ConflictPreview {
  const maxChars = CONFLICT_PREVIEW_MAX_CHARS * windows;
  const maxLines = CONFLICT_PREVIEW_MAX_LINES * windows;

  let cut = 0;
  let lines = 0;
  while (cut < text.length && lines < maxLines) {
    const newline = text.indexOf("\n", cut);
    const end = newline === -1 ? text.length : newline + 1;
    if (end > maxChars) break;
    cut = end;
    lines += 1;
  }

  // One line wider than the whole window: cut inside it rather than paint it.
  if (cut === 0) cut = Math.min(text.length, maxChars);
  if (cut >= text.length) return { text, hiddenChars: 0 };
  return { text: text.slice(0, cut), hiddenChars: text.length - cut };
}

// One walk of the UTF-8 encoding, stopping as soon as the count passes
// `stopAbove`. UTF-8 spends one byte per ASCII unit, two below U+0800, four
// across a surrogate PAIR, and three for everything else including a lone
// surrogate (which encodes as the replacement character).
function utf8Bytes(text: string, stopAbove: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code < 0xdc00) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > stopAbove) return bytes;
  }
  return bytes;
}

/// Whether `text` is more than `limitBytes` of UTF-8, without encoding it.
///
/// `new TextEncoder().encode(text).length` copies the whole body to count it,
/// and this runs on every keystroke in the combine textarea. UTF-8 spends at
/// least one byte and at most three per UTF-16 code unit, so the two cheap
/// comparisons settle almost every call and the exact walk that follows stops
/// as soon as it passes the limit.
export function exceedsUtf8Bytes(text: string, limitBytes: number): boolean {
  if (text.length > limitBytes) return true;
  if (text.length * 3 <= limitBytes) return false;
  return utf8Bytes(text, limitBytes) > limitBytes;
}

/// The exact UTF-8 byte length, for the message that reports what the user
/// wrote. Only called on a body already known to be over the limit, so the
/// walk is paid on a body the user cannot apply anyway.
export function utf8ByteLength(text: string): number {
  return utf8Bytes(text, Number.POSITIVE_INFINITY);
}
