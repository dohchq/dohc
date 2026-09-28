import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@dohc/workspace-engine-client";
import {
  CAPTURE_MOMENT_RECORDED_EVENT,
  CAPTURE_NO_ATOMIC_PLACEMENT_EVENT,
  bridgeCaptureEventsToRenderer,
  bridgeNoAtomicPlacement,
  onWorkspaceCaptureSettled,
} from "./captureActivityBridge";

function captureEvent(name: string, payload: Event["payload"] = null): Event {
  return { seq: 1, sessionGeneration: 1, name, payload };
}

function momentPayload(workspaceId: string, paths: string[]): Event["payload"] {
  return {
    workspaceId,
    appliedCount: paths.length,
    notOwnedCount: 0,
    paths,
  };
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

  it("forwards the daemon payload's workspaceId and paths", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    emit(
      captureEvent(
        CAPTURE_MOMENT_RECORDED_EVENT,
        momentPayload("ws-a", ["notes/a.md"]),
      ),
    );
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-a",
      paths: ["notes/a.md"],
    });
  });

  it("coalesces a burst per workspace into one scoped notification each", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    for (let i = 0; i < 3; i += 1) {
      emit(
        captureEvent(
          CAPTURE_MOMENT_RECORDED_EVENT,
          momentPayload("ws-a", [`a-${i}.md`]),
        ),
      );
    }
    emit(
      captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, momentPayload("ws-b", ["b.md"])),
    );
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      paths: ["a-0.md", "a-1.md", "a-2.md"],
    });
    expect(notify).toHaveBeenCalledWith({ workspaceId: "ws-b", paths: ["b.md"] });

    // A later batch notifies again — the debounce is a window, not a latch.
    emit(
      captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, momentPayload("ws-a", ["a.md"])),
    );
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("omits paths when the daemon truncated them", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    emit(
      captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, {
        workspaceId: "ws-a",
        // A baseline pass larger than the wire cap: the paths list is a
        // partial sample, so forwarding it would hide the rest.
        appliedCount: 100,
        notOwnedCount: 0,
        paths: ["only-some.md"],
      }),
    );
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
  });

  it("degrades a payload without a workspace to one global notification", () => {
    const { daemon, emit } = fakeDaemon();
    const notify = vi.fn();
    bridgeCaptureEventsToRenderer(daemon, notify, 100);

    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT));
    emit(
      captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, momentPayload("ws-a", ["a.md"])),
    );
    vi.advanceTimersByTime(100);
    // The global ping already reaches every window; a scoped send on top
    // would only repeat the repaint.
    expect(notify).toHaveBeenCalledExactlyOnceWith();
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

    emit(
      captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, momentPayload("ws-a", ["a.md"])),
    );
    dispose();
    expect(handlerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("onWorkspaceCaptureSettled", () => {
  it("passes one workspace's announced paths, and null when an announcement may concern it without listing them", () => {
    const { daemon, emit, handlerCount } = fakeDaemon();
    const seen: Array<readonly string[] | null> = [];
    const unsubscribe = onWorkspaceCaptureSettled(daemon, "ws-a", (paths) => {
      seen.push(paths);
    });

    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, momentPayload("ws-a", ["tasks/two.md"])));
    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, momentPayload("ws-b", ["tasks/two.md"])));
    emit(captureEvent("record.created", momentPayload("ws-a", ["tasks/two.md"])));
    // More paths than the payload lists, and a payload that names no workspace.
    emit(
      captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, {
        workspaceId: "ws-a",
        appliedCount: 40,
        notOwnedCount: 0,
        paths: ["tasks/one.md"],
      }),
    );
    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, { paths: ["tasks/two.md"] }));

    expect(seen).toEqual([["tasks/two.md"], null, null]);
    unsubscribe();
    expect(handlerCount()).toBe(0);
  });
});

describe("bridgeNoAtomicPlacement", () => {
  it("names the workspace the engine reports, and ignores anything else", () => {
    const { daemon, emit, handlerCount } = fakeDaemon();
    const noted: string[] = [];
    const dispose = bridgeNoAtomicPlacement(daemon, (workspaceId) => noted.push(workspaceId));
    emit(captureEvent(CAPTURE_NO_ATOMIC_PLACEMENT_EVENT, { workspaceId: "ws-usb" }));
    emit(captureEvent(CAPTURE_NO_ATOMIC_PLACEMENT_EVENT, null));
    emit(captureEvent(CAPTURE_MOMENT_RECORDED_EVENT, { workspaceId: "ws-other" }));
    expect(noted).toEqual(["ws-usb"]);
    dispose();
    expect(handlerCount()).toBe(0);
  });
});
