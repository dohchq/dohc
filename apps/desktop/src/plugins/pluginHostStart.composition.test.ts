import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHost, PluginHostRecordToken } from "./PluginHost";
import type { PluginPipeline, PluginPipelinePluginStatus } from "./PluginPipeline";
import { PluginHostOwnership } from "./pluginHostOwnership";
import { createPluginPanelSurfaceHostLease, createPluginWebAppHostLease } from "./pluginHostStart";
import { deferred } from "../testing/deferred";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function fixture() {
  const record = {} as PluginHostRecordToken;
  const panel = { id: "panel", title: "Panel", entry: "panel.html", placement: "editor" as const };
  let spawnId: string | undefined = "spawn";
  let ready = true;
  const hostPort = {
    currentRecord: vi.fn(() => record),
    activationOf: vi.fn<PluginHost["activationOf"]>(() => Promise.resolve()),
    getSpawnId: vi.fn(() => spawnId),
    readyPanelsForSpawn: vi.fn((_pluginId: string, expectedSpawn: string) =>
      ready && expectedSpawn === spawnId ? { record, panels: [panel] } : undefined),
    startWebApp: vi.fn(async () => ({ url: "http://127.0.0.1:8080/" })),
    stopWebApp: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined), stopRecord: vi.fn(async () => undefined),
    bumpGeneration: vi.fn(), stopAll: vi.fn(async () => undefined),
  };
  // Host protocol responses are the external port; admission and activation
  // sequencing run through the real ownership and start helpers.
  const host = hostPort as unknown as PluginHost;
  const ownership = new PluginHostOwnership(host);
  const status: PluginPipelinePluginStatus = {
    id: "plugin", directoryName: "plugin", rootPath: "plugin", valid: true,
    status: "ready", disabledReason: null, runtimeStatus: "ready", sourceHash: "hash",
    approvedHash: "hash", installedBaselineHash: "hash", webApps: [], panels: [],
    commands: [], settings: [], hasFailedReplacement: false, diagnostics: [], warnings: [], error: null,
    displayName: null, description: null, publisher: null, icon: null, pluginVersion: null,
    repository: null, issues: null, license: null,
  };
  const ensureStarted = vi.fn<PluginPipeline["ensureStarted"]>(async () => ({
    kind: "existing", value: { ok: true, plugin: status },
  }));
  const pipeline = { host, hostOwnership: ownership, ensureStarted } as unknown as PluginPipeline;
  const leases: Array<{ release(): Promise<void> }> = [];
  cleanups.push(async () => {
    await Promise.all(leases.map(lease => lease.release()));
    await ownership.close();
  });
  return {
    record, panel, host: hostPort, ownership, ensureStarted,
    setSpawn: (value: string | undefined) => { spawnId = value; },
    setReady: (value: boolean) => { ready = value; },
    panelLease: () => { const lease = createPluginPanelSurfaceHostLease(pipeline, "plugin"); leases.push(lease); return lease; },
    webAppLease: () => { const lease = createPluginWebAppHostLease(pipeline, "plugin", "app", "instance"); leases.push(lease); return lease; },
  };
}

describe("desktop plugin host lease composition", () => {
  it("waits for activation before reading the ready panel and returns its exact host record", async () => {
    const f = fixture(); const entered = deferred<void>(); const activation = deferred<void>();
    f.host.activationOf.mockImplementation(() => { entered.resolve(); return activation.promise; });
    const lease = f.panelLease();
    const pending = lease.startPanel("panel");
    try {
      await entered.promise;
      expect(f.host.readyPanelsForSpawn).not.toHaveBeenCalled();
      expect(f.ensureStarted).toHaveBeenCalledWith("plugin", expect.any(Object));
    } finally { activation.resolve(); await Promise.allSettled([pending]); }
    expect(await pending).toEqual({ spawnId: "spawn", hostRecord: f.record, panel: f.panel });
    expect(f.host.readyPanelsForSpawn).toHaveBeenCalledWith("plugin", "spawn");
    expect(lease.currentRecord()).toBe(f.record);
  });

  it.each(["missing panel", "not ready"])("rejects a %s after host activation", async (reason) => {
    const f = fixture(); if (reason === "not ready") f.setReady(false);
    await expect(f.panelLease().startPanel(reason === "missing panel" ? "other" : "panel"))
      .rejects.toThrow("does not declare panel");
    expect(f.host.activationOf).toHaveBeenCalledWith("plugin");
  });

  it("rejects a host that has no spawn after activation", async () => {
    const f = fixture(); f.setSpawn(undefined);
    await expect(f.panelLease().start()).rejects.toThrow('Plugin "plugin" has no active process.');
    expect(f.host.readyPanelsForSpawn).not.toHaveBeenCalled();
  });

  it("propagates a pipeline refusal without activating the host", async () => {
    const f = fixture();
    f.ensureStarted.mockResolvedValue({ kind: "existing", value: { ok: false, plugin: null,
      error: { stage: "runtime", code: "approval-changed", message: "approval changed" } } });
    await expect(f.panelLease().start()).rejects.toThrow("approval changed");
    expect(f.host.activationOf).not.toHaveBeenCalled();
  });

  it("propagates activation failure without reading panel declarations", async () => {
    const f = fixture(); f.host.activationOf.mockImplementation(async () => { throw new Error("activation failed"); });
    await expect(f.panelLease().startPanel("panel")).rejects.toThrow("activation failed");
    expect(f.host.readyPanelsForSpawn).not.toHaveBeenCalled();
  });

  it("uses the real ownership refusal after close", async () => {
    const f = fixture(); await f.ownership.close();
    expect(() => f.panelLease()).toThrow("before it could start");
    expect(() => f.webAppLease()).toThrow("before it could start");
    expect(f.ensureStarted).not.toHaveBeenCalled();
  });

  it.each(["panel", "web app"])("releases an unused %s lease before any start admission", async (kind) => {
    const f = fixture();
    const lease = kind === "panel" ? f.panelLease() : f.webAppLease();
    await lease.release();
    await expect(lease.start()).rejects.toThrow();
    expect(f.ensureStarted).not.toHaveBeenCalled();
    expect(f.host.activationOf).not.toHaveBeenCalled();
  });

  it("forwards app pairing and unpairs only the expected live spawn", async () => {
    const f = fixture(); const lease = f.webAppLease();
    expect(await lease.start()).toBe("spawn");
    expect(await lease.startWebApp()).toEqual({ url: "http://127.0.0.1:8080/" });
    expect(f.host.startWebApp).toHaveBeenCalledWith("plugin", "app", "instance");
    f.setSpawn("successor");
    expect(lease.currentSpawnId()).toBe("successor");
    await lease.unpair("spawn");
    expect(f.host.stopWebApp).not.toHaveBeenCalled();
    await lease.unpair("successor");
    expect(f.host.stopWebApp).toHaveBeenCalledWith("plugin", "app", "instance");
    await lease.release();
    await expect(lease.start()).rejects.toThrow();
  });
});
