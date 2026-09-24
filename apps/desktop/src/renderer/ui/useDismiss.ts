import { useEffect, useRef, type RefObject } from "react";

// The window's drag regions take presses before the page sees them. While
// any menu is open, the root carries data-menu-open and styles.css turns the
// drag regions off, so a press on the titlebar reaches the page and closes
// the menu. A count keeps the flag while another menu is still open.
let openMenus = 0;
function holdMenuOpen(): () => void {
  openMenus += 1;
  document.documentElement.dataset.menuOpen = "";
  return () => {
    openMenus -= 1;
    if (openMenus === 0) delete document.documentElement.dataset.menuOpen;
  };
}

/**
 * Closes an open menu the ways a person expects: a press outside it, focus
 * moving to something outside it, the window losing focus, and Escape while
 * focus is inside it. Escape returns focus to the trigger.
 *
 * The window check covers what the press check cannot see. A click in an
 * embedded frame, such as an app preview, never reaches this document, but
 * the frame takes focus from the window.
 */
export function useDismiss(options: {
  open: boolean;
  container: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  const { open, container, trigger } = options;
  const onClose = useRef(options.onClose);
  onClose.current = options.onClose;

  useEffect(() => {
    const element = container.current;
    if (!open || !element) return;
    const close = () => onClose.current();
    function onPointerDown(event: PointerEvent) {
      if (element && !element.contains(event.target as Node)) close();
    }
    function onFocusOut(event: FocusEvent) {
      // No next element means focus went to the page, a frame, or another
      // window. The press and window checks decide those.
      const next = event.relatedTarget;
      if (next instanceof Node && element && !element.contains(next)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      trigger.current?.focus();
    }
    const release = holdMenuOpen();
    document.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("focusout", onFocusOut);
    element.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      release();
      document.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("focusout", onFocusOut);
      element.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [open, container, trigger]);
}
