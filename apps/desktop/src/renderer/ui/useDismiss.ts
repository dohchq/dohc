import { useEffect, useRef, type RefObject } from "react";

import { useFocusReturn } from "./focusReturn";

// The window's drag regions take presses before the page sees them. While
// any menu is open, the root carries data-menu-open and styles.css turns the
// drag regions off, so a press on the titlebar reaches the page and closes
// the menu. A count keeps the flag while another menu is still open.
let openMenus = 0;
function holdMenuOpen(root: HTMLElement): () => void {
  openMenus += 1;
  root.dataset.menuOpen = "";
  return () => {
    openMenus -= 1;
    if (openMenus === 0) delete root.dataset.menuOpen;
  };
}

/** Why a menu closed, for an owner that returns focus itself. */
export type DismissReason = "escape" | "press" | "focus" | "blur";

/**
 * Closes an open menu the ways a person expects: a press outside it, focus
 * moving to something outside it, the window losing focus, and Escape while
 * focus is inside it. The trigger counts as inside, so a press on it is the
 * trigger's own click to answer: it closes the menu rather than closing it
 * and opening it again. A press on blank space returns focus to the trigger
 * once it ends. Returns the cleanup.
 *
 * Built on the DOM alone, so a menu another owner builds, such as the
 * editor's table menu, closes by the same rule as the Menu part. Presses are
 * read through composedPath, so a menu inside an embedded editor's shadow
 * root still knows its own presses.
 *
 * The window check covers what the press check cannot see. A click in an
 * embedded frame, such as an app preview, never reaches this document, but
 * the frame takes focus from the window.
 */
export function listenForDismiss(options: {
  menu: HTMLElement;
  trigger: () => HTMLElement | null;
  onClose: (reason: DismissReason) => void;
}): () => void {
  const { menu, trigger, onClose } = options;
  const ownerDocument = menu.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const inside = (node: EventTarget | null) => {
    const anchor = trigger();
    return node === menu || node === anchor ||
      (node instanceof Node && (menu.contains(node) || !!anchor?.contains(node)));
  };
  function onPointerDown(event: PointerEvent) {
    if (event.composedPath().some(inside)) return;
    onClose("press");
    // A press on blank space takes focus to the page, or to the
    // workspace's frame, after the close has returned it. When the press
    // ends there, focus goes back to the trigger, as it does for every
    // other close. A press on a control keeps the focus it gave that control.
    const settle = (end: Event) => {
      ownerDocument.removeEventListener("pointerup", settle, true);
      ownerDocument.removeEventListener("pointercancel", settle, true);
      const active = ownerDocument.activeElement;
      const blank = active === ownerDocument.body || (active instanceof HTMLElement && active.dataset.focusSurface === "workspace");
      if (end.type === "pointerup" && blank) trigger()?.focus();
    };
    ownerDocument.addEventListener("pointerup", settle, true);
    ownerDocument.addEventListener("pointercancel", settle, true);
  }
  function onFocusOut(event: FocusEvent) {
    // No next element means focus went to the page, a frame, or another
    // window. The press and window checks decide those.
    const next = event.relatedTarget;
    if (next instanceof Node && !inside(next)) onClose("focus");
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose("escape");
  }
  const onBlur = () => onClose("blur");
  const release = holdMenuOpen(ownerDocument.documentElement);
  // Taken on the way down, so a press the editor or a control stops still counts.
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  menu.addEventListener("focusout", onFocusOut);
  menu.addEventListener("keydown", onKeyDown);
  ownerWindow?.addEventListener("blur", onBlur);
  return () => {
    release();
    ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
    menu.removeEventListener("focusout", onFocusOut);
    menu.removeEventListener("keydown", onKeyDown);
    ownerWindow?.removeEventListener("blur", onBlur);
  };
}

/**
 * listenForDismiss for a React owner, with focus returned to the trigger on
 * every close that leaves it nowhere else to be.
 */
export function useDismiss(options: {
  open: boolean;
  container: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  const { open, container, trigger } = options;
  useFocusReturn(open, container, () => trigger.current);
  const onClose = useRef(options.onClose);
  onClose.current = options.onClose;

  useEffect(() => {
    const menu = container.current;
    if (!open || !menu) return;
    return listenForDismiss({ menu, trigger: () => trigger.current, onClose: () => onClose.current() });
  }, [open, container, trigger]);
}
