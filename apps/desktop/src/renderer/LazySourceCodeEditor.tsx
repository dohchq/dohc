import { preloadableLazy } from "./preloadableLazy";

export const LazySourceCodeEditor = preloadableLazy(() =>
  import("./SourceCodeEditor").then((mod) => mod.SourceCodeEditor),
);
