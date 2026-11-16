// A scroll to a place in a note whose blocks away from the viewport have only
// estimated heights (styles.css, offscreenBlocks.ts). It imports nothing, so
// the read view can use it without loading the editor.

/** How long a far jump's target stays where it is before the jump lets go of
 * it. What came into view with it, a diagram or an image, draws within this
 * time and moves what is below it. */
const SETTLE_MS = 1500;

/** The far jump that is still keeping its target in place. A later jump ends it. */
let settling: object | null = null;

/**
 * Scrolls `target` into view, to the top of its scroller or, with `nearest`,
 * only as far as it takes to show it. A target within a window's height is
 * laid out with its neighbours, so it moves smoothly when `smooth` is set. A
 * farther one is reached at once. What came near the viewport with it then
 * takes its real height and moves it, so each frame looks where the target's
 * block is and scrolls by as much as it moved, until it has been still.
 *
 * The block is what is followed: the editor draws a find match again as
 * another element, and takes a reveal's flash away, while the jump settles.
 * A scroll that is not this jump's ends it: the person, or another part of
 * the app, took the view elsewhere.
 */
export function scrollToPlace(
  target: HTMLElement,
  smooth: boolean,
  block: "start" | "nearest" = "start",
): void {
  settling = null;
  const { top } = target.getBoundingClientRect();
  const near = top > -window.innerHeight && top < 2 * window.innerHeight;
  if (near) {
    target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block });
    return;
  }
  // The pane to keep scrolling is the ancestor that the jump scrolls.
  const ancestors: Element[] = [];
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    ancestors.push(parent);
  }
  const before = ancestors.map((ancestor) => ancestor.scrollTop);
  target.scrollIntoView({ behavior: "auto", block });
  const pane = ancestors.find((ancestor, index) => ancestor.scrollTop !== before[index]);
  if (!pane) return;
  const jump = {};
  settling = jump;
  const held = target.closest<HTMLElement>(".dohc-notion-editor > *") ?? target;
  let stillSince = performance.now();
  let heldTop = held.getBoundingClientRect().top;
  let paneTop = pane.scrollTop;
  const settle = () => {
    if (settling !== jump) return;
    const moved = held.getBoundingClientRect().top - heldTop;
    const scrolled = pane.scrollTop - paneTop;
    // A scroll moves the block by as much the other way. A scroll the browser
    // makes to keep the view still through a change above it does not.
    const tookElsewhere = Math.abs(scrolled) >= 1 && Math.abs(moved + scrolled) < 1;
    if (!held.isConnected || tookElsewhere) {
      settling = null;
      return;
    }
    // Where it is comes before how long it has been: a frame that waited
    // behind the drawing of a long note still looks.
    if (Math.abs(moved) >= 0.5) {
      pane.scrollTop += moved;
      stillSince = performance.now();
    } else if (performance.now() - stillSince > SETTLE_MS) {
      settling = null;
      return;
    }
    heldTop = held.getBoundingClientRect().top;
    paneTop = pane.scrollTop;
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}
