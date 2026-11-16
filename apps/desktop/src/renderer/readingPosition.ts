// Where a person is in a note, as the block at the top of the pane and how far
// into it the pane's top edge is. A scroll offset in pixels does not carry
// from the read view to the editor: a block away from the viewport has only
// an estimated height (styles.css), and the two estimate different blocks.

export type ReadingPosition = { block: number; into: number };

/**
 * The top-level blocks under `root`, in document order. The read view draws a
 * code block's toolbar as an element before it, and the editor draws that
 * toolbar and its other controls as widgets, so both views count the same
 * blocks.
 */
export function noteBlocks(root: Element | null): Element[] {
  if (!root) return [];
  return Array.from(root.children).filter(
    (child) =>
      !child.classList.contains("ProseMirror-widget") &&
      !child.classList.contains("dohc-code-block-toolbar"),
  );
}

/** The position `pane` shows, or null when no block reaches below its top. */
export function readingPosition(pane: Element, blocks: readonly Element[]): ReadingPosition | null {
  const top = pane.getBoundingClientRect().top;
  // Blocks are in order down the page: find the first that ends below the top.
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  const block = blocks[low];
  return block ? { block: low, into: top - block.getBoundingClientRect().top } : null;
}

/** Scrolls `pane` to `position`. False when its block is not drawn yet. */
export function showReadingPosition(
  pane: Element,
  blocks: readonly Element[],
  position: ReadingPosition,
): boolean {
  const block = blocks[position.block];
  if (!block) return false;
  const off = block.getBoundingClientRect().top + position.into - pane.getBoundingClientRect().top;
  if (Math.abs(off) >= 0.5) pane.scrollTop += off;
  return true;
}
