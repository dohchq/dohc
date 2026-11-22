// Focus shows only while the person moves with the keyboard. These keys set
// data-keyboard-nav on the root, and styles.css draws focus only inside it.
// The site's demo passes its own root, because it renders in a shadow root.
// A pointer press or any other key clears it, so a click, a shortcut such as
// Ctrl+P, or Enter opening a dialog leaves the focus dohc moves unmarked.
// A confirm dialog's buttons are the exception: they show the ring whenever
// Chromium's :focus-visible matches, so a dialog opened from the keyboard
// shows where Enter acts (ui/ConfirmDialog.tsx).
// Escape, Delete and Backspace keep the mark as it was, with or without a
// modifier: they close or remove what has focus, so closing a menu or a tab
// from the keyboard shows where focus went. Escape also brings back a mark
// that Enter or Space took away, so closing a dialog opened from a marked
// control shows that control's ring again. With an empty set, focus never
// shows. A step pressed with Enter that moves focus once it finishes, such as
// a Notices row's step, brings the mark back through resumeKeyboardMark.
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F6",
]);
const UNCHANGED_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Escape",
  "Delete",
  "Backspace",
]);

export const KEYBOARD_NAV_ATTRIBUTE = "data-keyboard-nav";

let resumeMark: (() => void) | null = null;

/** Brings back the mark Enter or Space took away, unless a pointer or another key came since. */
export function resumeKeyboardMark(): void {
  resumeMark?.();
}

export function initKeyboardNavigation(root: Element = document.documentElement): () => void {
  const mark = (on: boolean) => {
    // An unchanged write would still restyle every element the rule matches.
    if (root.hasAttribute(KEYBOARD_NAV_ATTRIBUTE) !== on)
      root.toggleAttribute(KEYBOARD_NAV_ATTRIBUTE, on);
  };
  // Enter or Space took the mark away, and Escape may bring it back.
  let restore = false;
  const resume = () => {
    if (!restore) return;
    restore = false;
    mark(true);
  };
  resumeMark = resume;
  const onKeyDown = (event: KeyboardEvent) => {
    if (UNCHANGED_KEYS.has(event.key)) {
      if (event.key === "Escape") resume();
      return;
    }
    const navigating =
      NAVIGATION_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey;
    restore =
      !navigating &&
      (event.key === "Enter" || event.key === " ") &&
      (restore || root.hasAttribute(KEYBOARD_NAV_ATTRIBUTE));
    mark(navigating);
  };
  const onPointerDown = () => {
    restore = false;
    mark(false);
  };
  // Capture on the window runs before any handler can stop the event or
  // move focus.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    if (resumeMark === resume) resumeMark = null;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
  };
}
