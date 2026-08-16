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

// The section the caller hands in — in main, the web app's start lock, the
// same one a reopen queues on.
const runTeardown = (teardown: () => Promise<void>) => teardown();

describe("recoverConsumedWebAppCredential", () => {
  it("tells the page, then unpairs and releases the view in one section", async () => {
    const seen = trace();
    await recoverConsumedWebAppCredential({
      notifyFailed: () => seen.steps.push("notify"),
      withTeardownLock: async (teardown) => {
        seen.steps.push("enter");
        await teardown();
        seen.steps.push("leave");
      },
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
    //
    // MUTATION (unpair outside the section): a reopen queued on that same
    // lock runs while the unpair is still in flight, reads the plugin's
    // pre-unpair server state, and gets the doomed server's origin.
    expect(seen.steps).toEqual(["notify", "enter", "unpair", "stop", "leave"]);
    expect(seen.errors).toEqual([]);
  });

  it("still releases the view when the unpair fails", async () => {
    const seen = trace();
    const failure = new Error("plugin is stopping");
    await recoverConsumedWebAppCredential({
      notifyFailed: () => seen.steps.push("notify"),
      withTeardownLock: runTeardown,
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
        withTeardownLock: runTeardown,
        unpair: async () => {
          seen.steps.push("unpair");
        },
        stopView: () => Promise.reject(failure),
        onError: (stage, error) => seen.errors.push([stage, error]),
      }),
    ).resolves.toBeUndefined();

    expect(seen.errors).toEqual([["stop", failure]]);
  });

  it("notifies before it waits on anything, the section included", async () => {
    const notifyFailed = vi.fn();
    let enterTeardown = (): void => undefined;
    const recovery = recoverConsumedWebAppCredential({
      notifyFailed,
      // A section somebody else still holds — the state the start lock is in
      // whenever a stop or another start is already running for this web app.
      withTeardownLock: (teardown) =>
        new Promise<void>((resolve) => {
          enterTeardown = () => resolve(teardown());
        }),
      unpair: () => Promise.resolve(),
      stopView: () => Promise.resolve(),
      onError: () => undefined,
    });

    // MUTATION (notify inside the section, or after the teardown): a busy lock
    // or a plugin whose stop hangs leaves the tab painting an empty frame with
    // no error for the whole timeout.
    expect(notifyFailed).toHaveBeenCalledTimes(1);
    enterTeardown();
    await recovery;
  });
});
