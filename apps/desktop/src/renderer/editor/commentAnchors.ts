import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

type TextIndex = {
  text: string;
  positions: number[];
};

function textIndex(doc: ProseMirrorNode): TextIndex {
  const chars: string[] = [];
  const positions: number[] = [];
  let spaced = true;
  const space = (pos: number) => {
    if (spaced) return;
    chars.push(" ");
    positions.push(pos);
    spaced = true;
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? "";
      for (let at = 0; at < value.length; at += 1) {
        const char = value[at]!;
        if (/\s/.test(char)) space(pos + at);
        else {
          chars.push(char);
          positions.push(pos + at);
          spaced = false;
        }
      }
      return false;
    }
    if (node.isBlock || node.isLeaf) space(-1);
    return true;
  });
  return { text: chars.join(""), positions };
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

export function quoteFinder(doc: ProseMirrorNode) {
  const index = textIndex(doc);
  return (quote: string): { from: number; to: number } | null => {
    const wanted = normalizeQuote(quote);
    if (!wanted) return null;
    const at = index.text.indexOf(wanted);
    return at === -1 ? null : rangeOf(index, at, at + wanted.length);
  };
}

export function findQuote(doc: ProseMirrorNode, quote: string) {
  return quoteFinder(doc)(quote);
}

const MAX_WIDEN_STEPS = 12;

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

const QUOTE_MAX_CHARS = 1_000;

export function quotedCommentBody(quote: string, comment: string): string {
  const text = Array.from(normalizeQuote(quote)).slice(0, QUOTE_MAX_CHARS).join("").trimEnd();
  return `> ${text.replace(/[!-/:-@[-`{-~]/g, "\\$&")}\n\n${comment}`;
}
