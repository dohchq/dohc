import { describe, expect, it } from "vitest";
import {
  PluginWebAppViewRegistry,
  stopPluginWebAppGuests,
  type PluginWebAppViewRecord,
} from "./pluginWebAppViews";

function record(
  overrides: Partial<PluginWebAppViewRecord<string>> = {},
): PluginWebAppViewRecord<string> {
  return {
    workspaceId: "ws-1",
    pluginId: "t3-code",
    webAppId: "app",
    instanceKey: null,
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

// Two instances of one web app are two records under two keys. Everything the
// registry decides — which view a bounds update moves, which one a stop
// removes, how many are live — has to tell them apart.
describe("PluginWebAppViewRegistry across instances", () => {
  const first = record({ instanceKey: "sites/a", view: "view-a" });
  const second = record({ instanceKey: "sites/b", view: "view-b" });

  function twoInstances(): PluginWebAppViewRegistry<string> {
    const registry = new PluginWebAppViewRegistry<string>();
    registry.register(first);
    registry.register(second);
    return registry;
  }

  // MUTATION (leave instanceKey out of viewKey): the second instance would
  // displace the first, so opening a second preview would destroy the first
  // one's view and both tabs would fight over one guest.
  it("holds two instances of one web app at once", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    expect(registry.register(first)).toBeNull();
    expect(registry.register(second)).toBeNull();
    expect(registry.get(first)?.view).toBe("view-a");
    expect(registry.get(second)?.view).toBe("view-b");
  });

  // MUTATION (ignore instanceKey when authorizing bounds): one tab's resize
  // would move a sibling instance's guest over the wrong tab.
  it("never moves one instance's view for another instance's bounds", () => {
    const registry = twoInstances();
    expect(
      registry.authorizeBounds({ ...first, senderId: 7, generation: 1 })?.view,
    ).toBe("view-a");
    expect(
      registry.authorizeBounds({ ...second, senderId: 7, generation: 1 })?.view,
    ).toBe("view-b");
  });

  it("never confuses an instance with the single-tab app of the same id", () => {
    const registry = twoInstances();
    registry.register(record({ instanceKey: null, view: "view-single" }));
    expect(registry.get(record({ instanceKey: null }))?.view).toBe(
      "view-single",
    );
    expect(registry.get(first)?.view).toBe("view-a");
  });

  // MUTATION (remove by web app id): closing one preview tab would take every
  // other preview of the same plugin down with it.
  it("removes one instance and leaves its siblings running", () => {
    const registry = twoInstances();
    expect(registry.remove(first)?.view).toBe("view-a");
    expect(registry.get(first)).toBeNull();
    expect(registry.get(second)?.view).toBe("view-b");
  });

  it("still tears every instance down for a plugin, workspace, or sender", () => {
    expect(twoInstances().removeForPlugin("ws-1", "t3-code")).toHaveLength(2);
    expect(twoInstances().removeForWorkspace("ws-1")).toHaveLength(2);
    expect(twoInstances().removeForSender(7)).toHaveLength(2);
    expect(twoInstances().hasForPlugin("ws-1", "t3-code")).toBe(true);
  });

  describe("countOtherInstances", () => {
    it("counts the live siblings of an instance that is not open yet", () => {
      const registry = twoInstances();
      expect(
        registry.countOtherInstances(record({ instanceKey: "sites/c" })),
      ).toBe(2);
    });

    // MUTATION (count every record, this one included): reopening an instance
    // that is already open would spend a budget slot it already holds, so the
    // last allowed instance could never restart.
    it("does not count the instance that is about to replace itself", () => {
      expect(twoInstances().countOtherInstances(first)).toBe(1);
    });

    it("counts only the same web app, in the same workspace and plugin", () => {
      const registry = twoInstances();
      registry.register(record({ webAppId: "other", instanceKey: "sites/a" }));
      registry.register(record({ workspaceId: "ws-2", instanceKey: "sites/a" }));
      registry.register(record({ pluginId: "other", instanceKey: "sites/a" }));
      expect(
        registry.countOtherInstances(record({ instanceKey: "sites/c" })),
      ).toBe(2);
    });
  });
});

describe("PluginWebAppViewRegistry.all", () => {
  it("lists every live record and reflects removals", () => {
    const registry = new PluginWebAppViewRegistry<string>();
    registry.register(record({ view: "a" }));
    registry.register(record({ webAppId: "other", view: "b" }));
    expect(registry.all().map((entry) => entry.view).sort()).toEqual(["a", "b"]);

    registry.remove(record());
    // A removed guest must drop out, or a window-level effect (zoom) would
    // touch a destroyed view.
    expect(registry.all().map((entry) => entry.view)).toEqual(["b"]);
  });
});

describe("stopPluginWebAppGuests", () => {
  // MUTATION (an early throw skips destruction): a renderer dying between
  // notifying record 1 and record 2 must not leave every guest — including
  // record 2's — attached to a server nothing will ever tear down again.
  it("notifies every record even when an earlier one throws, and always destroys", () => {
    const notified: number[] = [];
    const destroyed: number[][] = [];
    const errors: unknown[] = [];

    stopPluginWebAppGuests(
      [1, 2, 3],
      (id) => {
        notified.push(id);
        if (id === 1) throw new Error("renderer already gone");
      },
      (records) => destroyed.push([...records]),
      (id, error) => errors.push({ id, error }),
    );

    expect(notified).toEqual([1, 2, 3]);
    expect(destroyed).toEqual([[1, 2, 3]]);
    expect(errors).toEqual([{ id: 1, error: new Error("renderer already gone") }]);
  });

  it("still destroys every record when every notification throws", () => {
    const destroyed: number[][] = [];

    stopPluginWebAppGuests(
      [1, 2],
      () => {
        throw new Error("renderer already gone");
      },
      (records) => destroyed.push([...records]),
    );

    expect(destroyed).toEqual([[1, 2]]);
  });

  it("destroys an empty set without notifying anything", () => {
    const notify = () => {
      throw new Error("should never run");
    };
    const destroyed: number[][] = [];

    stopPluginWebAppGuests([], notify, (records) => destroyed.push([...records]));

    expect(destroyed).toEqual([[]]);
  });
});
