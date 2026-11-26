import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// A comment on a passage quotes it. These find a quote in the document and
// pick the quote for a selection. Both read the document's text with every
// run of whitespace, block boundary, or non-text leaf collapsed to one space,
// so a quote matches however its lines wrap.

type TextIndex = {
  text: string;
  // The document position of each character of `text`, or -1 for a space
  // that stands for a block boundary or a leaf.
  positions: number[];
};

function textIndex(doc: ProseMirrorNode): TextIndex {
  let text = "";
  const positions: number[] = [];
  const space = (pos: number) => {
    if (text === "" || text.endsWith(" ")) return;
    text += " ";
    positions.push(pos);
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? "";
      for (let at = 0; at < value.length; at += 1) {
        const char = value[at]!;
        if (/\s/.test(char)) space(pos + at);
        else {
          text += char;
          positions.push(pos + at);
        }
      }
      return false;
    }
    if (node.isBlock || node.isLeaf) space(-1);
    return true;
  });
  return { text, positions };
}

export function normalizeQuote(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

function countOf(text: string, quote: string): number {
  let count = 0;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) count += 1;
  return count;
}

function rangeOf(index: TextIndex, start: number, end: number) {
  return { from: index.positions[start]!, to: index.positions[end - 1]! + 1 };
}

/** Where `quote` reads in the document: its first match, or null. */
export function findQuote(
  doc: ProseMirrorNode,
  quote: string,
): { from: number; to: number } | null {
  const wanted = normalizeQuote(quote);
  if (!wanted) return null;
  const index = textIndex(doc);
  const at = index.text.indexOf(wanted);
  return at === -1 ? null : rangeOf(index, at, at + wanted.length);
}

// Enough words to tell most repeats apart without quoting a paragraph.
const MAX_WIDEN_STEPS = 12;

/** The quote for a selection, and the range it covers. A selection whose text
 *  reads more than once is widened a word at a time on both sides, within its
 *  blocks, until it reads once, so the comment anchors to the passage the
 *  person chose rather than its first repeat. Null when the selection holds no
 *  text. */
export function quoteForSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { quote: string; from: number; to: number } | null {
  const index = textIndex(doc);
  const { text, positions } = index;
  let start = positions.findIndex((pos) => pos >= from);
  let end = positions.length;
  while (end > 0 && !(positions[end - 1]! >= 0 && positions[end - 1]! < to)) end -= 1;
  if (start === -1 || end <= start) return null;
  while (start < end && text[start] === " ") start += 1;
  while (end > start && text[end - 1] === " ") end -= 1;
  if (end <= start) return null;
  for (let step = 0; step < MAX_WIDEN_STEPS; step += 1) {
    if (countOf(text, text.slice(start, end)) <= 1) break;
    const before = start;
    const after = end;
    // One word to the left, then one to the right, never past a block's edge,
    // which reads as a space with no position.
    if (start > 0 && positions[start - 1] !== -1) {
      while (start > 0 && text[start - 1] === " ") start -= 1;
      while (start > 0 && text[start - 1] !== " ") start -= 1;
    }
    if (end < text.length && positions[end] !== -1) {
      while (end < text.length && text[end] === " ") end += 1;
      while (end < text.length && text[end] !== " ") end += 1;
    }
    if (start === before && end === after) break;
  }
  return { quote: text.slice(start, end), ...rangeOf(index, start, end) };
}

// The engine keeps this much of a comment's quote.
const QUOTE_MAX_CHARS = 1_000;

/** A comment's opening message: the quote as one Markdown quote line, then the
 *  words. The quote's punctuation is escaped, so it reads as the passage's
 *  text rather than as Markdown, and an @name in it asks no one. */
export function quotedCommentBody(quote: string, comment: string): string {
  // The engine counts characters, and a cut must not split one.
  const text = Array.from(normalizeQuote(quote)).slice(0, QUOTE_MAX_CHARS).join("").trimEnd();
  return `> ${text.replace(/[!-/:-@[-`{-~]/g, "\\$&")}\n\n${comment}`;
}
