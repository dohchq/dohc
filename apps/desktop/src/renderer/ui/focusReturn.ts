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
  useLayoutEffect(() => {
    const tracker = surfaceTracker ??= createSurfaceTracker();
    const registration = { container, target: () => latest.current() };
    tracker.registrations.add(registration);
    if (document.activeElement !== document.body) tracker.remember(document.activeElement);
    return () => {
      tracker.registrations.delete(registration);
      if (tracker.registrations.size === 0) {
        tracker.dispose();
        surfaceTracker = null;
      }
    };
  }, [container]);
}

type SurfaceRegistration = { container: RefObject<HTMLElement | null>; target: FocusTarget };
let surfaceTracker: ReturnType<typeof createSurfaceTracker> | null = null;

function createSurfaceTracker() {
  const registrations = new Set<SurfaceRegistration>();
  let remembered: {
    element: HTMLElement;
    surfaces: HTMLElement[];
    owners: { registration: SurfaceRegistration; element: HTMLElement }[];
  } | null = null;
  let pointerDown = false;
  let blurredByPointer = false;
  let completion: ReturnType<typeof setTimeout> | undefined;
  const forget = () => {
    remembered = null;
    blurredByPointer = false;
    observer.disconnect();
  };
  const restoreRemovedFocus = () => {
    const memory = remembered;
    if (!memory) return;
    if (memory.element.isConnected) {
      if (!blurredByPointer && document.hasFocus() && document.activeElement === document.body) {
        memory.element.focus({ preventScroll: true });
      }
      return;
    }
    observer.disconnect();
    queueMicrotask(() => {
      if (remembered !== memory) return;
      forget();
      if (document.activeElement !== document.body) return;
      const owner = memory.owners.find(({ registration, element }) =>
        registrations.has(registration) && registration.container.current === element && element.isConnected);
      if (owner) {
        focusSurface(owner.registration.target(), ...memory.surfaces,
          owner.element.dataset.focusSurface === "workspace" ? null : owner.element);
      }
    });
  };
  const observer = new MutationObserver(restoreRemovedFocus);
  const remember = (active: Element | null) => {
    forget();
    if (!(active instanceof HTMLElement) || active === document.body) return;
    const owners: NonNullable<typeof remembered>["owners"] = [];
    for (let element: HTMLElement | null = active; element; element = element.parentElement) {
      for (const registration of registrations) {
        if (registration.container.current === element) owners.push({ registration, element });
      }
    }
    if (owners.length === 0) return;
    remembered = { element: active, surfaces: ancestors(active), owners };
    // Watch removal of the focused node or an ancestor, never edits inside it.
    for (let parent = active.parentNode; parent; parent = parent.parentNode) {
      observer.observe(parent, { childList: true });
    }
  };
  const onFocusIn = (event: FocusEvent) => remember(event.target instanceof Element ? event.target : null);
  const onFocusOut = (event: FocusEvent) => {
    if (event.target !== remembered?.element || !remembered.element.isConnected || document.activeElement === event.target) return;
    if (event.relatedTarget === null && pointerDown) blurredByPointer = true;
    else forget();
  };
  const finishPointer = () => {
    pointerDown = false;
    clearTimeout(completion);
    if (!blurredByPointer) return;
    // Click handlers can remove the blurred item. A blank-space click must forget it.
    completion = setTimeout(() => {
      if (!blurredByPointer) return;
      if (remembered?.element.isConnected) forget();
      else restoreRemovedFocus();
    }, 0);
  };
  const onPointerDown = () => {
    clearTimeout(completion);
    if (blurredByPointer) forget();
    pointerDown = true;
  };
  const onWindowBlur = () => {
    forget();
    pointerDown = false;
    clearTimeout(completion);
  };
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", finishPointer, true);
  document.addEventListener("pointercancel", finishPointer, true);
  document.addEventListener("click", finishPointer, true);
  return {
    registrations,
    remember,
    dispose() {
      forget();
      clearTimeout(completion);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", finishPointer, true);
      document.removeEventListener("pointercancel", finishPointer, true);
      document.removeEventListener("click", finishPointer, true);
    },
  };
}
