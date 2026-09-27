import { useLayoutEffect, useRef, type RefObject } from "react";

type FocusTarget = () => HTMLElement | null | undefined;

export function focusSurface(...targets: (HTMLElement | null | undefined)[]): void {
  const modals = document.querySelectorAll<HTMLElement>("[data-dohc-modal='true'] > div");
  const modal = modals[modals.length - 1];
  for (const target of [
    ...targets,
    modal,
    document.querySelector<HTMLElement>('[data-focus-surface="editor"][data-active="true"]'),
    document.querySelector<HTMLElement>('[data-focus-surface="workspace"]'),
  ]) {
    if (!target?.isConnected || target === document.body ||
      target.closest('[hidden], [inert], [aria-hidden="true"]') || target.matches(":disabled")) continue;
    const style = getComputedStyle(target);
    if (style.display === "none" || style.visibility === "hidden") continue;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
}

/** Capture before children autofocus; resolve surviving surfaces after the commit. */
export function useFocusReturn(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  target?: FocusTarget,
): void {
  const captured = useRef<HTMLElement[]>([]);
  const wasOpen = useRef(false);
  const latestTarget = useRef(target);
  latestTarget.current = target;
  if (open && !wasOpen.current) {
    const active = document.activeElement;
    captured.current = active instanceof HTMLElement && active !== document.body
      ? [active, ...ancestors(active)] : [];
  }
  wasOpen.current = open;
  const generation = useRef(0);
  useLayoutEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    const closing = container.current;
    const targets = captured.current;
    return () => {
      queueMicrotask(() => {
        // Reopening (including StrictMode's effect replay) cancels the return.
        if (generation.current !== current) return;
        const active = document.activeElement;
        if (active !== document.body && active !== null && !closing?.contains(active)) return;
        focusSurface(latestTarget.current?.(), ...targets);
      });
    };
  }, [open, container]);
}

function ancestors(element: HTMLElement): HTMLElement[] {
  const surfaces: HTMLElement[] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.hasAttribute("data-focus-surface") && parent.dataset.focusSurface !== "workspace") surfaces.push(parent);
  }
  return surfaces;
}

/** Keep a surface usable when a focused child is replaced or removed. */
export function useFocusSurface(
  container: RefObject<HTMLElement | null>,
  target: FocusTarget,
): void {
  const latest = useRef(target);
  latest.current = target;
  const focused = useRef<HTMLElement | null>(null);
  const surfaces = useRef<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const restoreRemovedFocus = () => {
      if (!focused.current || focused.current.isConnected || document.activeElement !== document.body) return;
      focused.current = null;
      const nearest = surfaces.current;
      queueMicrotask(() => {
        if (element.isConnected && document.activeElement === document.body) {
          focusSurface(latest.current(), ...nearest, element.dataset.focusSurface === "workspace" ? null : element);
        }
      });
    };
    const remember = (event: FocusEvent) => {
      focused.current = event.target instanceof HTMLElement ? event.target : null;
      surfaces.current = focused.current ? ancestors(focused.current) : [];
    };
    const forget = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.isConnected && document.activeElement !== event.target) {
        focused.current = null;
        surfaces.current = [];
      }
    };
    // Descendants can remove focus without rendering the surface's owner.
    const observer = new MutationObserver(restoreRemovedFocus);
    observer.observe(element, { childList: true, subtree: true });
    restoreRemovedFocus();
    element.addEventListener("focusin", remember);
    element.addEventListener("focusout", forget);
    return () => {
      observer.disconnect();
      element.removeEventListener("focusin", remember);
      element.removeEventListener("focusout", forget);
    };
  });
}
