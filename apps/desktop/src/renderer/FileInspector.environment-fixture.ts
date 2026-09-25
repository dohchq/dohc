import "@testing-library/react";
import { afterEach, vi } from "vitest";

// Pre-warm the lazily-loaded views at collection so no findBy* window pays
// for a module load under machine load (the mechanism, measured in #568).
import "./editor/MarkdownEditor";

import "./PropertiesPanel";

import "./DatabaseStudioView";

import "./SourceCodeEditor";
import { resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";
import { disposeEngineDocLeasesForTests } from "./collab/engineDocLease";

export function setupFileInspectorTests(): void {
  afterEach(async () => {
    vi.useRealTimers();
    await disposeEngineDocLeasesForTests();
    resetSharedLocalDocumentsForTests();
  });
}
