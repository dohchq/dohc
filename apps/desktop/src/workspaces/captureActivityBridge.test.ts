import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@dohc/workspace-engine-client";
import {
  CAPTURE_MOMENT_RECORDED_EVENT,
  bridgeCaptureEventsToRenderer,
} from "./captureActivityBridge";

function captureEvent(name: string): Event {
  return { seq: 1, sessionGeneration: 1, name, payload: null };
}

function fakeDaemon(): {
  daemon: { onEvent(handler: (event: Event) => void): () => void };
  emit: (event: Event) => void;
  handlerCount: () => number;
} {
  const handlers = new Set<(event: Event) => void>();
  return {
    daemon: {
      onEvent(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
    handlerCount: () => handlers.size,
  };
}

describe("bridgeCaptureEventsToRenderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies the renderer when the daemon records a capture moment", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT));
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of capture events into one notification", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    for (let i = 0; i < 5; i += 1) {
      emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT));
    }
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(1);

    // A later batch notifies again — the debounce is a window, not a latch.
    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT));
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated daemon events", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    emit(captureEvent("ydoc.remoteUpdate"));
    vi.advanceTimersByTime(1_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it("dispose unsubscribes and cancels a pending notification", () => {
    const { daemon, emit, handlerCount } = fakeDaemon();
    const notify = vi.fn();
    const dispose = bridgeCaptureEventsToRenderer(daemon, notify, 100);

    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT));
    dispose();
    expect(handlerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(notify).not.toHaveBeenCalled();
  });
});
