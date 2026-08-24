import { describe, expect, it, vi } from "vitest";
import { createPluginPanelFileWatchEmitter } from "./pluginPanelSdkEvent";

describe("createPluginPanelFileWatchEmitter", () => {
  it("drops events after the exact panel stops running", () => {
    let panelRunning = true;
    const send = vi.fn();
    const emitEvent = createPluginPanelFileWatchEmitter({
      workspaceId: "ws-plugins",
      pluginId: "sites",
      panelId: "main",
      isPanelRunning: () => panelRunning,
      send,
    });
    const data = { path: "docs/index.md", operation: "update" as const };

    emitEvent("subscription-1", "change", data);
    panelRunning = false;
    emitEvent("subscription-1", "change", data);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      workspaceId: "ws-plugins",
      pluginId: "sites",
      panelId: "main",
      subscriptionId: "subscription-1",
      event: "change",
      data,
    });
  });
});
