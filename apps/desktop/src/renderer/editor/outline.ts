// Document outline (table of contents) — a computed view over the doc, not
// a schema addition: headings already exist as nodes, this just walks them.
// Two pure concerns live here: (1) flattening the heading list in doc
// order, and (2) resolving which heading is "active" (the last one at or
// before the reading position). Both are DOM-free.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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
  // A textblock holds only inline content, so the walk never enters one.
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return !node.isTextblock;
    const text = node.textContent.trim();
    if (!text) return false;
    const level =
      typeof node.attrs.level === "number" && Number.isInteger(node.attrs.level)
        ? node.attrs.level
        : 1;
    headings.push({ level, text, pos });
    return false;
  });
  return headings;
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
