// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetOrphanedDrafts } from "../orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./engineDocLease";
import { harnessBridge } from "./engineDocChunkingTestHarness";
import { useEngineDoc } from "./useEngineDoc";

// The real hook import must leave projection lazy until a session binds.
let projectionLoads = 0;
vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  projectionLoads += 1;
  return importOriginal();
});

function Harness(props: { workspaceId: string; path: string }) {
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: true,
  });
  return <span data-testid="available">{String(engine.available)}</span>;
}

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", harnessBridge().api);
  resetOrphanedDrafts();
});

afterEach(async () => {
  cleanup();
  await disposeEngineDocLeasesForTests();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
});

it("does not load the Tiptap projection module merely by importing useEngineDoc", () => {
  // No render, no bind, nothing — this checks the static import chain only.
  expect(projectionLoads, "reintroduce `import { yDocToMarkdown } from '@dohc/ydoc-projection'` at the top of useEngineDoc.ts -> this reads 1 instead of 0, because the test file's own top-level `import { useEngineDoc } from './useEngineDoc'` already evaluated that chain before this test body ran.").toBe(0);
});

it("preloads the projection module once a session binds, but not before", async () => {
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  // The bind fires the preload fire-and-forget; give its microtask a turn.
  await waitFor(() => expect(projectionLoads).toBeGreaterThan(0));
});
