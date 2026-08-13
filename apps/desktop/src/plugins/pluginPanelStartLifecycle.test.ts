import { describe, expect, it } from "vitest";
import {
  startPluginPanelWithLock,
  stopPluginPanelWithLock,
} from "./pluginPanelStartLifecycle";

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("plugin panel start lifecycle", () => {
  it("does not leave a plugin host running when tab cleanup races a pending start", async () => {
    const locks = new Map<string, Promise<void>>();
    const withLock = async <T>(key: string, operation: () => Promise<T>) => {
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(key, current);
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (locks.get(key) === current) locks.delete(key);
      }
    };
    const ensureEntered = deferredVoid();
    const releaseEnsure = deferredVoid();
    let hostRunning = false;
    let panels = 0;

    const start = startPluginPanelWithLock(
      "workspace\0plugin\0main",
      withLock,
      async () => {
        ensureEntered.resolve();
        await releaseEnsure.promise;
        hostRunning = true;
      },
      async () => {
        panels += 1;
      },
    );
    await ensureEntered.promise;
    const stop = stopPluginPanelWithLock(
      "workspace\0plugin\0main",
      withLock,
      async () => {
        panels = 0;
        hostRunning = false;
      },
    );

    releaseEnsure.resolve();
    await Promise.all([start, stop]);

    expect({ hostRunning, panels }).toEqual({
      hostRunning: false,
      panels: 0,
    });
  });
});
