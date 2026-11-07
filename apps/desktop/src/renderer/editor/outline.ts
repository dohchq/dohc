// Document outline (table of contents) — a computed view over the doc, not
// a schema addition: headings already exist as nodes, this just walks them.
// Two pure concerns live here: (1) flattening the heading list in doc
// order, and (2) resolving which heading is "active" (the last one at or
// before the reading position). Both are DOM-free.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { documentChange } from "./pmHelpers";

export type OutlineHeading = {
  /** Heading level, 1-6. */
  level: number;
  /** Trimmed heading text — what the rail/panel display and search for. */
  text: string;
  /** Doc position of the heading node (its start, just before content). */
  pos: number;
};

/** Pure: flatten the doc's heading nodes, in document order. Headings with
 *  no text (an empty "# " line mid-edit) are skipped — they have nothing to
 *  jump to and would just be noise in the rail/panel. */
export function extractOutline(doc: ProseMirrorNode): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.descendants((node, pos) => visitHeading(headings, node, pos));
  return headings;
}

/** Pure: the outline of `doc`, given the outline of `before`. Only headings
 *  that overlap the changed range are read again, so typing in a long note
 *  does not walk all of its blocks. */
export function updateOutline(
  previous: readonly OutlineHeading[],
  before: ProseMirrorNode,
  doc: ProseMirrorNode,
): readonly OutlineHeading[] {
  const { range } = documentChange(before, doc);
  if (!range) return previous;
  const changed = new Set<number>();
  // A textblock holds only inline content, so the walk never enters one.
  before.nodesBetween(range.from, range.toBefore, (node, pos) => {
    if (node.type.name === "heading") changed.add(pos);
    return !node.isTextblock;
  });
  const shift = range.to - range.toBefore;
  const kept = (heading: OutlineHeading) => !changed.has(heading.pos);
  return [
    ...previous.filter((heading) => heading.pos < range.from && kept(heading)),
    ...headingsBetween(doc, range.from, range.to),
    ...previous
      .filter((heading) => heading.pos >= range.toBefore && kept(heading))
      .map((heading) => ({ ...heading, pos: heading.pos + shift })),
  ];
}

function headingsBetween(doc: ProseMirrorNode, from: number, to: number): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.nodesBetween(from, to, (node, pos) => visitHeading(headings, node, pos));
  return headings;
}

// A textblock holds only inline content, so the walk never enters one.
function visitHeading(headings: OutlineHeading[], node: ProseMirrorNode, pos: number): boolean {
  if (node.type.name !== "heading") return !node.isTextblock;
  const text = node.textContent.trim();
  if (!text) return false;
  const level =
    typeof node.attrs.level === "number" && Number.isInteger(node.attrs.level)
      ? node.attrs.level
      : 1;
  headings.push({ level, text, pos });
  return false;
}

/** Pure: given the headings (in document order) and the document position
 *  under the reading line, return the index of the "active" section — the
 *  last heading at or before that position.
 *
 *  Returns -1 for an empty list; 0 before the first heading is reached. */
export function resolveActiveHeadingIndex(
  headings: readonly Pick<OutlineHeading, "pos">[],
  pos: number,
): number {
  if (headings.length === 0) return -1;
  // Upper-bound search: `low` finishes one past the last reached heading.
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (headings[middle]!.pos <= pos) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
