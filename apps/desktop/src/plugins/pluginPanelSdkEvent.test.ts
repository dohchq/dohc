import { describe, expect, it } from "vitest";
import {
  isPluginPanelPushLive,
  isPluginPanelRequestLive,
} from "./pluginPanelSdkEvent";

describe("isPluginPanelPushLive", () => {
  it("requires the live granted panel but not the original plugin spawn", () => {
    const grant = { senderId: 1, generation: 2, spawnId: "spawn-1" };
    const currentPanel = { senderId: 1, generation: 2 };
    const live = new AbortController().signal;

    expect(
      isPluginPanelPushLive({
        signal: live,
        currentPanel,
        grant,
      }),
    ).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    expect(
      isPluginPanelPushLive({
        signal: aborted.signal,
        currentPanel,
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelPushLive({
        signal: live,
        currentPanel: undefined,
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelPushLive({
        signal: live,
        currentPanel: { ...currentPanel, senderId: 2 },
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelPushLive({
        signal: live,
        currentPanel: { ...currentPanel, generation: 3 },
        grant,
      }),
    ).toBe(false);

    const currentSpawnId = "spawn-2";
    expect(currentSpawnId).not.toBe(grant.spawnId);
    expect(
      isPluginPanelPushLive({
        signal: live,
        currentPanel,
        grant,
      }),
    ).toBe(true);
  });
});

describe("isPluginPanelRequestLive", () => {
  it("requires the current panel and a live plugin spawn", () => {
    const currentPanel = { senderId: 1, generation: 2 };

    expect(
      isPluginPanelRequestLive({
        currentPanel,
        senderId: 1,
        generation: 2,
        liveSpawnId: "spawn-2",
      }),
    ).toBe(true);
    expect(
      isPluginPanelRequestLive({
        currentPanel: undefined,
        senderId: 1,
        generation: 2,
        liveSpawnId: "spawn-2",
      }),
    ).toBe(false);
    expect(
      isPluginPanelRequestLive({
        currentPanel,
        senderId: 2,
        generation: 2,
        liveSpawnId: "spawn-2",
      }),
    ).toBe(false);
    expect(
      isPluginPanelRequestLive({
        currentPanel,
        senderId: 1,
        generation: 3,
        liveSpawnId: "spawn-2",
      }),
    ).toBe(false);
    expect(
      isPluginPanelRequestLive({
        currentPanel,
        senderId: 1,
        generation: 2,
        liveSpawnId: undefined,
      }),
    ).toBe(false);
  });
});
