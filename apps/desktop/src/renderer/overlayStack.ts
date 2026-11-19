// The open full-screen overlays, oldest first. Nested overlays each listen on
// document, and listeners on one node all run for the same event regardless
// of stopPropagation, so each asks whether it is on top before it handles
// Escape or Tab.
//
// A press on any backdrop belongs to the overlay on top, as Escape does. An
// overlay nested in another's panel can have a backdrop no larger than that
// panel, so a press on the outer backdrop must not close the outer dialog.

const escapeStack: symbol[] = [];
const backdropPresses = new Map<symbol, () => void>();
const openListeners = new Set<() => void>();

export function pushOverlay(id: symbol, onBackdropPress: () => void): void {
  escapeStack.push(id);
  backdropPresses.set(id, onBackdropPress);
  announceOverlayOpen();
}

/** Tells listeners a dialog opened. Overlay calls it. A modal dialog drawn
 * without Overlay, such as the page icon picker, calls it when it opens. */
export function announceOverlayOpen(): void {
  for (const listener of [...openListeners]) listener();
}

/** Calls `listener` each time an overlay opens, until the returned stop. */
export function onOverlayOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

export function removeOverlay(id: symbol): void {
  const index = escapeStack.indexOf(id);
  if (index !== -1) escapeStack.splice(index, 1);
  backdropPresses.delete(id);
}

/** Answers a press on a backdrop for the overlay on top. */
export function pressTopBackdrop(): void {
  const top = escapeStack[escapeStack.length - 1];
  if (top) backdropPresses.get(top)?.();
}

/** True while `id` is the overlay a keystroke belongs to. Without this, one
 * Escape closed every open overlay instead of the one on top. */
export function isTopOverlay(id: symbol): boolean {
  return escapeStack[escapeStack.length - 1] === id;
}
