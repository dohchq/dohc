import { describe, expect, it } from "vitest";
import {
  PluginWebAppViewRegistry,
  type PluginWebAppViewRecord,
} from "./pluginWebAppViews";

function record(
  overrides: Partial<PluginWebAppViewRecord<string>> = {},
): PluginWebAppViewRecord<string> {
  return {
    workspaceId: "ws-1",
    pluginId: "t3-code",
    webAppId: "app",
    senderId: 7,
    generation: 1,
    origin: "http://127.0.0.1:52835",
    partition: "persist:dohc-plugin-abc",
    view: "view-a",
    ...overrides,
  };
}

describe("PluginWebAppViewRegistry", () => {
  it("returns the displaced record when the same identity registers again", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    expect(registry.register(record({ view: "old" }))).toBeNull();
    const displaced = registry.register(record({ view: "new" }));
    expect(displaced?.view).toBe("old");
    expect(registry.get(record())?.view).toBe("new");
  });

  it("authorizes bounds only for the exact sender and generation", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    registry.register(record({ senderId: 7, generation: 2 }));

    expect(
      registry.authorizeBounds({
        ...record(),
        senderId: 7,
        generation: 2,
      }),
    ).not.toBeNull();
    // A stale generation — the renderer reloaded — must not move the view.
    expect(
      registry.authorizeBounds({
        ...record(),
        senderId: 7,
        generation: 1,
      }),
    ).toBeNull();
    // Another renderer must not move the view.
    expect(
      registry.authorizeBounds({
        ...record(),
        senderId: 8,
        generation: 2,
      }),
    ).toBeNull();
  });

  it("never authorizes bounds for a different workspace's identical tab", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    registry.register(record({ workspaceId: "ws-1" }));
    expect(
      registry.authorizeBounds({
        ...record(),
        workspaceId: "ws-2",
      }),
    ).toBeNull();
  });

  it("remove returns the record once and empties the slot", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    registry.register(record());
    expect(registry.remove(record())?.view).toBe("view-a");
    expect(registry.remove(record())).toBeNull();
    expect(registry.get(record())).toBeNull();
  });

  it("removes by workspace, by plugin, and by sender without touching others", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    registry.register(record({ workspaceId: "ws-1", pluginId: "a", view: "1" }));
    registry.register(record({ workspaceId: "ws-1", pluginId: "b", view: "2" }));
    registry.register(record({ workspaceId: "ws-2", pluginId: "a", view: "3", senderId: 9 }));

    expect(
      registry.removeForPlugin("ws-1", "a").map((entry) => entry.view),
    ).toEqual(["1"]);
    expect(
      registry.removeForWorkspace("ws-1").map((entry) => entry.view),
    ).toEqual(["2"]);
    expect(registry.removeForSender(9).map((entry) => entry.view)).toEqual(["3"]);
    expect(registry.removeAll()).toEqual([]);
  });

  it("reports whether a plugin still has any open view", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    expect(registry.hasForPlugin("ws-1", "t3-code")).toBe(false);
    registry.register(record());
    expect(registry.hasForPlugin("ws-1", "t3-code")).toBe(true);
    expect(registry.hasForPlugin("ws-1", "other")).toBe(false);
    registry.remove(record());
    expect(registry.hasForPlugin("ws-1", "t3-code")).toBe(false);
  });
});
