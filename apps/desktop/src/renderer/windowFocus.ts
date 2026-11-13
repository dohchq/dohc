// Whether this window has focus, as main last said. Focus that moves into an
// app's webview leaves the window focused, though this document loses it.
// Until main says, the window counts as unfocused.
let focused = false;
const listeners = new Set<() => void>();

export function initWindowFocus(): void {
  window.dohcDesktop?.onWindowFocused((event) => {
    focused = event.focused;
    for (const listener of listeners) listener();
  });
}

export function windowFocused(): boolean {
  return focused;
}

// Calls `listener` each time main says the window gained or lost focus.
export function watchWindowFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
