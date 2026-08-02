// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { useEngineDoc } from "./useEngineDoc";

// #533. `available: false` used to mean two different things — "this document
// is not engine-backed" and "dohc has not found out yet" — and the editor
// surface could only see the first. While the engine open waits behind the
// capture chain (startup reconciliation of a 1,000-file workspace holds it for
// seconds), the caller therefore offered its writable plain editor, whose
// autosave writes straight to disk. The about-to-bind session seeds from the
// engine head, so those keystrokes went somewhere it never looks.
//
// These tests own the distinguishing state: `opening` is true from the FIRST
// render until the open resolves, whichever way it resolves.

// Every render pass's `opening`, in order — the effect that issues the open
// runs after the first pass, so only this sees what the first pass reported.
let renderedOpening: boolean[] = [];

beforeEach(() => {
  renderedOpening = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness(props: { path: string; enabled?: boolean }) {
  const engine = useEngineDoc({
    workspaceId: "ws-1",
    path: props.path,
    enabled: props.enabled ?? true,
  });
  renderedOpening.push(engine.opening);
  return (
    <div>
      <span data-testid="opening">{String(engine.opening)}</span>
      <span data-testid="available">{String(engine.available)}</span>
    </div>
  );
}

// An open the test resolves by hand — the capture chain, held.
function deferredBridge() {
  const doc = new Y.Doc();
  doc.getText("plainText").insert(0, "seed");
  let settle: ((result: { available: boolean }) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const api = {
    openEngineYDocSession: vi.fn(
      () =>
        new Promise<{ available: boolean; initialUpdate?: Uint8Array }>(
          (resolve, reject) => {
            settle = (result) =>
              resolve(
                result.available
                  ? { available: true, initialUpdate: Y.encodeStateAsUpdate(doc) }
                  : { available: false },
              );
            fail = reject;
          },
        ),
    ),
    applyEngineYDocUpdate: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: () => () => undefined,
    onEngineYDocSaveState: () => () => undefined,
    closeEngineYDocSession: vi.fn(async () => undefined),
  };
  return {
    api,
    bind: () => settle?.({ available: true }),
    refuse: () => settle?.({ available: false }),
    throwOpen: () => fail?.(new Error("daemon gone")),
  };
}

it("reports opening on the first render, before the open is even issued", () => {
  const bridge = deferredBridge();
  vi.stubGlobal("dohcDesktop", bridge.api);

  render(<Harness path="notes/a.md" />);

  // The FIRST render pass, not merely the settled DOM: the effect that issues
  // the open runs after that pass, so a state that only turns true there paints
  // one frame in which the caller believes this document is not engine-backed
  // and mounts its writable editor. `render` flushes effects, so the DOM alone
  // cannot see that frame — the render log can.
  expect(renderedOpening[0]).toBe(true);
  expect(screen.getByTestId("opening").textContent).toBe("true");
  expect(screen.getByTestId("available").textContent).toBe("false");
});

it("stays opening while the open is held, then binds", async () => {
  const bridge = deferredBridge();
  vi.stubGlobal("dohcDesktop", bridge.api);

  render(<Harness path="notes/a.md" />);
  await waitFor(() => expect(bridge.api.openEngineYDocSession).toHaveBeenCalled());
  expect(screen.getByTestId("opening").textContent).toBe("true");

  bridge.bind();
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  expect(screen.getByTestId("opening").textContent).toBe("false");
});

it("separates 'not engine-backed' from 'opening' — both are available:false", async () => {
  const bridge = deferredBridge();
  vi.stubGlobal("dohcDesktop", bridge.api);

  render(<Harness path="notes/a.md" />);
  await waitFor(() => expect(bridge.api.openEngineYDocSession).toHaveBeenCalled());
  expect(screen.getByTestId("available").textContent).toBe("false");
  expect(screen.getByTestId("opening").textContent).toBe("true");

  // The engine answers: this workspace has no capture. Same `available`, and
  // now the caller may fall back to the writable plain editor.
  bridge.refuse();
  await waitFor(() =>
    expect(screen.getByTestId("opening").textContent).toBe("false"),
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
});

it("clears opening when the open throws, instead of wedging the surface read-only", async () => {
  const bridge = deferredBridge();
  vi.stubGlobal("dohcDesktop", bridge.api);

  render(<Harness path="notes/a.md" />);
  await waitFor(() => expect(bridge.api.openEngineYDocSession).toHaveBeenCalled());

  bridge.throwOpen();
  await waitFor(() =>
    expect(screen.getByTestId("opening").textContent).toBe("false"),
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
});

it("never opens for a document the caller has gated off", () => {
  const bridge = deferredBridge();
  vi.stubGlobal("dohcDesktop", bridge.api);

  render(<Harness path="notes/a.md" enabled={false} />);

  // Truncated reads and read-only shared views are read-only for their own
  // reasons and never bind a session — they must not inherit an opening wait.
  expect(screen.getByTestId("opening").textContent).toBe("false");
  expect(bridge.api.openEngineYDocSession).not.toHaveBeenCalled();
});

it("re-enters opening when the document switches", async () => {
  const bridge = deferredBridge();
  vi.stubGlobal("dohcDesktop", bridge.api);

  const view = render(<Harness path="notes/a.md" />);
  bridge.bind();
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  // The next document's open starts over: a bound predecessor must not lend
  // this one a writable surface before its own session answers.
  view.rerender(<Harness path="notes/b.md" />);
  await waitFor(() =>
    expect(screen.getByTestId("opening").textContent).toBe("true"),
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
});
