import type { DohcDesktopBridge } from "../ipc/bridgeContract";

declare global {
  interface Window {
    dohcDesktop?: DohcDesktopBridge;
    dohcDesktopInternal?: { firstPaint(): void };
  }
}

export function bridge(): DohcDesktopBridge {
  const api = window.dohcDesktop;
  if (!api) throw new Error("dohc desktop bridge is unavailable");
  return api;
}
