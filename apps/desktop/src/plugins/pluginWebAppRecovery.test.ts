import { describe, expect, it, vi } from "vitest";
import {
  recoverConsumedWebAppCredential,
  type WebAppRecoveryStage,
} from "./pluginWebAppRecovery";

function trace(): {
  steps: string[];
  errors: [WebAppRecoveryStage, unknown][];
} {
  return { steps: [], errors: [] };
}

describe("recoverConsumedWebAppCredential", () => {
  it("tells the page, unpairs the plugin, then releases the view", async () => {
    const seen = trace();
    await recoverConsumedWebAppCredential({
      notifyFailed: () => seen.steps.push("notify"),
      unpair: async () => {
        seen.steps.push("unpair");
      },
      stopView: async () => {
        seen.steps.push("stop");
      },
      onError: (stage, error) => seen.errors.push([stage, error]),
    });

    // MUTATION (drop the unpair): stopping the view unpairs nothing on a
    // workspace-started host — it stops that host only when an on-demand open
    // is the reason it runs — so the plugin's server stays paired to a guest
    // that never arrived. Order matters twice: the page must leave its ready
    // state even if a teardown hangs, and the unpair needs the plugin's
    // transport, which the view stop may take away.
    expect(seen.steps).toEqual(["notify", "unpair", "stop"]);
    expect(seen.errors).toEqual([]);
  });

  it("still releases the view when the unpair fails", async () => {
    const seen = trace();
    const failure = new Error("plugin is stopping");
    await recoverConsumedWebAppCredential({
      notifyFailed: () => seen.steps.push("notify"),
      unpair: () => Promise.reject(failure),
      stopView: async () => {
        seen.steps.push("stop");
      },
      onError: (stage, error) => seen.errors.push([stage, error]),
    });

    expect(seen.steps).toEqual(["notify", "stop"]);
    expect(seen.errors).toEqual([["unpair", failure]]);
  });

  it("reports a failed view stop instead of leaving it unhandled", async () => {
    const seen = trace();
    const failure = new Error("no such view");
    await expect(
      recoverConsumedWebAppCredential({
        notifyFailed: () => seen.steps.push("notify"),
        unpair: async () => {
          seen.steps.push("unpair");
        },
        stopView: () => Promise.reject(failure),
        onError: (stage, error) => seen.errors.push([stage, error]),
      }),
    ).resolves.toBeUndefined();

    expect(seen.errors).toEqual([["stop", failure]]);
  });

  it("notifies before it waits on anything", async () => {
    const notifyFailed = vi.fn();
    let releaseUnpair = (): void => undefined;
    const recovery = recoverConsumedWebAppCredential({
      notifyFailed,
      unpair: () =>
        new Promise<void>((resolve) => {
          releaseUnpair = resolve;
        }),
      stopView: () => Promise.resolve(),
      onError: () => undefined,
    });

    // MUTATION (notify after the teardown): a plugin whose stop hangs leaves
    // the tab painting an empty frame with no error for the whole timeout.
    expect(notifyFailed).toHaveBeenCalledTimes(1);
    releaseUnpair();
    await recovery;
  });
});
