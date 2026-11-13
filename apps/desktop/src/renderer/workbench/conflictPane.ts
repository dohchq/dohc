import { exceedsUtf8Bytes, utf8ByteLength } from "../../workspaces/workspaceTextLimits";

// What one conflict side is allowed to paint, and what a combined copy is
// allowed to hold.
//
// A conflict side can be up to 10 MiB. A side goes into one `<pre>` with
// `whitespace-pre-wrap break-words`, so the browser lays out every character
// of it even inside a `max-h-40` scroller, because the scroll height is not
// known until it does. unifiedDiff.tsx bounds the sibling compare surface.
//
// Nothing here rejects work. The preview shows a window and says how much it
// held back, and `Show more` extends it, so the rest stays reachable.

/// One preview window: whole lines, up to whichever of the two bounds ends
/// first. Both are needed. Characters bound the text the browser must lay out.
/// Lines bound the line boxes it lays them out into, which characters alone do
/// not: 200,000 line feeds is 200,000 line boxes and 200,000 characters.
///
/// "Line" means LF only, because that is what the renderer breaks on. In the
/// pane's `<pre>`, in the Chromium this app ships, LF and CRLF force a break.
/// A lone CR, U+2028, U+2029, VT, FF, and NEL only soft wrap. React writes
/// text nodes directly, so a lone CR lays out as an ordinary character. A body
/// broken only by those is one line to the line window, and the character
/// window holds it. Measure in the renderer before adding another boundary.
///
/// Both windows sit above the 99th-percentile document (4,414 lines and
/// 174,756 characters) in this repository's tracked text, which
/// conflictPane.measure.test.ts measures. A body past either bound shows its
/// first window and a count of what is held back, and `Show more` reaches the
/// rest.
///
/// That corpus holds no line wider than the character window, so it says
/// nothing about the mid-line cut below. The unit tests carry that shape.
export const CONFLICT_PREVIEW_MAX_CHARS = 200_000;
export const CONFLICT_PREVIEW_MAX_LINES = 5_000;

export const CONFLICT_COMBINED_EDIT_MAX_BYTES = 1024 * 1024;

/// The largest document in the measured corpus, in UTF-8 bytes: the healthy
/// maximum the bound above has to clear. Bytes, because that is the unit the
/// bound is enforced in; a 400,000-character CJK document is about 1.2 MiB and
/// this surface refuses it, which `engineTextLimits.test.ts` pins.
///
/// A snapshot, re-read by conflictPane.measure.test.ts, which prints the
/// current corpus every run. When it passes the bound, re-measure both rather
/// than nudging this number.
export const CONFLICT_HEALTHY_DOCUMENT_MAX_BYTES = 496_029;

type ConflictPreview = {
  /// The text the pane paints.
  text: string;
  /// How much the window held back, in UTF-16 code units. Zero means the pane
  /// shows the whole side.
  ///
  /// Code units, not lines and not characters, and both of those are
  /// deliberate. Counting the LINES of what we are not painting would walk the
  /// whole body, which is the cost this bound exists to remove. Counting
  /// characters would too: `.length` counts code units, so a body of astral
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
/// The cut prefers a line boundary but never requires one: a window that could
/// not fit the next whole line fills to the character bound instead, inside
/// that line. Requiring the boundary would stop `Show more` making progress:
/// a six-character line followed by a 1 MiB line would reveal nothing for the
/// first five presses, because the window would keep landing on the same
/// newline.
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

/// What one change to the combined copy does: it is taken, or it is refused
/// for being past the editing bound and the attempted size is reported.
type CombinedChange = { accepted: true; text: string } | { accepted: false; refusedBytes: number };

/// The decision behind every keystroke in the combine textarea.
///
/// Exported as a pure function so the thing that runs per keystroke is one
/// piece of code with one set of tests — and so the browser benchmark in
/// conflictPane.measure.test.ts can drive the shipping decision rather than a
/// copy of it that could quietly disagree.
export function applyCombinedChange(next: string): CombinedChange {
  if (exceedsUtf8Bytes(next, CONFLICT_COMBINED_EDIT_MAX_BYTES)) {
    // One walk of the refused body, paid on a body that cannot be applied.
    return { accepted: false, refusedBytes: utf8ByteLength(next) };
  }
  return { accepted: true, text: next };
}
