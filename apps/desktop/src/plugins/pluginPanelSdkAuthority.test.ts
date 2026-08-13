import { describe, expect, it } from "vitest";
import { createPluginPanelSdkAuthorityRegistry } from "./pluginPanelSdkAuthority";

const owned = {
  senderId: 1,
  generation: 2,
  workspaceId: "workspace-a",
  pluginId: "hello-plugin",
  panelId: "main",
};

function authorize(
  registry: ReturnType<typeof createPluginPanelSdkAuthorityRegistry>,
  patch: Partial<Parameters<typeof registry.authorize>[0]> = {},
) {
  return registry.authorize({
    senderId: 1,
    generation: 2,
    activeWorkspaceId: "workspace-a",
    workspaceId: "workspace-a",
    pluginId: "hello-plugin",
    panelId: "main",
    panelRunning: true,
    liveSpawnId: "spawn-live",
    ...patch,
  });
}

describe("plugin panel SDK authority", () => {
  it("registers host-derived context and replaces the prior panel grant", () => {
    const registry = createPluginPanelSdkAuthorityRegistry();
    const first = registry.register(owned);
    registry.register({ ...owned, senderId: 2 });

    expect(first.signal.aborted).toBe(true);
    expect(() => authorize(registry)).toThrow(/active panel/i);
    expect(
      authorize(registry, { senderId: 2 }),
    ).toMatchObject({
      spawnId: "spawn-live",
    });
  });

  it("does not pin workspace writability to a panel grant", () => {
    const registry = createPluginPanelSdkAuthorityRegistry();
    registry.register(owned);

    expect(authorize(registry)).not.toHaveProperty("writable");
  });

  it("rejects the wrong sender, workspace, plugin, and panel", () => {
    const registry = createPluginPanelSdkAuthorityRegistry();
    registry.register(owned);

    expect(() => authorize(registry, { senderId: 99 })).toThrow(/active panel/i);
    expect(() =>
      authorize(registry, { activeWorkspaceId: "workspace-b" }),
    ).toThrow(/active workspace/i);
    expect(() => authorize(registry, { pluginId: "other-plugin" })).toThrow(
      /active panel/i,
    );
    expect(() => authorize(registry, { panelId: "other-panel" })).toThrow(
      /active panel/i,
    );
  });

  it("revokes stale generations and inactive panels", () => {
    const generations = createPluginPanelSdkAuthorityRegistry();
    const staleGeneration = generations.register(owned);
    expect(() => authorize(generations, { generation: 3 })).toThrow(/stale/i);
    expect(staleGeneration.signal.aborted).toBe(true);

    const panels = createPluginPanelSdkAuthorityRegistry();
    const inactivePanel = panels.register(owned);
    expect(() => authorize(panels, { panelRunning: false })).toThrow(/stale/i);
    expect(inactivePanel.signal.aborted).toBe(true);
  });

  it("revokes a tracked panel when its plugin has no live spawn", () => {
    const registry = createPluginPanelSdkAuthorityRegistry();
    const grant = registry.register(owned);

    expect(() =>
      authorize(registry, { panelRunning: true, liveSpawnId: undefined }),
    ).toThrow(/stale/i);
    expect(grant.signal.aborted).toBe(true);
  });

  it("revokes a panel, a renderer, and all remaining grants with abort", () => {
    const registry = createPluginPanelSdkAuthorityRegistry();
    const panel = registry.register(owned);
    registry.revokePanel("workspace-a", "hello-plugin", "main");
    expect(panel.signal.aborted).toBe(true);
    expect(() => authorize(registry)).toThrow(/active panel/i);

    const sender = registry.register({ ...owned, panelId: "sender" });
    registry.revokeSender(1);
    expect(sender.signal.aborted).toBe(true);

    const all = registry.register({ ...owned, panelId: "all" });
    registry.revokeAll();
    expect(all.signal.aborted).toBe(true);
  });
});
