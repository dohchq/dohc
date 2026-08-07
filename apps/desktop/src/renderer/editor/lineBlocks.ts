// Search names a Markdown LINE. The editor addresses doc POSITIONS, and
// nothing survives the Markdown parse to carry one onto the other, so the
// mapping is rebuilt here from the same Markdown the line was numbered
// against: which top-level block holds that line?
//
// The answer is APPROXIMATE by construction. Blocks are split on blank lines,
// with the exceptions that cover how documents are actually written. Every one
// of them was MEASURED against the real parse in lineBlocks.test.ts, not read
// off CommonMark — several of these blocks are this editor's own, and the
// tokenizer disagrees with the spec in places (see the ordered lists below).
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
//    them: another item of the SAME list, content indented to that item's own
//    content column, and the next chunk of an indented code block. A list's
//    identity is its marker AND its kind, so either one changing starts a new
//    list — except under a `.`-ordered list, which absorbs whatever list line
//    follows it and takes a continuation at any indent. That leniency is the
//    tokenizer's, measured; `1)` behaves like a bullet instead.
//  - A quote absorbs an UNQUOTED line as a lazy continuation until something
//    inside it ends that: a quoted blank or a quoted fence for any quote, and
//    for a callout every quoted block start. The quote itself survives — the
//    next `>` line is still the same node.
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
// Indentation is counted in COLUMNS, with a tab reaching the next multiple of
// four. That is what decides an indented code block and a list continuation,
// and it is why the kinds are read after it: `\t# H` is four columns deep, so
// it is code, whatever the `#` looks like.
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
// The quote's `>` prefix, which the tokenizer strips before reading the line
// underneath it. A callout announces itself on that first stripped line.
const QUOTE_PREFIX_RE = /^[ \t]{0,3}>[ \t]?/;
// A COMPLETE callout header, mirroring extensions.ts CALLOUT_HEADER_RE. An
// unclosed `> [!oops` is an ordinary blockquote, which continues lazily where
// a callout would not.
const CALLOUT_RE = /^\[![^\]\n]+\]/;
// Raw HTML, which is a block start to the callout tokenizer but not a kind
// this module otherwise needs (extensions.ts CALLOUT_LAZY_BREAK_RE).
const HTML_BLOCK_RE = /^[ \t]{0,3}<[a-zA-Z!/]/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
// A run of `=` or `-` under a paragraph is that paragraph's setext underline.
const SETEXT_RE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/;
// Where a list item's own content begins, which is the column a continuation
// line has to reach. It is the ACTIVE item's marker plus the spaces after it,
// so `-    item` wants five columns where `- item` wants two.
const LIST_MARKER_RE = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])/;
// Four COLUMNS with nothing open above is an INDENTED code block, which runs
// through its own blank lines and ends where the indentation stops. Columns,
// not characters: `   \t` reaches four the same as `    ` does.
const CODE_COLUMNS = 4;
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

/** The column reached after `end` characters of `text`, counting a tab as the
 *  jump to the next multiple of four the way the tokenizer does. */
function columnAt(text: string, end: number): number {
  let column = 0;
  for (let index = 0; index < end; index += 1) {
    column = text[index] === "\t" ? column + 4 - (column % 4) : column + 1;
  }
  return column;
}

function leadingColumns(text: string): number {
  const spaces = /^[ \t]*/.exec(text)?.[0] ?? "";
  return columnAt(text, spaces.length);
}

/** The column a continuation line must reach to stay inside this list item.
 *  Measured against the tokenizer rather than derived: a bullet or a
 *  `)`-ordered item wants its content column, while a `.`-ordered item takes
 *  any indent at all. */
function continuationIndent(text: string): number {
  const match = LIST_MARKER_RE.exec(text);
  if (!match) return 1;
  if (listMarker(text) === ".") return 1;
  const spaces = /^[ \t]*/.exec(text.slice(match[0].length))?.[0] ?? "";
  return columnAt(text, match[0].length + spaces.length);
}

function blockKind(text: string): BlockKind {
  // First: four columns of indent makes every marker below it literal code.
  // The patterns count a tab as one CHARACTER, so `\t# H` would read as a
  // heading where the parser reads four columns and calls it code.
  if (leadingColumns(text) >= CODE_COLUMNS) return "code";
  if (HEADING_RE.test(text)) return "heading";
  // Before the bullet: `- - -` is a break, not a one-item list.
  if (BREAK_RE.test(text)) return "break";
  if (BULLET_RE.test(text)) return "bullet";
  if (ORDERED_RE.test(text)) return "ordered";
  if (QUOTE_RE.test(text)) return "quote";
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
  let openIndent = 1;
  let quoteOpen = false;
  let quoteCallout = false;
  let quoteFence: Fence | null = null;
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
    // A quoted line either keeps the quote's LAZY continuation alive or ends
    // it — and once it ends, an unquoted line is a new block while another
    // `>` line is still this one. What ends it was measured, not assumed: a
    // quoted blank or a quoted fence for any quote, and for a CALLOUT every
    // quoted block start (extensions.ts closes the continuable paragraph
    // there). A plain quote absorbs those, which is why it needs the flag.
    if (openKind === "quote" && (open || quoteOpen) && QUOTE_RE.test(text)) {
      const inner = text.replace(QUOTE_PREFIX_RE, "");
      if (quoteFence) {
        if (closesFence(inner, quoteFence)) quoteFence = null;
        open = false;
      } else {
        quoteFence = fenceOpener(inner);
        const innerKind = blockKind(inner);
        open = !(
          quoteFence !== null ||
          inner.trim() === "" ||
          (quoteCallout &&
            (innerKind === "quote" ||
              innerKind === "heading" ||
              innerKind === "bullet" ||
              innerKind === "ordered" ||
              innerKind === "break" ||
              HTML_BLOCK_RE.test(inner)))
        );
      }
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
    const indent = leadingColumns(text);
    const resumes =
      (listOpen &&
        ((kind === openKind && marker === openMarker) || indent >= openIndent)) ||
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
      // Adjacent lists with no blank line between them. A changed marker or a
      // changed kind starts a new list — unless the open one is `.`-ordered,
      // which absorbs whatever list line follows it, the same leniency that
      // gives it a one-column continuation indent.
      (open &&
        listOpen &&
        openMarker !== "." &&
        (kind === "bullet" || kind === "ordered") &&
        (kind !== openKind || marker !== openMarker)) ||
      // Indented, but not far enough to reach the open item's content. Column
      // zero would be a lazy continuation of it; this is neither.
      (open && listOpen && indent > 0 && indent < openIndent);
    // A heading opens a block wherever one can open — but indented into a
    // list item it is that item's own heading, which is what `resumes` says.
    const opens = (kind === "heading" || interrupts || !open) && !resumes;
    if (opens) {
      starts.push(index + 1);
      openKind = kind;
      openMarker = marker;
      quoteOpen = false;
      quoteCallout =
        kind === "quote" && CALLOUT_RE.test(text.replace(QUOTE_PREFIX_RE, ""));
      quoteFence = null;
    }
    // The ACTIVE item sets the continuation column, so a later item with a
    // wider marker moves it. Only a real item does — content merely indented
    // into this one keeps the column it has.
    if (
      (kind === "bullet" || kind === "ordered") &&
      (opens || (listOpen && kind === openKind && marker === openMarker))
    ) {
      openIndent = continuationIndent(text);
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
