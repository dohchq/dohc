import { flushSync } from "react-dom";

// A click on a tab moves focus first, so a field that saves when left, such
// as a list property, saves and renders before its tab goes. A shortcut
// leaves focus in the field, and removing a focused field fires no blur. So
// it leaves the field and renders that save before the tab changes; in one
// render with the switch, the editor would unmount over its older body.
export function leaveEditorField(): void {
  const field = document.activeElement;
  if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
    && field.closest('[data-testid="file-inspector"]')) {
    flushSync(() => field.blur());
  }
}
