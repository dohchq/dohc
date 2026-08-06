// Search names a Markdown LINE. The editor addresses doc POSITIONS, and
// nothing survives the Markdown parse to carry one onto the other, so the
// mapping is rebuilt here from the same Markdown the line was numbered
// against: which top-level block holds that line?
//
// The answer is APPROXIMATE by construction. Blocks are split on blank lines,
// with three exceptions that cover how documents are actually written: fenced
// code is inert, a heading always opens a block, and a blank line does not end
// a LIST the next line continues. That is the top-level shape of an ordinary
// document, not of every document CommonMark can express — a jump can land a
// block off. It still shows the reader the passage they searched for; the top
// of the document shows them nothing.
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

type BlockKind = "bullet" | "ordered" | "quote" | "heading" | "other";

const HEADING_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const BULLET_RE = /^[ \t]{0,3}[-+*](?:[ \t]|$)/;
const ORDERED_RE = /^[ \t]{0,3}\d{1,9}[.)](?:[ \t]|$)/;
const QUOTE_RE = /^[ \t]{0,3}>/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

type Fence = { marker: string; length: number };

function blockKind(text: string): BlockKind {
  if (HEADING_RE.test(text)) return "heading";
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
  let fence: Fence | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (fence) {
      if (closesFence(text, fence)) fence = null;
      continue;
    }
    if (text.trim() === "") {
      open = false;
      continue;
    }
    const kind = blockKind(text);
    const list = kind === "bullet" || kind === "ordered";
    const resumes = list && kind === openKind && starts.length > 0;
    if (kind === "heading" || (!open && !resumes)) {
      starts.push(index + 1);
      openKind = kind;
    }
    // An ATX heading is one line. The next line opens its own block, blank
    // line or not — `# Plan\nBody` is two nodes, not one.
    open = kind !== "heading";
    // An indented fence inside a list item must not split that item, so a
    // fence is only tracked here — opening a block is the branch above.
    fence = fenceOpener(text);
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
