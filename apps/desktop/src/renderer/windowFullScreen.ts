import { useSyncExternalStore } from "react";

// Main sends the state once the document is parsed, so main.tsx subscribes
// at startup, before that, and components read the latest value.
let fullScreen = false;
const listeners = new Set<() => void>();

export function initWindowFullScreen(): void {
  window.dohcDesktop?.onWindowFullScreen((event) => {
    if (fullScreen === event.fullScreen) return;
    fullScreen = event.fullScreen;
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWindowFullScreen(): boolean {
  return useSyncExternalStore(subscribe, () => fullScreen);
}
