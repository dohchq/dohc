declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

// Excalidraw fetches its fonts from window.EXCALIDRAW_ASSET_PATH, then from a
// CDN. The renderer's content security policy blocks the CDN, so the renderer
// build ships the installed package's fonts in this folder and drops the CDN.
// electron.vite.config.ts does both.
export const EXCALIDRAW_ASSET_FOLDER = "excalidraw/";

export function excalidrawAssetPath(documentUrl: string): string {
  return new URL(EXCALIDRAW_ASSET_FOLDER, documentUrl).href;
}

// Call before the drawing code loads. Excalidraw reads the path when it
// first registers its fonts.
export function pointExcalidrawAtAppFonts(): void {
  window.EXCALIDRAW_ASSET_PATH = excalidrawAssetPath(window.location.href);
}
