// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { declareSceneRoots, insertElementRevision } from "@dohc/excalidraw-scene";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import {
  resetOrphanedDrafts,
  useOrphanedDrafts,
} from "../orphanedDrafts";
import { useEngineDoc } from "./useEngineDoc";

// AUDIT-SILENTSAVE. The engine editor's save indicator used to be a 1s timer
// that flipped to "saved" no matter what the engine did — three dogfood
// journeys watched a doc read "Saved" over a ZERO-BYTE .md. It is now driven
// only by main's real settle outcomes. These tests own that contract: no
// timer may resurrect "saved", a failure must show, and a settle that predates
// the newest keystroke must not claim to cover it.

afterEach(cleanup);

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;

function harnessBridge(kind: "richdoc" | "scene" = "richdoc") {
  const saveStateListeners = new Set<SaveStateListener>();
  const remoteUpdateListeners = new Set<
    (event: { sessionId: string; update: Uint8Array }) => void
  >();
  const applied: Array<{ sessionId: string; seq: number }> = [];
  let openedSessionId: string | null = null;
  const doc = new Y.Doc();
  if (kind === "scene") {
    declareSceneRoots(doc);
    insertElementRevision(doc, {
      id: "recovered-shape",
      type: "rectangle",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      index: "a0",
    });
  } else {
    doc.getMap("meta").set("contentKind", "plain-text");
    doc.getText("plainText").insert(0, "seed");
  }
  let removalInProgress: {
    operation: "delete" | "move";
    message: string;
  } | null = null;
  let emitDeletedDuringOpen = false;

  const api = {
    async openEngineYDocSession(payload: { sessionId: string }) {
      openedSessionId = payload.sessionId;
      if (emitDeletedDuringOpen) {
        for (const listener of [...saveStateListeners]) {
          listener({ sessionId: payload.sessionId, state: "deleted", seq: 0 });
        }
      }
      if (removalInProgress) {
        return { available: false, removalInProgress };
      }
      return { available: true, initialUpdate: Y.encodeStateAsUpdate(doc) };
    },
    async applyEngineYDocUpdate(payload: { sessionId: string; seq: number }) {
      applied.push({ sessionId: payload.sessionId, seq: payload.seq });
    },
    onEngineYDocRemoteUpdate: (
      listener: (event: { sessionId: string; update: Uint8Array }) => void,
    ) => {
      remoteUpdateListeners.add(listener);
      return () => remoteUpdateListeners.delete(listener);
    },
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    async closeEngineYDocSession() {
      return undefined;
    },
  };

  // Mutates the SOURCE doc and delivers the resulting incremental update as
  // a forwarded remote delta — a co-editor's edit, arriving on the same
  // channel a local one settles through. Not gated by `writesRefused`: a
  // remote update still applies to a deleted-while-editing doc (only LOCAL
  // writes are refused), so a deletion's captured text must be frozen
  // against exactly this.
  function emitRemoteEdit(suffix: string): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    const before = Y.encodeStateVector(doc);
    doc.getText("plainText").insert(doc.getText("plainText").length, suffix);
    const update = Y.encodeStateAsUpdate(doc, before);
    const event = { sessionId: openedSessionId, update };
    act(() => {
      for (const listener of [...remoteUpdateListeners]) listener(event);
    });
  }

  function emit(
    state: "settling" | "saved" | "error" | "file-locked" | "deleted",
    seq: number,
    sessionId?: string,
  ): void {
    const target = sessionId ?? openedSessionId;
    if (target === null) throw new Error("session not open yet");
    const event = { sessionId: target, state, seq };
    act(() => {
      for (const listener of [...saveStateListeners]) listener(event);
    });
  }

  function emitNow(
    state: "settling" | "saved" | "error" | "file-locked" | "deleted",
    seq: number,
  ): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    for (const listener of [...saveStateListeners]) {
      listener({ sessionId: openedSessionId, state, seq });
    }
  }

  return {
    api,
    emit,
    emitNow,
    emitRemoteEdit,
    applied,
    sessionId: () => openedSessionId,
    setRemovalInProgress(value: typeof removalInProgress) {
      removalInProgress = value;
    },
    setEmitDeletedDuringOpen(value: boolean) {
      emitDeletedDuringOpen = value;
    },
  };
}

function Harness(props: {
  workspaceId: string;
  path: string;
  enabled?: boolean;
  kind?: "richdoc" | "scene";
}) {
  const [retryKey, setRetryKey] = useState(0);
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: props.enabled ?? true,
    kind: props.kind,
    retryKey,
  });
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  return (
    <div>
      <span data-testid="state">{engine.saveState}</span>
      <span data-testid="available">{String(engine.available)}</span>
      <span data-testid="deleted">{String(engine.deletedWhileEditing)}</span>
      <span data-testid="draft">{drafts.at(-1)?.text ?? "none"}</span>
      <span data-testid="removal-operation">
        {engine.removalInProgress?.operation ?? "none"}
      </span>
      <span data-testid="removal-message">
        {engine.removalInProgress?.message ?? "none"}
      </span>
      <button
        type="button"
        data-testid="type"
        onClick={() => {
          if (props.kind === "scene" && engine.doc) {
            insertElementRevision(engine.doc, {
              id: "recovered-shape",
              type: "rectangle",
              version: 2,
              versionNonce: 2,
              isDeleted: false,
              index: "a0",
              x: 10,
            });
            return;
          }
          const text = engine.doc?.getText("plainText");
          text?.insert(text.length, "!");
        }}
      >
        type
      </button>
      <button type="button" data-testid="retry" onClick={() => setRetryKey((n) => n + 1)}>
        retry
      </button>
    </div>
  );
}

let harness: ReturnType<typeof harnessBridge>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
});

async function mountBound() {
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
}

async function flushLocalBatch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
}

it("never flips back to Saved on a timer — only a real settle report clears it", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // The old indicator flipped to "saved" 1s after the last edit regardless of
  // the engine. Run far past that: with no settle report, nothing may claim it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // Only main's real report clears it.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("shows the failure when a settle fails, instead of reading Saved", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("error");

  // It stays honest: no timer, no later edit-less event, walks it back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("error");
});

it("refuses transport writes synchronously after main reports deletion", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  expect(screen.getByTestId("state").textContent).toBe("deleted");
  expect(screen.getByTestId("deleted").textContent).toBe("true");

  // A Y.Doc update can fire before the read-only React render commits. The
  // transport ref closes that gap, so no later update reaches main.
  act(() => {
    screen.getByTestId("type").click();
  });
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(screen.getByTestId("state").textContent).toBe("deleted");

  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("deleted");
});

it("replaces the same deletion's draft when a keystroke lands before read-only commits", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;

  // One React batch: main reports deletion, then Tiptap emits one last local
  // update before the read-only render can commit.
  act(() => {
    harness.emitNow("deleted", harness.applied.at(-1)!.seq);
    screen.getByTestId("type").click();
  });

  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toBe("seed!!"),
  );
  expect(harness.applied).toHaveLength(appliedAtDelete);
});

it("freezes the deleted doc's bytes at the event, immune to a remote edit that lands before serialization resolves", async () => {
  // #697 P1-A: the boundary capture snapshots the doc SYNCHRONOUSLY at the
  // deletion event and defers only the markdown PROJECTION (the part that
  // needs the lazy Tiptap module). Nothing before this pin distinguished
  // that from deferring the snapshot too — both pass every earlier test,
  // because unmount alone does not corrupt a Y.Doc's encodable state.
  //
  // A remote update is the real discriminator: it is NOT gated by
  // `writesRefused` (only LOCAL writes are refused after deletion), so it
  // can still land on the SAME doc while the projection is in flight. A
  // synchronous snapshot is immune to it; a deferred one would pick it up.
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emitNow("deleted", harness.applied.at(-1)!.seq);

  // Lands after the event, before the queued serialize job has resolved.
  harness.emitRemoteEdit("+remote");

  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("seed!"));
});

it("stores a deleted scene as portable Excalidraw JSON", async () => {
  harness = harnessBridge("scene");
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness
      workspaceId="ws-1"
      path="drawing.excalidraw"
      kind="scene"
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => {
    const text = screen.getByTestId("draft").textContent ?? "none";
    expect(text).not.toBe("none");
    const recovered = JSON.parse(text);
    expect(recovered).toMatchObject({
      type: "excalidraw",
      source: "https://excalidraw.com",
      elements: [{ id: "recovered-shape" }],
      files: {},
    });
  });
});

it("still holds the final text after teardown, with no further save-state event to answer it", async () => {
  const view = render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);
  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("seed!"));

  // A further edit, then straight to teardown — no separate save-state
  // report from main ever answers this edit. Correctness pin, not a
  // discriminator: `onUpdate` already snapshots this edit synchronously
  // before teardown runs, so removing the teardown-time call alone does not
  // fail this specific test (verified). It is exercised here anyway,
  // because it is the one path that would lose an edit if that ordering
  // ever changed.
  act(() => {
    screen.getByTestId("type").click();
  });
  act(() => {
    view.rerender(
      <Harness workspaceId="ws-1" path="notes/big.md" enabled={false} />,
    );
  });

  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("seed!!"));
});

it("does not carry a deleted verdict into a fresh bind of the same path", async () => {
  const view = render(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled />,
  );
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("deleted").textContent).toBe("true");

  view.rerender(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled={false} />,
  );
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("false"));
  view.rerender(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled />,
  );
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  expect(screen.getByTestId("deleted").textContent).toBe("false");
  const appliedBeforeFreshEdit = harness.applied.length;
  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(appliedBeforeFreshEdit + 1);
});

it("observes deletion while the open answer is still in flight", async () => {
  harness.setEmitDeletedDuringOpen(true);
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);

  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  expect(screen.getByTestId("state").textContent).toBe("deleted");
  expect(screen.getByTestId("deleted").textContent).toBe("true");
});

it("keeps a failed delete interval retryable without storing a deleted verdict", async () => {
  harness.setRemovalInProgress({
    operation: "delete",
    message: "dohc is still deleting notes/big.md.",
  });
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);

  await waitFor(() =>
    expect(screen.getByTestId("removal-operation").textContent).toBe("delete"),
  );
  expect(screen.getByTestId("removal-message").textContent).toBe(
    "dohc is still deleting notes/big.md.",
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
  expect(screen.getByTestId("deleted").textContent).toBe("false");

  // The underlying delete failed and closed its interval. A new request opens
  // the still-present file without carrying a terminal verdict forward.
  harness.setRemovalInProgress(null);
  act(() => screen.getByTestId("retry").click());
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  expect(screen.getByTestId("removal-operation").textContent).toBe("none");
  expect(screen.getByTestId("deleted").textContent).toBe("false");
});

it("passes a file-locked report through, and a real settle clears it", async () => {
  // #554: the transient lock is its own state so the surface can name the
  // blocker. Like "error" it never decays on a timer — only a real settle
  // report walks it back, which is what the engine's own retry produces.
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("file-locked", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("file-locked");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("file-locked");

  // The engine's retry lands: the same real report clears it to Saved.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("does not claim File in use for a lock refusal that predates the newest keystroke", async () => {
  // `file-locked` is the one refusal whose copy makes a durability claim —
  // dohc has your edits, and it is retrying. A refusal about older text would
  // promise safety for a keystroke the settle never carried, so it is held to
  // the same sequence guard "saved" uses.
  //
  // MUTATION: accept `file-locked` unconditionally -> this reads
  // "file-locked" while an edit is still in flight.
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    screen.getByTestId("type").click();
  });

  // The lock refusal belongs to the settle that started before the second
  // keystroke. The second edit is staged but not sent yet. The local sequence
  // already guards it, so the document stays saving instead of claiming the
  // edit is safely parked under a lock.
  harness.emit("file-locked", firstSeq);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // A refusal that DOES cover the newest edit names the blocker.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("file-locked", secondSeq);
  expect(screen.getByTestId("state").textContent).toBe("file-locked");
});

it("does not claim Saved for a settle that predates the newest keystroke", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    screen.getByTestId("type").click();
  });

  // A settle that STARTED before the second keystroke reports success. It
  // never carried that staged, not-yet-sent edit, so the indicator must keep
  // saying "saving".
  harness.emit("saved", firstSeq);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // The follow-up settle covers it.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("saved", secondSeq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("degrades to not-engine-backed on a bridge without the save-state channel, instead of blanking the editor", async () => {
  // Round-2 regression. Subscribing synchronously in the effect body turned a
  // bridge that lacks this method (an older preload, a narrower host) from
  // "not engine-backed, fall back to the local editor" into an uncaught
  // TypeError that unmounted the whole document view. Every bridge call must
  // stay inside the caught region.
  const { onEngineYDocSaveState: _omitted, ...withoutSaveState } = harness.api;
  vi.stubGlobal("dohcDesktop", withoutSaveState);

  render(<Harness workspaceId="ws-1" path="notes/big.md" />);

  // The document view survives; it simply reports no engine session.
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("false"),
  );
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("ignores a save-state report addressed to a different session", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const seq = harness.applied.at(-1)!.seq;

  // Another document's settle must never repaint this one (the renderer
  // async-state invariant): right seq, wrong session id.
  harness.emit("saved", seq, "eyd-someone-else");
  expect(screen.getByTestId("state").textContent).toBe("saving");

  harness.emit("saved", seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});
