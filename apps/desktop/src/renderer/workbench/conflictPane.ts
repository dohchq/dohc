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
/// not — 200,000 breaks is 200,000 line boxes and 200,000 characters. "Line"
/// here means what `white-space: pre-wrap` breaks on, which is LF, CRLF, and a
/// standalone CR — see `lineEnd`.
///
/// MEASURED by conflictPane.measure.test.ts against this repository's tracked
/// text (`.md`, `.ts`, `.tsx`, `.rs`; 919 files), the stand-in for the
/// documents a workspace holds — dohc has no user corpus yet:
///
///   lines: p50 191, p90 1,063, p99 4,414, max 13,404
///   chars: p50 7,022, p90 39,271, p99 174,756, max 469,068
///   longest line: p50 99, p99 552, max 19,184
///
/// Both windows sit above the 99th-percentile document, so 0.9% of them reach
/// the character window and 0.8% the line window. A body past either shows its
/// first window and a count of what is held back, and `Show more` reaches the
/// rest. That is a weaker cut than the compare surface makes today — it stops
/// at 800 diff lines and offers no way to see the rest at all.
///
/// The corpus holds NO line wider than the character window, so it says
/// nothing about the mid-line cut below. The unit tests carry that shape.
export const CONFLICT_PREVIEW_MAX_CHARS = 200_000;
export const CONFLICT_PREVIEW_MAX_LINES = 5_000;

/// The largest combined copy this surface will edit and post, in UTF-8 bytes.
///
/// TODAY this is the engine's own limit: the `apply-merged` arm in
/// `crates/dohc-workspace-engine/src/lib.rs` refuses a merged text over
/// `MAX_DESKTOP_CAPTURE_TEXT_BYTES`, and a surface must not offer an editing
/// affordance whose apply the engine will refuse. The number is copied rather
/// than imported because the engine's TypeScript twin lives in
/// `versionedLoopbackEngine.ts`, whose first line is `import { createHash }
/// from "node:crypto"` — importing it from the renderer would pull a Node
/// builtin into the browser bundle, which neither the typecheck nor the test
/// suite would notice. `engineTextLimits.test.ts` is what holds the copy
/// honest; it reads the arm and fails when the two drift.
///
/// THIS NUMBER IS ABOUT TO STOP BEING THE ENGINE'S (#528 / PR #569). That PR
/// raises the merged-resolution cap to 8,323,072 bytes — the conflict
/// listing's own frame budget — so every side the surface can display becomes
/// a side the engine would accept back. When it lands, this constant stops
/// mirroring the engine and becomes what it always also was: the largest body
/// this surface will hold in a CONTROLLED textarea that re-renders per
/// keystroke. At that point it needs its own measured bound, set above the
/// largest healthy document (469,068 characters — see the corpus above), not
/// this number. See #566 and the note in engineTextLimits.test.ts.
export const CONFLICT_COMBINED_MAX_BYTES = 128 * 1024;

export type ConflictPreview = {
  /// The text the pane paints.
  text: string;
  /// How much the window held back, in UTF-16 code units. Zero means the pane
  /// shows the whole side.
  ///
  /// Code units, not lines and not characters, and both of those are
  /// deliberate. Counting the LINES of what we are not painting would walk the
  /// whole body, which is the cost this bound exists to remove. Counting
  /// CHARACTERS would too: `.length` counts code units, so a body of astral
  /// characters — emoji, rare CJK, the mathematical alphabets — reports twice
  /// the count a reader would count, because each of those spends two units.
  /// The label the pane shows says "characters" because that is the reader's
  /// word for it, and every BMP body (all ASCII, all ordinary CJK) reports it
  /// exactly. An emoji-heavy side overstates, and the trade is deliberate: the
  /// exact count costs a full-body walk to improve a number that sits beside a
  /// "Show more" control.
  hiddenChars: number;
};

/// The first `windows` preview windows of one conflict side.
///
/// The cut PREFERS a line boundary but never requires one: a window that could
/// not fit the next whole line fills to the character bound instead, inside
/// that line. Requiring the boundary made `Show more` stop making progress —
/// a six-character line followed by a 1 MiB line revealed nothing for the
/// first five presses, because the window kept landing on the same newline.
///
/// The one cut that stays on a boundary is the one the LINE window makes.
/// Filling past it would paint the line boxes that window exists to bound, and
/// progress is already guaranteed there: the next window admits more lines.
export function conflictPreview(text: string, windows: number): ConflictPreview {
  const maxChars = CONFLICT_PREVIEW_MAX_CHARS * windows;
  const maxLines = CONFLICT_PREVIEW_MAX_LINES * windows;

  let cut = 0;
  let lines = 0;
  // Both break characters are tracked, and each is re-sought only once it has
  // been passed. Searching for both on every line would make a body that
  // contains none of one of them cost a full scan per line.
  let nextLf = text.indexOf("\n");
  let nextCr = text.indexOf("\r");
  while (cut < text.length && lines < maxLines) {
    const end = lineEnd(text, nextLf, nextCr);
    if (end > maxChars) break;
    cut = end;
    lines += 1;
    if (nextLf !== -1 && nextLf < cut) nextLf = text.indexOf("\n", cut);
    if (nextCr !== -1 && nextCr < cut) nextCr = text.indexOf("\r", cut);
  }

  if (lines < maxLines && cut < text.length && cut < maxChars) {
    cut = Math.min(text.length, maxChars);
    // Never split a surrogate pair: the leading half alone renders as one
    // replacement glyph, so back up onto the character boundary.
    if (cut < text.length && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  }

  if (cut >= text.length) return { text, hiddenChars: 0 };
  return { text: text.slice(0, cut), hiddenChars: text.length - cut };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code < 0xdc00;
}

/// Where the line starting at the current cut ends: just past its break, or at
/// the end of the body.
///
/// `white-space: pre-wrap` — what the pane paints with — breaks a line on a
/// standalone CR as well as on LF, and treats CRLF as ONE break. A loop that
/// only looked for LF let a CR-only body through as a single line, so the
/// character bound was the only thing holding it: 40,000 line boxes against
/// the 5,000 this window allows.
function lineEnd(text: string, nextLf: number, nextCr: number): number {
  if (nextLf === -1 && nextCr === -1) return text.length;
  if (nextCr === -1 || (nextLf !== -1 && nextLf < nextCr)) return nextLf + 1;
  return text.charCodeAt(nextCr + 1) === 0x0a ? nextCr + 2 : nextCr + 1;
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
    } else if (isHighSurrogate(code)) {
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
