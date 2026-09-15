import {getEventListeners} from "node:events";
import {describe, expect, it} from "vitest";
import {liveHostSignal, withLiveHostSignal} from "./liveHostSignal";

describe("live host cancellation lifetime", () => {
  it.each([false, true])("releases every request source after completion, failure=%s", async fail => {
    const host = new AbortController(), caller = new AbortController();
    for (let i = 0; i < 100; i++) {
      const operation = withLiveHostSignal(host.signal, caller.signal, async signal => {
        expect(signal.aborted).toBe(false);
        expect(getEventListeners(host.signal, "abort")).toHaveLength(1);
        if (fail) throw new Error("operation failed");
        return i;
      });
      if (fail) await expect(operation).rejects.toThrow("operation failed");
      else await expect(operation).resolves.toBe(i);
      expect(getEventListeners(host.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    }
  });

  it.each(["host", "caller"] as const)("forwards %s cancellation and preserves its reason", async source => {
    const controllers = {host: new AbortController(), caller: new AbortController()};
    const reason = new Error(source);
    const operation = withLiveHostSignal(controllers.host.signal, controllers.caller.signal, signal =>
      new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true})));
    controllers[source].abort(reason);
    await expect(operation).rejects.toBe(reason);
    for (const controller of Object.values(controllers)) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("handles a previously cancelled caller without retaining the host", () => {
    const host = new AbortController(), caller = new AbortController();
    caller.abort("cancelled");
    const scope = liveHostSignal(host.signal, caller.signal);
    expect(scope.signal.reason).toBe("cancelled");
    expect(getEventListeners(host.signal, "abort")).toHaveLength(0);
  });

  it("retains cancellation for other operations when one finishes", async () => {
    const host = new AbortController(), first = new AbortController(), second = new AbortController();
    let release!: () => void;
    const pending = withLiveHostSignal(host.signal, second.signal, signal => new Promise<void>((resolve, reject) => {
      release = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }));
    await withLiveHostSignal(host.signal, first.signal, async () => undefined);
    expect(getEventListeners(host.signal, "abort")).toHaveLength(1);
    host.abort("host retired");
    await expect(pending).rejects.toBe("host retired");
    release();
    expect(getEventListeners(host.signal, "abort")).toHaveLength(0);
  });
});
