import { useEffect, useSyncExternalStore } from "react";

// A plugin web app's guest is a main-process view layered over the shell, so
// it composites above everything this renderer paints. Any UI that lands in
// the guest's rectangle looks clickable and is not: the guest takes the click.
// Only main can hide the guest, and this is what tells the shell to ask.
//
// One registry, because the shell cannot see every overlay. Some belong to
// components it renders — the history diff's restore confirm keeps its own
// state — so a hand-maintained list of the shell's own flags misses them by
// construction and grows a hole every time somebody adds a dialog. The UI
// registers itself instead.

const escapeStack: symbol[] = [];
const blockers = new Set<symbol>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Registers a full-screen overlay: it blocks the guest AND owns Escape while
 * it is the topmost one. Overlay calls this; nothing else should. */
export function pushOverlay(id: symbol): void {
  escapeStack.push(id);
  blockers.add(id);
  publish();
}

export function removeOverlay(id: symbol): void {
  const index = escapeStack.indexOf(id);
  if (index !== -1) escapeStack.splice(index, 1);
  blockers.delete(id);
  publish();
}

/** True while `id` is the overlay a keystroke belongs to. Nested overlays each
 * listen on document, and listeners on one node all run for the same event
 * regardless of stopPropagation — without this, one Escape closed every open
 * overlay instead of the one on top (#779 round 4 finding 4). */
export function isTopOverlay(id: symbol): boolean {
  return escapeStack[escapeStack.length - 1] === id;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function anyBlocker(): boolean {
  return blockers.size > 0;
}

/** True while any registered UI would lose its clicks to a guest. The shell
 * hands this to every open web app page. */
export function useGuestBlockingUi(): boolean {
  return useSyncExternalStore(subscribe, anyBlocker, anyBlocker);
}

/**
 * Registers UI that is not a full-screen overlay but still must receive its
 * clicks — a floating panel that can land over the guest. It takes no part in
 * Escape handling, so it never steals a keystroke from an open overlay.
 */
export function useGuestBlockingUiWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const id = Symbol("guest-blocking-ui");
    blockers.add(id);
    publish();
    return () => {
      blockers.delete(id);
      publish();
    };
  }, [active]);
}
