// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { resetOrphanedDrafts } from "../orphanedDrafts";
import { useEngineDoc } from "./useEngineDoc";

// `useEngineDoc` backs every FileInspector. `@dohc/ydoc-projection`
// statically pulls in the full Tiptap stack and builds its schema at module
// load, so a static top-level import of it here put that whole editor stack
// in the renderer's EAGER chunk — defeating the lazy MarkdownEditor split
// this codebase otherwise relies on. This file pins that the projection
// module loads only when a deletion snapshot actually needs projecting, not
// merely by importing/binding this hook.
//
// vi.mock is hoisted above every import in this file, including this file's
// own `import { useEngineDoc } from "./useEngineDoc"` — so a static import
// chain from useEngineDoc.ts down to the projection module would already
// have run the factory below before any `it()` executes.
let projectionLoads = 0;
vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  projectionLoads += 1;
  return importOriginal();
});

afterEach(cleanup);

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;

function harnessBridge() {
  const saveStateListeners = new Set<SaveStateListener>();
  let openedSessionId: string | null = null;
  const doc = new Y.Doc();
  doc.getMap("meta").set("contentKind", "plain-text");
  doc.getText("plainText").insert(0, "seed");

  const api = {
    async openEngineYDocSession(payload: { sessionId: string }) {
      openedSessionId = payload.sessionId;
      return { available: true, initialUpdate: Y.encodeStateAsUpdate(doc) };
    },
    async applyEngineYDocUpdate() {
      return undefined;
    },
    onEngineYDocRemoteUpdate: () => () => undefined,
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    async closeEngineYDocSession() {
      return undefined;
    },
  };

  return {
    api,
    sessionId: () => openedSessionId,
  };
}

function Harness(props: { workspaceId: string; path: string }) {
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: true,
  });
  return (
    <div>
      <span data-testid="available">{String(engine.available)}</span>
    </div>
  );
}

let harness: ReturnType<typeof harnessBridge>;

beforeEach(() => {
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
});

it("does not load the Tiptap projection module merely by importing useEngineDoc", () => {
  // No render, no bind, nothing — this checks the STATIC import chain only.
  // MUTATION: reintroduce `import { yDocToMarkdown } from "@dohc/ydoc-projection"`
  // at the top of useEngineDoc.ts -> this reads 1 instead of 0, because the
  // test file's own top-level `import { useEngineDoc } from "./useEngineDoc"`
  // already evaluated that chain before this test body ran.
  expect(projectionLoads).toBe(0);
});

it("preloads the projection module once a session binds, but not before", async () => {
  expect(projectionLoads).toBe(0);
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  // The bind fires the preload fire-and-forget; give its microtask a turn.
  await waitFor(() => expect(projectionLoads).toBeGreaterThan(0));
});
