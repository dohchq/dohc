import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { LazyExcalidrawCanvas } from "./DrawingView";
import { LazySourceCodeEditor } from "./LazySourceCodeEditor";
import { preloadMarkdownEditor } from "./editor/LazyMarkdownEditor";
import { preloadMarkdownReadView } from "./markdown/LazyMarkdownReadView";
import { preloadDesktopSettings } from "./settings/LazyDesktopSettings";
import { LazyCollectionPage } from "./shell/lazyViews";

/** Starts loading the code that shows a file, for a file someone is about to
 *  open: one they point at, or one a tab opens. */
export function preloadViewForPath(path: string): void {
  switch (fileKindForPath(path).displayKind) {
    case "markdown":
      // A note can show its read view while the engine opens it.
      preloadMarkdownEditor();
      void preloadMarkdownReadView();
      return;
    case "drawing":
      void LazyExcalidrawCanvas.preload();
      return;
    case "json":
    case "text":
    case "code":
      void LazySourceCodeEditor.preload();
      return;
    // These views load with the app, or are rare enough to load on open.
    case "csv":
    case "image":
    case "audio":
    case "pdf":
    case "database":
    case "binary":
      return;
  }
}

export function preloadCollectionView(): void {
  void LazyCollectionPage.preload();
}

// Small views people open soon after launch, in order. Each starts in an
// idle period after the one before it has loaded, so a key press waits behind
// at most one of them. Larger views (Chats, Collections, the source editor)
// slowed launch by about 300 ms in packaged runs, so they load on hover,
// focus, or open instead.
const IDLE_PRELOADS: readonly (() => Promise<void>)[] = [
  preloadDesktopSettings,
  preloadMarkdownReadView,
];
let idlePreloadsStarted = false;

/** Loads the common views' code while the renderer is idle, once per
 *  renderer. Drawings load only when someone points at one or opens one. */
export function scheduleIdleViewPreloads(): void {
  if (idlePreloadsStarted || typeof globalThis.requestIdleCallback !== "function") return;
  idlePreloadsStarted = true;
  const step = (index: number) => {
    const preload = IDLE_PRELOADS[index];
    if (!preload) return;
    void preload().then(() => globalThis.requestIdleCallback(() => step(index + 1)));
  };
  globalThis.requestIdleCallback(() => step(0));
}
