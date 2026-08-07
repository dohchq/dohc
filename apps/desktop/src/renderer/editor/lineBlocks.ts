// Search names a Markdown LINE. The editor addresses doc POSITIONS, and
// nothing survives the Markdown parse to carry one onto the other, so the
// mapping is rebuilt here from the same Markdown the line was numbered
// against: which top-level block holds that line?
//
// The answer is APPROXIMATE by construction. Blocks are split on blank lines,
// with three exceptions that cover how documents are actually written:
//
//  - Some blocks END at their own last line, not at a blank one: a heading
//    (an ATX line, or the setext underline under a paragraph), a thematic
//    break, and a fenced code block at its closing fence.
//  - Some blocks START without a blank line above them, interrupting what is
//    open: a heading, a fence, a thematic break, and — under a PARAGRAPH or a
//    TABLE only — a quote, a list or a table. An ordered list interrupts only
//    when it counts from 1, because `2.` under a paragraph is that
//    paragraph's own text. A heading indented into a list item is that item's
//    heading, not a new block.
//  - Some blocks RUN THROUGH a blank line, because the next line continues
//    them: another item of the SAME list (a changed marker is a new list),
//    content indented into that item, and the next chunk of an indented code
//    block. A quoted blank ends a quote's lazy continuation the same way,
//    without ending the quote.
//  - A fence's contents are inert, and so are a `$$…$$` block's. Blank lines
//    and `#` inside either are that block's own text.
//  - A link reference definition renders NO node, so it starts no block. A
//    hit on one lands on the block above it, as any other gap does — there is
//    nothing of its own to show the reader.
//
// That is the top-level shape of an ordinary document, not of every document
// CommonMark can express — a jump can land a block off. It still shows the
// reader the passage they searched for; the top of the document shows them
// nothing.
//
// A quote is NOT in that exception. CommonMark ends a block quote at an
// unquoted blank line, so `> one\n\n> two` is two nodes where
// `- one\n\n- two` is one loose list. Both rules are checked against the real
// parse in lineBlocks.test.ts rather than reasoned about here.
//
// Not renderer/markdown/splitMarkdownBlocks.ts, which answers a different
// question: it packs many blocks into ~4KB chunks for incremental rendering
// and keeps no line numbers, so it cannot say which block holds a line. Its
// segmenting is also looser — every blank line outside a fence ends a segment,
// which is safe when each chunk is re-parsed as Markdown and wrong when the
// count has to match the editor's top-level nodes.
//
// DOM-free and duck-typed against plain text, same as outline.ts/findReplace.ts.

type BlockKind =
  | "bullet"
  | "ordered"
  | "quote"
  | "heading"
  | "code"
  | "break"
  | "table"
  | "other";

const HEADING_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
// The captured marker is the list's identity: changing it starts a NEW list.
const BULLET_RE = /^[ \t]{0,3}([-+*])(?:[ \t]|$)/;
const ORDERED_RE = /^[ \t]{0,3}\d{1,9}([.)])(?:[ \t]|$)/;
const QUOTE_RE = /^[ \t]{0,3}>/;
// A `>`-only line ends the quote's LAZY continuation without ending the quote.
const QUOTED_BLANK_RE = /^[ \t]{0,3}>[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
// A run of `=` or `-` under a paragraph is that paragraph's setext underline.
const SETEXT_RE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/;
// Content indented into the list item above it. Two columns is where the
// parser starts reading a line that way, tab or spaces.
const CONTINUATION_RE = /^(?:\t| {2})/;
// Four columns with nothing open above is an INDENTED code block, which runs
// through its own blank lines and ends where the indentation stops.
const INDENTED_CODE_RE = /^(?:\t| {4})/;
// Three or more of one marker, spaces allowed between them and nothing else.
// Two is a paragraph. `---` under an open paragraph is a setext underline
// instead, which SETEXT_RE claims first.
const BREAK_RE = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
// A list can interrupt a paragraph, but an ORDERED one only when it counts
// from 1: `2.` under a paragraph is that paragraph's own text.
const INTERRUPTING_ORDERED_RE = /^[ \t]{0,3}1[.)](?:[ \t]|$)/;
// `[label]: destination "title"` renders NO node — it is metadata the links
// resolve through (editor/extensions.ts leaves it to the tokenizer). A label
// and a destination are both required; four columns makes it code instead.
const DEFINITION_RE = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S/;
// A definition's title may sit alone on the next line, indented.
const DEFINITION_TITLE_RE = /^[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/;
// A table's DELIMITER row is what tells its header row apart from an ordinary
// paragraph, so the header is only a header when this follows it. Leading and
// trailing pipes are both optional; a pipe somewhere is not, or `---` alone
// would read as a one-column table instead of a break.
const TABLE_DELIMITER_RE =
  /^[ \t]{0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function opensTable(next: string): boolean {
  return next.includes("|") && TABLE_DELIMITER_RE.test(next);
}

type Fence = { marker: string; length: number };

/** The line index where a standalone `$$…$$` block ends, or null when the
 *  line does not open one. `editor/extensions.ts` anchors the opener at
 *  column 0 and needs the FIRST `$$` after it to end a line — anything else
 *  is literal text, so an unclosed `$$` is not math and claims nothing. */
function mathBlockEnd(lines: string[], start: number): number | null {
  if (!(lines[start] ?? "").startsWith("$$")) return null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const closing = line.indexOf("$$", index === start ? 2 : 0);
    if (closing === -1) continue;
    return closing + 2 === line.length ? index : null;
  }
  return null;
}

function listMarker(text: string): string {
  return (BULLET_RE.exec(text)?.[1] ?? ORDERED_RE.exec(text)?.[1]) ?? "";
}

function blockKind(text: string): BlockKind {
  if (HEADING_RE.test(text)) return "heading";
  // Before the bullet: `- - -` is a break, not a one-item list.
  if (BREAK_RE.test(text)) return "break";
  if (BULLET_RE.test(text)) return "bullet";
  if (ORDERED_RE.test(text)) return "ordered";
  if (QUOTE_RE.test(text)) return "quote";
  if (INDENTED_CODE_RE.test(text)) return "code";
  return "other";
}

function fenceOpener(text: string): Fence | null {
  const match = FENCE_RE.exec(text);
  if (!match?.[1]) return null;
  const marker = match[1][0]!;
  // CommonMark forbids a backtick anywhere in a backtick fence's info string.
  if (marker === "`" && (match[2] ?? "").includes("`")) return null;
  return { marker, length: match[1].length };
}

function closesFence(text: string, fence: Fence): boolean {
  const match = FENCE_RE.exec(text);
  return (
    !!match?.[1] &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length &&
    /^[ \t]*$/.test(match[2] ?? "")
  );
}

/** 1-based line numbers where each top-level block begins, in document order. */
function blockStartLines(body: string): number[] {
  const lines = body.split(/\r?\n/);
  const starts: number[] = [];
  let open = false;
  let openKind: BlockKind = "other";
  let openMarker = "";
  let quoteOpen = false;
  let fence: Fence | null = null;
  let mathUntil: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (mathUntil !== null) {
      // One atomic node, blank lines and all, ending at its closing `$$`.
      if (index >= mathUntil) {
        mathUntil = null;
        open = false;
      }
      continue;
    }
    if (fence) {
      // A fenced block ends AT its closing fence, the way a heading ends at
      // its own line: the next line opens its own block, blank line or not.
      if (closesFence(text, fence)) {
        fence = null;
        open = false;
      }
      continue;
    }
    if (text.trim() === "") {
      open = false;
      quoteOpen = false;
      continue;
    }
    // A setext underline makes the OPEN paragraph a heading and ends it — the
    // same one-line shape an ATX heading has, so `Title\n===\nBody` is two
    // nodes. Read before the kinds below, because a lone `-` is also a bullet.
    if (open && openKind === "other" && SETEXT_RE.test(text)) {
      open = false;
      continue;
    }
    // A quoted blank ends the quote's lazy continuation: the next unquoted
    // line is a new block, while the next `>` line is still this one.
    if (openKind === "quote" && QUOTED_BLANK_RE.test(text)) {
      open = false;
      quoteOpen = true;
      continue;
    }
    // A definition renders nothing, so it starts no block. Under an OPEN
    // paragraph it is not a definition at all, just that paragraph's text.
    if (!open && DEFINITION_RE.test(text)) {
      if (DEFINITION_TITLE_RE.test(lines[index + 1] ?? "")) index += 1;
      continue;
    }
    const kind = opensTable(lines[index + 1] ?? "") ? "table" : blockKind(text);
    const marker = listMarker(text);
    const listOpen = openKind === "bullet" || openKind === "ordered";
    const opener = fenceOpener(text);
    const mathClose = mathBlockEnd(lines, index);
    // A blank line does not end a block the next line continues: another item
    // of the same list, content indented into that item, or the next chunk of
    // an indented code block. A fence indented into a list item is one of
    // those continuations, which is why this is read before the starts below.
    const resumes =
      (listOpen &&
        ((kind === openKind && marker === openMarker) ||
          CONTINUATION_RE.test(text))) ||
      (openKind === "code" && kind === "code") ||
      (quoteOpen && kind === "quote");
    // Indented code ends where the indentation stops, blank line or not — the
    // same "ends at its own last line" shape a heading and a fence have. It
    // cannot START under an open paragraph: there an indented line is that
    // paragraph's lazy continuation, not code.
    const leavesCode = openKind === "code" && kind !== "code";
    // A table ROW is not paragraph text, so an indented line under one is a
    // code block rather than that paragraph's lazy continuation.
    const leavesTable = openKind === "table" && kind === "code";
    // Blocks that do not wait for a blank line to start. A list, a quote or a
    // table interrupts a PARAGRAPH (or a table) only — under an open list or
    // quote the same line is that block's own next line, not a new one.
    const interrupts =
      !!opener ||
      mathClose !== null ||
      kind === "break" ||
      leavesCode ||
      leavesTable ||
      (open &&
        (openKind === "other" || openKind === "table") &&
        (kind === "bullet" ||
          kind === "quote" ||
          kind === "table" ||
          (kind === "ordered" && INTERRUPTING_ORDERED_RE.test(text)))) ||
      // A bullet whose marker changes starts a new list on the spot.
      (open && openKind === "bullet" && kind === "bullet" && marker !== openMarker);
    // A heading opens a block wherever one can open — but indented into a
    // list item it is that item's own heading, which is what `resumes` says.
    if ((kind === "heading" || interrupts || !open) && !resumes) {
      starts.push(index + 1);
      openKind = kind;
      openMarker = marker;
      quoteOpen = false;
    }
    // An ATX heading and a thematic break are one line each. The next line
    // opens its own block, blank line or not — `# Plan\nBody` is two nodes.
    open = kind !== "heading" && kind !== "break";
    fence = opener;
    // A `$$…$$` block spanning lines swallows them; a one-line one ends here.
    if (mathClose !== null) {
      if (mathClose > index) mathUntil = mathClose;
      else open = false;
    }
  }
  return starts;
}

/** PURE: the index of the top-level block holding 1-based `line` of `body`.
 *  A line in the gap between blocks resolves to the block above it; a line
 *  past the end resolves to the last block. Returns 0 for an empty body. */
export function blockIndexForLine(body: string, line: number): number {
  const starts = blockStartLines(body);
  let index = 0;
  for (let candidate = 0; candidate < starts.length; candidate += 1) {
    if (starts[candidate]! <= line) index = candidate;
    else break;
  }
  return index;
}
