// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import {
  disposeEngineDocLeasesForTests,
  useEngineDoc,
} from "./useEngineDoc";

// A recovery draft is written twice: a lossless snapshot synchronously at the
// failure, then faithful Markdown once the lazy projection answers. The second
// half runs off a serial queue, so a newer snapshot can be captured while an
// earlier projection is still pending. This file pins what happens then.
//
// The projection is mocked twice over: the IMPORT is gated, so every snapshot
// in a burst is captured before any refinement can run, and each PROJECTION
// call is countable, so one of them can fail while the others succeed. Both
// levers need a module this file has never resolved — hence its own file.
let projectionCalls = 0;
let failProjectionCall: number | null = null;
let projectionGate: { promise: Promise<void>; release: () => void } | null =
  null;
vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  if (projectionGate) await projectionGate.promise;
  const original =
    await importOriginal<typeof import("@dohc/ydoc-projection")>();
  return {
    ...original,
    yDocToMarkdown: (doc: Y.Doc) => {
      projectionCalls += 1;
      if (projectionCalls === failProjectionCall) {
        throw new Error("projection failed");
      }
      return original.yDocToMarkdown(doc);
    },
  };
});

function armProjectionGate(): () => void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectionGate = { promise, release };
  return () => {
    projectionGate = null;
    release();
  };
}

// Main answers "not accepted", which is TERMINAL: the document stays editable
// while nothing can reach the engine, and every later edit re-captures the
// whole document state through the same recovery path.
function refusingBridge(initialUpdate: Uint8Array) {
  let openedSessionId: string | null = null;
  return {
    async openEngineYDocSession(payload: { sessionId: string }) {
      openedSessionId = payload.sessionId;
      return {
        available: true,
        initialUpdate,
        lineageGeneration: 1,
      };
    },
    async applyEngineYDocUpdate() {
      return { accepted: false as const, reason: "test-refusal" };
    },
    onEngineYDocRemoteUpdate: () => () => undefined,
    onEngineYDocLineageReplacement: () => () => undefined,
    onEngineYDocSaveState: () => () => undefined,
    async closeEngineYDocSession() {
      openedSessionId = null;
      return undefined;
    },
  };
}

function richInitialUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const heading = new Y.XmlElement("heading");
  heading.setAttribute("level", "1");
  const text = new Y.XmlText();
  text.insert(0, "My Heading");
  heading.insert(0, [text]);
  doc.getXmlFragment("body").insert(0, [heading]);
  return Y.encodeStateAsUpdate(doc);
}

let appendedBlocks = 0;

function Harness(props: { workspaceId: string; path: string }) {
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: true,
  });
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  return (
    <div>
      <span data-testid="available">{String(engine.available)}</span>
      <span data-testid="draft">{drafts.at(-1)?.text ?? "none"}</span>
      <span data-testid="draft-count">{drafts.length}</span>
      <button
        type="button"
        data-testid="append-block"
        onClick={() => {
          const doc = engine.doc;
          if (!doc) return;
          appendedBlocks += 1;
          const label = `edit-${appendedBlocks}`;
          doc.transact(() => {
            const body = doc.getXmlFragment("body");
            const paragraph = new Y.XmlElement("paragraph");
            const text = new Y.XmlText();
            text.insert(0, label);
            paragraph.insert(0, [text]);
            body.insert(body.length, [paragraph]);
          });
        }}
      >
        append block
      </button>
    </div>
  );
}

beforeEach(() => {
  projectionCalls = 0;
  failProjectionCall = null;
  projectionGate = null;
  appendedBlocks = 0;
  resetOrphanedDrafts();
});

afterEach(async () => {
  cleanup();
  await disposeEngineDocLeasesForTests();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
  projectionGate = null;
  failProjectionCall = null;
});

it("refines the newest refused snapshot, not the one each edit queued", async () => {
  vi.stubGlobal("dohcDesktop", refusingBridge(richInitialUpdate()));
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  // Held for the whole burst, so BOTH edits are captured before any
  // refinement runs — the order this defect needs, and the order a user
  // typing through a refused session produces.
  const release = armProjectionGate();

  render(<Harness workspaceId="ws-1" path="notes/rich.md" />);
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => {
    screen.getByTestId("append-block").click();
  });
  await waitFor(() =>
    expect(screen.getByTestId("draft-count").textContent).toBe("1"),
  );
  act(() => {
    screen.getByTestId("append-block").click();
  });
  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toContain("edit-2"),
  );

  // The newest snapshot's projection fails. The first edit's refinement — the
  // one queued behind it — must not answer for it.
  failProjectionCall = 2;
  release();
  await waitFor(() =>
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("could not refine the recovery draft"),
      expect.any(Error),
    ),
  );

  // MUTATION: project the bytes each refinement was queued with instead of the
  // newest ones — the first edit's Markdown lands last, and the second edit is
  // gone from the only copy of it that exists.
  expect(screen.getByTestId("draft").textContent).toContain("edit-1");
  expect(screen.getByTestId("draft").textContent).toContain("edit-2");
  expect(screen.getByTestId("draft-count").textContent).toBe("1");
  consoleError.mockRestore();
});
