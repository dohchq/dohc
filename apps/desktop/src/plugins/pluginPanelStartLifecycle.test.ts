import { describe, expect, it, vi } from "vitest";
import {
  loadPluginPanelRegistrationForCurrentRenderer,
  revokePluginPanelAuthoritiesForStatus,
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
  it("does not start an abandoned workspace after registration finishes loading", async () => {
    const loadEntered = deferredVoid();
    const releaseLoad = deferredVoid();
    let current = true;
    const ensurePluginStarted = vi.fn(async () => undefined);

    const open = loadPluginPanelRegistrationForCurrentRenderer(
      async () => {
        loadEntered.resolve();
        await releaseLoad.promise;
        return { pluginId: "plugin" };
      },
      () => current,
    ).then(ensurePluginStarted);
    await loadEntered.promise;
    current = false;
    releaseLoad.resolve();

    await expect(open).rejects.toThrow(/active workspace/i);
    expect(ensurePluginStarted).not.toHaveBeenCalled();
  });

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
      "workspace\0plugin",
      withLock,
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
      "workspace\0plugin",
      withLock,
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

  it("serializes one plugin host across different panel keys", async () => {
    const panelLocks = new Map<string, Promise<void>>();
    const pluginLocks = new Map<string, Promise<void>>();
    const lock = (locks: Map<string, Promise<void>>) =>
      async <T>(key: string, operation: () => Promise<T>) => {
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
    const withPanelLock = lock(panelLocks);
    const withPluginLock = lock(pluginLocks);
    const stopEntered = deferredVoid();
    const releaseStop = deferredVoid();
    const panels = new Set(["panel-a"]);
    let liveSpawns = 1;

    const stop = stopPluginPanelWithLock(
      "workspace\0plugin\0panel-a",
      "workspace\0plugin",
      withPanelLock,
      withPluginLock,
      async () => {
        panels.delete("panel-a");
        stopEntered.resolve();
        await releaseStop.promise;
        liveSpawns = 0;
      },
    );
    await stopEntered.promise;
    const start = startPluginPanelWithLock(
      "workspace\0plugin\0panel-b",
      "workspace\0plugin",
      withPanelLock,
      withPluginLock,
      async () => {
        if (liveSpawns === 0) liveSpawns = 1;
      },
      async () => {
        panels.add("panel-b");
      },
    );

    releaseStop.resolve();
    await Promise.all([stop, start]);

    expect(liveSpawns).toBe(1);
    expect(panels).toEqual(new Set(["panel-b"]));
  });

  it("revokes every tracked panel grant when its plugin crashes", () => {
    const revoked: string[] = [];

    revokePluginPanelAuthoritiesForStatus({
      workspaceId: "workspace",
      pluginId: "plugin",
      status: "crashed",
      panels: [
        { workspaceId: "workspace", pluginId: "plugin", panelId: "a" },
        { workspaceId: "workspace", pluginId: "plugin", panelId: "b" },
        { workspaceId: "workspace", pluginId: "other", panelId: "c" },
      ],
      revokePanel: (workspaceId, pluginId, panelId) => {
        revoked.push(`${workspaceId}/${pluginId}/${panelId}`);
      },
    });

    expect(revoked).toEqual(["workspace/plugin/a", "workspace/plugin/b"]);
  });
});
