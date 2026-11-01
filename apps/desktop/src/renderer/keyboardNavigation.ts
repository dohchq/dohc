// Focus shows only while the person moves with the keyboard. These keys set
// data-keyboard-nav on the root, and styles.css draws focus only inside it.
// The site's demo passes its own root, because it renders in a shadow root.
// A pointer press or any other key clears it, so a click, a shortcut such as
// Ctrl+P, or Enter opening a dialog leaves the focus dohc moves unmarked.
// Escape, Delete and Backspace keep the mark as it was, with or without a
// modifier: they close or remove what has focus, so closing a menu or a tab
// from the keyboard shows where focus went. With an empty set, focus never
// shows.
const NAVIGATION_KEYS = new Set([
  "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "F6",
]);
const UNCHANGED_KEYS = new Set([
  "Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Escape", "Delete", "Backspace",
]);

export const KEYBOARD_NAV_ATTRIBUTE = "data-keyboard-nav";

export function initKeyboardNavigation(root: Element = document.documentElement): () => void {
  const mark = (on: boolean) => {
    // An unchanged write would still restyle every element the rule matches.
    if (root.hasAttribute(KEYBOARD_NAV_ATTRIBUTE) !== on) root.toggleAttribute(KEYBOARD_NAV_ATTRIBUTE, on);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (UNCHANGED_KEYS.has(event.key)) return;
    mark(NAVIGATION_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey);
  };
  const onPointerDown = () => mark(false);
  // Capture on the window runs before any handler can stop the event or
  // move focus.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
  };
}
