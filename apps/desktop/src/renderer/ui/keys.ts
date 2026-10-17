import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Whether a key belongs to an IME composition. Enter, Escape and the arrows
 * then work the candidate list, so a field must not act on them. Some
 * browsers mark those keys only with keyCode 229.
 */
export function isComposingKey(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const key = "nativeEvent" in event ? event.nativeEvent : event;
  return key.isComposing || key.keyCode === 229;
}

/**
 * Whether Enter sends from a message field. Shift+Enter starts a new line,
 * and so does Option+Return on macOS.
 */
export function isSendKey(event: ReactKeyboardEvent, platform = window.dohcDesktop?.platform): boolean {
  return event.key === "Enter" && !event.shiftKey && !(platform === "darwin" && event.altKey) && !isComposingKey(event);
}

/** The key that deletes the selection: Delete, and ⌘⌫ on macOS, as in Finder. */
export function isDeleteKey(event: { key: string; metaKey: boolean }, platform = window.dohcDesktop?.platform): boolean {
  return event.key === "Delete" || (platform === "darwin" && event.metaKey && event.key === "Backspace");
}

/** On macOS, Control with the primary button opens the context menu instead of clicking. */
export function isMacContextClick(event: { button: number; ctrlKey: boolean }, platform = window.dohcDesktop?.platform): boolean {
  return platform === "darwin" && event.button === 0 && event.ctrlKey;
}
