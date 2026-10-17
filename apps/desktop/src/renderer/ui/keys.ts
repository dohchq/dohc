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
