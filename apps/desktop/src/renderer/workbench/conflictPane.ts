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
/// not — 200,000 line feeds is 200,000 line boxes and 200,000 characters.
///
/// "Line" means LF, and ONLY LF. That is not an assumption, it is a
/// measurement: a `<pre>` with the pane's own `white-space: pre-wrap` and
/// `overflow-wrap: break-word`, 2,000 two-character segments joined by each
/// candidate, in the Chromium this app ships (`playwright` chromium-1223):
///
///   LF        2,000 line boxes   forces a break
///   CRLF      2,000 line boxes   forces a break
///   CR           77 line boxes   soft wrap only
///   U+2028      118 line boxes   soft wrap only
///   U+2029      118 line boxes   soft wrap only
///   VT U+000B   116 line boxes   soft wrap only
///   FF U+000C    77 line boxes   soft wrap only
///   NEL U+0085  118 line boxes   soft wrap only
///
/// CSS resolves segment breaks to LF, and the CR of a CRLF is normalized away
/// by the HTML parser — but React writes text nodes directly, so a lone CR
/// reaching this pane stays a lone CR and lays out as an ordinary character.
/// A body broken only by any of the "soft wrap only" rows is ONE line to the
/// line window, and the CHARACTER window is what holds it. That is correct,
/// not a gap: those bodies cost soft wrapping over a bounded 200,000
/// characters, which is the thing the character window exists to bound.
///
/// Two earlier attempts got this wrong in opposite directions — one added CR
/// as a boundary, one wanted U+2028 and U+2029 — both from reading the spec
/// rather than the renderer. Measure before adding a third.
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

/// The largest combined copy this surface will EDIT, in UTF-8 bytes.
///
/// This is a renderer bound, not the engine's. #569 replaced the old
/// merged-text cap with a frame budget: `conflicts.resolve` succeeds when the
/// whole JSON-ENCODED request fits `RESOLVE_REQUEST_FRAME_BYTES` (8 MiB), so
/// what a body may weigh is whatever the rest of its request leaves.
///
/// WHAT BINDS IT is that frame, not responsiveness. JSON escaping costs at
/// most six bytes per raw byte — a body of control characters is the worst
/// case — so a body must stay under about (8 MiB minus the envelope) / 6.
/// `engineTextLimits.test.ts` proves this value clears that with the imported
/// contract rather than a restated number: at this bound the worst case is
/// 6 MiB encoded, leaving about 2 MiB of the frame spare.
///
/// RESPONSIVENESS TURNED OUT NOT TO BIND, and the first version of this
/// constant was wrong about that. Its benchmark assigned `textarea.value`
/// directly and reported 26-36 ms per keystroke here, which set the bound at
/// half this. That measured a write the shipping path does not make: on an
/// ordinary keystroke the browser applies the edit itself, and React's
/// controlled input skips the value write because the DOM already holds what
/// it wanted. Driving the REAL path — native input event, `onChange`,
/// `applyCombinedChange`, commit — costs about 1 ms per MiB:
///
///     495,878 characters   0.6 ms
///   1,048,576 characters   1.1 ms
///   8,388,608 characters   9.0 ms
///
/// The one expensive keystroke is the REFUSED one, about 28 ms at half a
/// megabyte and rising with the draft: a refusal leaves React holding a value
/// the DOM disagrees with, so it writes the whole string back. That lands once
/// when the user reaches the bound, which is the price of not letting the
/// draft grow without limit.
///
/// Re-measure with conflictPane.measure.test.ts, which drives the shipping
/// component in the Chromium this app ships:
///
///   DOHC_MEASURE_CONFLICT=1 pnpm --filter @dohc/desktop exec vitest run conflictPane.measure
///
/// WHY THIS VALUE. It is the largest round value that provably fits the frame
/// in the worst case, and it clears `CONFLICT_HEALTHY_DOCUMENT_MAX_BYTES` by
/// more than double — which matters, because that corpus figure grew by 6%
/// during the writing of this change alone. UTF-8 never spends less than one
/// byte per UTF-16 code unit, so a bound in BYTES caps the code units that
/// drive the cost above for every script.
///
/// WHAT IT HOLDS, per script, because bytes are not characters. About
/// 1,048,576 characters of ASCII; about 524,288 of Latin-1 accented text or
/// Greek or Cyrillic at two bytes; about 349,525 of CJK or most other
/// three-byte text; about 262,144 emoji. The corpus behind the healthy figure
/// is ASCII-dominated source and Markdown, so it says nothing about how large
/// a healthy CJK document is — that is the open question in this number, and
/// it is why the guard pins the CJK case explicitly rather than trusting a
/// character count to stand in for a byte one.
///
/// Above the bound the surface degrades rather than refuses: keep a side, then
/// edit the file in the editor, which is incremental and pays none of this.
export const CONFLICT_COMBINED_EDIT_MAX_BYTES = 1024 * 1024;

/// The largest document in the measured corpus, in UTF-8 BYTES — the healthy
/// maximum the bound above has to clear (AGENTS.md: set a limit that rejects
/// work beyond the measured healthy range).
///
/// BYTES, because that is the unit the bound is enforced in. Recording it in
/// characters compared two different things and proved nothing for any
/// multi-byte script: a 400,000-character CJK document is comfortably under
/// the character maximum and about 1.2 MiB of UTF-8, which this surface
/// refuses. `engineTextLimits.test.ts` now pins that case directly.
///
/// A SNAPSHOT, re-read by conflictPane.measure.test.ts, which prints the
/// current corpus every run. It drifts as the repository grows; when it passes
/// the bound, re-measure both rather than nudging this number.
export const CONFLICT_HEALTHY_DOCUMENT_MAX_BYTES = 496_029;

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
  while (cut < text.length && lines < maxLines) {
    const newline = text.indexOf("\n", cut);
    const end = newline === -1 ? text.length : newline + 1;
    if (end > maxChars) break;
    cut = end;
    lines += 1;
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

/// What one change to the combined copy does: it is taken, or it is refused
/// for being past the editing bound and the attempted size is reported.
export type CombinedChange =
  | { accepted: true; text: string }
  | { accepted: false; refusedBytes: number };

/// The decision behind every keystroke in the combine textarea.
///
/// Exported as a pure function so the thing that runs per keystroke is one
/// piece of code with one set of tests — and so the browser benchmark in
/// conflictPane.measure.test.ts can drive the SHIPPING decision rather than a
/// copy of it that could quietly disagree.
export function applyCombinedChange(next: string): CombinedChange {
  if (exceedsUtf8Bytes(next, CONFLICT_COMBINED_EDIT_MAX_BYTES)) {
    // One walk of the refused body, paid on a body that cannot be applied.
    return { accepted: false, refusedBytes: utf8ByteLength(next) };
  }
  return { accepted: true, text: next };
}
