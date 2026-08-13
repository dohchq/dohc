import { createMarkRecorder, type MarksSnapshot } from "./desktopMarks";

// The renderer-process recorder (separate instance from main's desktopMarks —
// the renderer is a separate bundle and process).
export const rendererMarks = createMarkRecorder();

export function fileOpenStartMark(groupId: string): string {
  return `file-open-start:${groupId}`;
}

declare global {
  interface Window {
    // Present only when the preload exposed the test bridge (DOHC_DESKTOP_TEST=1).
    dohcDesktopTest?: unknown;
    dohcDesktopMarks?: { snapshot(): MarksSnapshot };
  }
}

// Test-only window hook, gated exactly like the existing test seams: the
// preload exposes dohcDesktopTest only when DOHC_DESKTOP_TEST=1 (and the
// authoritative main-process handlers are additionally !app.isPackaged), so
// its presence is the renderer-side test signal. Production windows never
// grow this surface.
if (typeof window !== "undefined" && window.dohcDesktopTest !== undefined) {
  window.dohcDesktopMarks = { snapshot: () => rendererMarks.snapshot() };
}
