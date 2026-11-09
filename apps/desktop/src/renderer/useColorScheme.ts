import { useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark";

/** The theme the window shows now. */
export function readColorScheme(): ColorScheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The theme the window shows. Renders again when it changes, including a system switch theme.ts applies outside React. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, readColorScheme);
}
