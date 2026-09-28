import { lazy } from "react";

// Views that both a side panel and an editor tab show. One lazy component per
// view, so a chunk that already loaded does not suspend again elsewhere.
export const LazyGraphView = lazy(() =>
  import("../workbench/GraphView").then((mod) => ({ default: mod.GraphView })),
);
export const LazySitePreviewPage = lazy(() =>
  import("../SitePreviewPage").then((mod) => ({ default: mod.SitePreviewPage })),
);
export const LazyChatsView = lazy(() =>
  import("../workbench/ChatsView").then((mod) => ({ default: mod.ChatsView })),
);
