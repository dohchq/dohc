// Document outline (table of contents) — a computed view over the doc, not
// a schema addition: headings already exist as nodes, this just walks them.
// Two pure concerns live here: (1) flattening the heading list in doc
// order, and (2) resolving which heading is "active" (the topmost one
// currently in view). Both are kept DOM-free and duck-typed against
// minimal shapes — same pattern as inlineAtomPlugin.ts/findReplace.ts —
// so they're testable without a real ProseMirror schema.

export type OutlineHeading = {
  /** Heading level, 1-6. */
  level: number;
  /** Trimmed heading text — what the rail/panel display and search for. */
  text: string;
  /** Doc position of the heading node (its start, just before content). */
  pos: number;
};

// Minimal duck-typed shapes covering only what extraction reads off a real
// ProseMirror Node/doc.
export type PMHeadingNodeLike = {
  type: { name: string };
  attrs?: { level?: unknown };
  textContent: string;
};
export type PMOutlineDocLike = {
  descendants: (cb: (node: PMHeadingNodeLike, pos: number) => boolean | void) => void;
};

/** PURE: flatten the doc's heading nodes, in document order. Headings with
 *  no text (an empty "# " line mid-edit) are skipped — they have nothing to
 *  jump to and would just be noise in the rail/panel. */
export function extractOutline(doc: PMOutlineDocLike): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    if (!text) return;
    const level =
      typeof node.attrs?.level === "number" && Number.isInteger(node.attrs.level)
        ? node.attrs.level
        : 1;
    headings.push({ level, text, pos });
  });
  return headings;
}

/** PURE: given the vertical offsets of each heading within the scrollable
 *  content (ascending, in document order) and the current scroll position,
 *  return the index of the "active" section — the last heading whose
 *  offset has scrolled past `scrollTop + readingOffset`. `readingOffset`
 *  nudges the threshold down from the very top of the viewport, so a
 *  heading merely peeking into view at the bottom of the screen doesn't
 *  immediately take over as active.
 *
 *  Returns -1 for an empty list; 0 before the first heading is reached. */
export function resolveActiveHeadingIndex(
  tops: readonly number[],
  scrollTop: number,
  readingOffset = 0,
): number {
  if (tops.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= scrollTop + readingOffset) active = i;
    else break;
  }
  return active;
}
