import { vi } from "vitest";
import type { WindowFocusedEvent } from "../ipc/bridgeContract";
import { initWindowFocus } from "../renderer/windowFocus";

// Tells this window whether it has focus, as main does, and keeps the rest of
// the stubbed bridge.
export function tellWindowFocused(focused: boolean): void {
  vi.stubGlobal("dohcDesktop", {
    ...window.dohcDesktop,
    onWindowFocused: (listener: (event: WindowFocusedEvent) => void) => {
      listener({ focused });
      return () => undefined;
    },
  });
  initWindowFocus();
}
