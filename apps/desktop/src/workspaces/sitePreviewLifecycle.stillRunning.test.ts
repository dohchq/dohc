import { describe, expect, it, vi } from "vitest";
import { createSitePreviewLifecycle } from "./sitePreviewLifecycle";
import { AppCommandStillRunningError, type SiteProcessHandle } from "./siteRunner";
import { deferred } from "../testing/deferred";

// A handle whose processes outlive each stop until `alive` turns false, as a
// tree kill that fails leaves them.
function handle(state: { alive: boolean }) {
  const stop = vi.fn(async () => undefined);
  const value: SiteProcessHandle = {
    url: "http://127.0.0.1:43210/", command: "node", args: ["server.js"], cwd: "/trip/portal",
    logs: () => [], onExit: () => undefined, stop,
    stillRunning: async () => (state.alive ? [4242] : []),
  };
  return { value, stop };
}

const acquire = (
  lifecycle: ReturnType<typeof createSitePreviewLifecycle>,
  execute: (signal: AbortSignal) => Promise<{ handle: SiteProcessHandle; result: { logs: [] } }>,
) => lifecycle.acquire({
  holderId: "tab", senderId: 1, workspaceId: "trip", siteRoot: "portal", mode: "dev", restart: false,
  isCurrent: () => true,
  prepare: async () => execute,
});

describe("a workspace stop that has to report app commands still running", () => {
  it("reports a start cancelled before its handle was installed whose processes outlived the stop, and stops them on retry", async () => {
    const lifecycle = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
    const state = { alive: true };
    const leftover = handle(state);
    const executing = deferred<void>();
    const started = acquire(lifecycle, (signal) => {
      executing.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new AppCommandStillRunningError(leftover.value, [4242])), { once: true });
      });
    });
    void started.catch(() => undefined);
    await executing.promise;

    await expect(lifecycle.stopWorkspace("trip", { rejectOnFailure: true })).rejects.toThrow(AppCommandStillRunningError);
    expect(lifecycle.status("trip", "portal").running).toBe(true);

    // Still running: the next stop fails again and keeps the handle.
    await expect(lifecycle.stopWorkspace("trip", { rejectOnFailure: true })).rejects.toThrow(AppCommandStillRunningError);
    state.alive = false;
    await expect(lifecycle.stopWorkspace("trip", { rejectOnFailure: true })).resolves.toBeUndefined();
    expect(leftover.stop).toHaveBeenCalledTimes(2);
    expect(lifecycle.status("trip", "portal").running).toBe(false);
  });

  it("reports an installed command whose tree kill left it running, keeps it, and lets no start run over it", async () => {
    const lifecycle = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
    const state = { alive: true };
    const running = handle(state);
    await acquire(lifecycle, async () => ({ handle: running.value, result: { logs: [] } }));

    await expect(lifecycle.stopWorkspace("trip", { rejectOnFailure: true })).rejects.toThrow(AppCommandStillRunningError);
    expect(lifecycle.status("trip", "portal").running).toBe(true);
    const replacement = vi.fn(async () => ({ handle: handle({ alive: false }).value, result: { logs: [] as [] } }));
    await expect(acquire(lifecycle, replacement)).rejects.toThrow(AppCommandStillRunningError);
    expect(replacement).not.toHaveBeenCalled();

    state.alive = false;
    await expect(lifecycle.stopWorkspace("trip", { rejectOnFailure: true })).resolves.toBeUndefined();
    expect(lifecycle.status("trip", "portal").running).toBe(false);
  });

  it("reports a start whose command began and whose own cleanup, after the cancel, left it running", async () => {
    const lifecycle = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
    const state = { alive: true };
    const running = handle(state);
    const executing = deferred<void>();
    const release = deferred<void>();
    const started = acquire(lifecycle, async () => {
      executing.resolve();
      await release.promise;
      return { handle: running.value, result: { logs: [] } };
    });
    void started.catch(() => undefined);
    await executing.promise;

    // The stop cancels the start; the command it began comes back after.
    const stopping = lifecycle.stopWorkspace("trip", { rejectOnFailure: true });
    release.resolve();
    await expect(stopping).rejects.toThrow(AppCommandStillRunningError);
    expect(running.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.status("trip", "portal").running).toBe(true);

    state.alive = false;
    await expect(lifecycle.stopWorkspace("trip", { rejectOnFailure: true })).resolves.toBeUndefined();
  });

  it("still only logs it for a workspace switch", async () => {
    const lifecycle = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
    const running = handle({ alive: true });
    await acquire(lifecycle, async () => ({ handle: running.value, result: { logs: [] } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(lifecycle.stopWorkspace("trip")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
