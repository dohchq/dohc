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
import { disposeEngineDocLeasesForTests } from "./collab/useEngineDoc";

export function setupFileInspectorTests(): void {

  // 32 of the 39 tests here await a lazily-imported CodeMirror via findBy*, so the
  // wall-clock profile is the file, not one test. File-level is the honest
  // scope; per-test would be 32 copies of the same line.
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
