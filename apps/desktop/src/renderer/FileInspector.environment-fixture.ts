import { configure } from "@testing-library/dom";
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

  // Rendering suites await lazy editor imports through findBy*.
  //
  // asyncUtilTimeout is the one that actually mattered: findBy* rejects on RTL's own
  // 1000ms default, so these failed at ~1s with "Unable to find [data-testid=...]"
  // while the test budget was never reached. Raising testTimeout alone fixed nothing
  // here — an error shape that reads like a product regression rather than a flake.
  configure({ asyncUtilTimeout: 5_000 });

  vi.setConfig({ testTimeout: 15_000 });

  afterEach(async () => {
    vi.useRealTimers();
    await disposeEngineDocLeasesForTests();
    resetSharedLocalDocumentsForTests();
  });
}
