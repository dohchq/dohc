// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStateEvent } from "../ipc/bridgeContract";
import {
  followDesktopUpdateState,
  useDesktopUpdateStateFeed,
} from "./useDesktopUpdateStateFeed";

const IDLE_UPDATE: UpdateStateEvent = {
  status: "idle",
  message: "Updates have not been checked yet.",
  currentVersion: "1.2.3",
  channel: "latest",
  canCheck: true,
  canInstall: false,
};

const READY_UPDATE: UpdateStateEvent = {
  status: "ready",
  message: "Update 1.2.4 is ready. Restart dohc to apply it.",
  currentVersion: "1.2.3",
  channel: "latest",
  canCheck: false,
  canInstall: true,
  version: "1.2.4",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("followDesktopUpdateState", () => {
  it("subscribes before it requests the snapshot", () => {
    const order: string[] = [];
    const follower = followDesktopUpdateState(
      {
        getUpdateState: () => {
          order.push("snapshot");
          return new Promise<UpdateStateEvent>(() => undefined);
        },
        onUpdateState: () => {
          order.push("subscribe");
          return () => undefined;
        },
      },
      vi.fn(),
    );

    expect(order).toEqual(["subscribe", "snapshot"]);
    follower.stop();
  });

  it("keeps a live event when the older snapshot resolves later", async () => {
    const snapshot = deferred<UpdateStateEvent>();
    let publish: ((state: UpdateStateEvent) => void) | undefined;
    const acceptState = vi.fn();
    const follower = followDesktopUpdateState(
      {
        getUpdateState: () => snapshot.promise,
        onUpdateState: (listener) => {
          publish = listener;
          return () => undefined;
        },
      },
      acceptState,
    );

    publish?.(READY_UPDATE);
    snapshot.resolve(IDLE_UPDATE);
    await snapshot.promise;

    expect(acceptState).toHaveBeenCalledOnce();
    expect(acceptState).toHaveBeenCalledWith(READY_UPDATE);
    follower.stop();
  });

  it("keeps a command result when the older snapshot resolves later", async () => {
    const snapshot = deferred<UpdateStateEvent>();
    const acceptState = vi.fn();
    const follower = followDesktopUpdateState(
      {
        getUpdateState: () => snapshot.promise,
        onUpdateState: () => () => undefined,
      },
      acceptState,
    );

    follower.acceptUpdateResult(READY_UPDATE);
    snapshot.resolve(IDLE_UPDATE);
    await snapshot.promise;

    expect(acceptState).toHaveBeenCalledOnce();
    expect(acceptState).toHaveBeenCalledWith(READY_UPDATE);
    follower.stop();
  });

  it("drops snapshot and event settlements after hook cleanup", async () => {
    const snapshot = deferred<UpdateStateEvent>();
    const acceptState = vi.fn();
    const unsubscribe = vi.fn();
    let publish: ((state: UpdateStateEvent) => void) | undefined;
    const follower = followDesktopUpdateState(
      {
        getUpdateState: () => snapshot.promise,
        onUpdateState: (listener) => {
          publish = listener;
          return unsubscribe;
        },
      },
      acceptState,
    );

    follower.stop();
    publish?.(READY_UPDATE);
    follower.acceptUpdateResult(READY_UPDATE);
    snapshot.resolve(READY_UPDATE);
    await snapshot.promise;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(acceptState).not.toHaveBeenCalled();
  });
});

describe("useDesktopUpdateStateFeed", () => {
  it("returns the current state and accepts command results", async () => {
    vi.stubGlobal("dohcDesktop", {
      getUpdateState: vi.fn(async () => IDLE_UPDATE),
      onUpdateState: vi.fn(() => () => undefined),
    });
    const view = renderHook(() => useDesktopUpdateStateFeed());

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.result.current.updateState).toEqual(IDLE_UPDATE);

    act(() => view.result.current.acceptUpdateResult(READY_UPDATE));
    expect(view.result.current.updateState).toEqual(READY_UPDATE);
  });
});
