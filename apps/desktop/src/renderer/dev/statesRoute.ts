import { useSyncExternalStore } from "react";

// The states page's address inside the renderer. The address alone opens
// nothing: the page also needs main's dev-tools grant (DOHC_DEV_TOOLS=1 in an
// unpackaged build), which reaches the renderer as `bridge().devTools`. A
// packaged app never renders it, whatever its URL says.
export const STATES_PAGE_HASH = "#/dev/states";

export function statesPageRequested(hash: string, devTools: boolean): boolean {
  return devTools && hash === STATES_PAGE_HASH;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useStatesPageOpen(devTools: boolean): boolean {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return statesPageRequested(hash, devTools);
}

export function openStatesPage(): void {
  window.location.hash = STATES_PAGE_HASH;
}

export function closeStatesPage(): void {
  window.location.hash = "";
}
