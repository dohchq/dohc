// The open full-screen overlays, oldest first. Nested overlays each listen on
// document, and listeners on one node all run for the same event regardless
// of stopPropagation, so each asks whether it is on top before it handles
// Escape or Tab.

const escapeStack: symbol[] = [];
const openListeners = new Set<() => void>();

export function pushOverlay(id: symbol): void {
  escapeStack.push(id);
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
}

/** True while `id` is the overlay a keystroke belongs to. Without this, one
 * Escape closed every open overlay instead of the one on top. */
export function isTopOverlay(id: symbol): boolean {
  return escapeStack[escapeStack.length - 1] === id;
}
