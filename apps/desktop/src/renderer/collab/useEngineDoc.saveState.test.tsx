// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { useEngineDoc } from "./useEngineDoc";

// AUDIT-SILENTSAVE. The engine editor's save indicator used to be a 1s timer
// that flipped to "saved" no matter what the engine did — three dogfood
// journeys watched a doc read "Saved" over a ZERO-BYTE .md. It is now driven
// only by main's real settle outcomes. These tests own that contract: no
// timer may resurrect "saved", a failure must show, and a settle that predates
// the newest keystroke must not claim to cover it.

afterEach(cleanup);

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;

function harnessBridge() {
  const saveStateListeners = new Set<SaveStateListener>();
  const applied: Array<{ sessionId: string; seq: number }> = [];
  let openedSessionId: string | null = null;
  const doc = new Y.Doc();
  doc.getText("plainText").insert(0, "seed");

  const api = {
    async openEngineYDocSession(payload: { sessionId: string }) {
      openedSessionId = payload.sessionId;
      return { available: true, initialUpdate: Y.encodeStateAsUpdate(doc) };
    },
    async applyEngineYDocUpdate(payload: { sessionId: string; seq: number }) {
      applied.push({ sessionId: payload.sessionId, seq: payload.seq });
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

  function emit(
    state: "settling" | "saved" | "error",
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

  return { api, emit, applied, sessionId: () => openedSessionId };
}

function Harness(props: { workspaceId: string; path: string }) {
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: true,
  });
  return (
    <div>
      <span data-testid="state">{engine.saveState}</span>
      <span data-testid="available">{String(engine.available)}</span>
      <button
        type="button"
        data-testid="type"
        onClick={() => {
          const text = engine.doc?.getText("plainText");
          text?.insert(text.length, "!");
        }}
      >
        type
      </button>
    </div>
  );
}

let harness: ReturnType<typeof harnessBridge>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountBound() {
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
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
  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("error");

  // It stays honest: no timer, no later edit-less event, walks it back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("error");
});

it("does not claim Saved for a settle that predates the newest keystroke", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    screen.getByTestId("type").click();
  });
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);

  // A settle that STARTED before the second keystroke reports success. It
  // never carried that edit, so the indicator must keep saying "saving".
  harness.emit("saved", firstSeq);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // The follow-up settle covers it.
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
  const seq = harness.applied.at(-1)!.seq;

  // Another document's settle must never repaint this one (the renderer
  // async-state invariant): right seq, wrong session id.
  harness.emit("saved", seq, "eyd-someone-else");
  expect(screen.getByTestId("state").textContent).toBe("saving");

  harness.emit("saved", seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});
