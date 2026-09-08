import { lazy } from "react";

export const LazySourceCodeEditor = lazy(() =>
  import("./SourceCodeEditor").then((mod) => ({
    default: mod.SourceCodeEditor,
  })),
);
