import { describe, expect, it } from "vitest";
import { isPluginPanelIdentityLive } from "./pluginPanelSdkEvent";

describe("isPluginPanelIdentityLive", () => {
  it("is live only when the grant's signal, sender, generation, and spawn all still match", () => {
    const grant = { senderId: 1, generation: 2, spawnId: "spawn-1" };
    const currentPanel = { senderId: 1, generation: 2 };
    const live = new AbortController().signal;

    expect(
      isPluginPanelIdentityLive({
        signal: live,
        currentPanel,
        currentSpawnId: "spawn-1",
        grant,
      }),
    ).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    expect(
      isPluginPanelIdentityLive({
        signal: aborted.signal,
        currentPanel,
        currentSpawnId: "spawn-1",
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelIdentityLive({
        signal: live,
        currentPanel: undefined,
        currentSpawnId: "spawn-1",
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelIdentityLive({
        signal: live,
        currentPanel: { ...currentPanel, senderId: 2 },
        currentSpawnId: "spawn-1",
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelIdentityLive({
        signal: live,
        currentPanel: { ...currentPanel, generation: 3 },
        currentSpawnId: "spawn-1",
        grant,
      }),
    ).toBe(false);

    expect(
      isPluginPanelIdentityLive({
        signal: live,
        currentPanel,
        currentSpawnId: "spawn-2",
        grant,
      }),
    ).toBe(false);
  });
});
