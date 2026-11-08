// Whether this window has focus, as main last said. Focus that moves into an
// app's webview leaves the window focused, though this document loses it.
// Until main says, the window counts as unfocused.
let focused = false;

export function initWindowFocus(): void {
  window.dohcDesktop?.onWindowFocused((event) => {
    focused = event.focused;
  });
}

export function windowFocused(): boolean {
  return focused;
}
