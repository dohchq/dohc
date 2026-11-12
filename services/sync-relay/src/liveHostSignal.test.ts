import {getEventListeners} from "node:events";
import {setFlagsFromString} from "node:v8";
import {runInNewContext} from "node:vm";
import {describe, expect, it} from "vitest";
import {liveHostSignal, withDeadline, withLiveHostSignal} from "./liveHostSignal";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

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

  it.each(["ends early", "completes"] as const)("holds no deadline signal over passes that %s", async shape => {
    const host = new AbortController(), connection = new AbortController(), signals: WeakRef<AbortSignal>[] = [], held: number[] = [];
    const pass = () => withDeadline(host.signal, 60_000, async signal => {
      signals.push(new WeakRef(signal));
      // A completing pass first runs work that listens to its signal directly.
      if (shape === "completes") await withLiveHostSignal(signal, new AbortController().signal, async () => undefined);
      // Hosted replication derives its own signal from the pass's.
      AbortSignal.any([connection.signal, signal]);
    });
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 50; i++) await pass();
      await new Promise(setImmediate); gc();
      held.push(signals.filter(signal => signal.deref() !== undefined).length);
    }
    expect(held).toEqual([0, 0]);
    expect(getEventListeners(host.signal, "abort")).toHaveLength(0);
  });

  it("aborts at the deadline with a timeout reason", async () => {
    const work = withDeadline(new AbortController().signal, 1, signal =>
      new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true})));
    await expect(work).rejects.toMatchObject({name: "TimeoutError"});
  });
});
