export type LiveDocumentKind = "richdoc" | "scene";

export const EXCALIDRAW_SCENE_ROOTS = {
  revisions: "excalidraw:revisions",
  appState: "excalidraw:app-state",
  assets: "excalidraw:assets",
} as const;

const LIVE_DOCUMENT_KIND_BY_EXTENSION: Readonly<Record<string, LiveDocumentKind>> = {
  md: "richdoc",
  markdown: "richdoc",
  excalidraw: "scene",
};

/** Returns the engine content kind for a live document path. */
export function liveDocumentKindForPath(path: string): LiveDocumentKind | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return LIVE_DOCUMENT_KIND_BY_EXTENSION[extension] ?? null;
}
