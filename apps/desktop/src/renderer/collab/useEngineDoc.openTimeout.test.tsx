// @vitest-environment jsdom
// #564. An engine open that hit its retry deadline is its OWN outcome, like
// notInVersion (#534): every other available:false falls back to the writable
// plain editor, and this one must not — the engine may still bind the
// document, and a plain autosave meanwhile would take the disk path #533
// closed. These pin the outcome kind and the retry: bumping retryKey is a
// fresh open.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEngineDoc } from "./useEngineDoc";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness(props: { retryKey?: number }) {
  const engine = useEngineDoc({
    workspaceId: "ws-1",
    path: "notes.md",
    enabled: true,
    ...(props.retryKey === undefined ? {} : { retryKey: props.retryKey }),
  });
  return (
    <div>
      <span data-testid="opening">{String(engine.opening)}</span>
      <span data-testid="available">{String(engine.available)}</span>
      <span data-testid="open-timed-out">{String(engine.openTimedOut)}</span>
    </div>
  );
}

function timedOutBridge() {
  const api = {
    openEngineYDocSession: vi.fn(async () => ({
      available: false,
      openTimedOut: true,
    })),
    applyEngineYDocUpdate: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: () => () => undefined,
    onEngineYDocSaveState: () => () => undefined,
    closeEngineYDocSession: vi.fn(async () => undefined),
  };
  vi.stubGlobal("dohcDesktop", api);
  return api;
}

it("reports a timed-out open as its own outcome, never a plain fallback", async () => {
  timedOutBridge();
  render(<Harness />);
  await waitFor(() => {
    expect(screen.getByTestId("opening").textContent).toBe("false");
  });
  // MUTATION: map openTimedOut onto "unavailable" -> this flag stays false
  // and the caller shows the writable plain editor over a session the engine
  // may still bind.
  expect(screen.getByTestId("open-timed-out").textContent).toBe("true");
  expect(screen.getByTestId("available").textContent).toBe("false");
});

it("retries as a fresh open when retryKey changes", async () => {
  const api = timedOutBridge();
  const view = render(<Harness retryKey={0} />);
  await waitFor(() => {
    expect(screen.getByTestId("open-timed-out").textContent).toBe("true");
  });
  expect(api.openEngineYDocSession).toHaveBeenCalledTimes(1);

  view.rerender(<Harness retryKey={1} />);
  // The new request answers "opening" again — the read-only wait, not the
  // stale refusal — and issues a second open.
  await waitFor(() => {
    expect(api.openEngineYDocSession).toHaveBeenCalledTimes(2);
  });
});
