export type LiveDocumentKind = "richdoc";

const LIVE_DOCUMENT_KIND_BY_EXTENSION: Readonly<Record<string, LiveDocumentKind>> = {
  md: "richdoc",
  markdown: "richdoc",
};

/** Returns the engine content kind for a live document path. */
export function liveDocumentKindForPath(path: string): LiveDocumentKind | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return LIVE_DOCUMENT_KIND_BY_EXTENSION[extension] ?? null;
}
