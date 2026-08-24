import { describe, expect, it, vi } from "vitest";
import {
  loadPluginPanelRegistrationForCurrentRenderer,
  revokePluginPanelAuthorities,
  revokePluginPanelAuthoritiesForStatus,
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

  it("revokes every panel grant of one plugin when it is disabled or uninstalled (#779 round 12 A4)", () => {
    const revoked: string[] = [];

    revokePluginPanelAuthorities({
      workspaceId: "workspace",
      pluginId: "plugin",
      panels: [
        { workspaceId: "workspace", pluginId: "plugin", panelId: "a" },
        { workspaceId: "workspace", pluginId: "plugin", panelId: "b" },
        { workspaceId: "workspace", pluginId: "other", panelId: "c" },
        { workspaceId: "other-workspace", pluginId: "plugin", panelId: "d" },
      ],
      revokePanel: (workspaceId, pluginId, panelId) => {
        revoked.push(`${workspaceId}/${pluginId}/${panelId}`);
      },
    });

    expect(revoked).toEqual(["workspace/plugin/a", "workspace/plugin/b"]);
  });
});
