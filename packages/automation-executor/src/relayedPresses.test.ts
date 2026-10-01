import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayAutomationPress } from "@dohc/workspace-contracts/relay";
import {
  createRelayedPressHost,
  type PressTransport,
  type RelayedPressHost,
  type RelayedPressHostOptions,
} from "./relayedPresses";

const hosts: RelayedPressHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
  vi.useRealTimers();
});

function channel<A>() {
  const queued: A[] = [];
  const waiters: Array<(value: A) => void> = [];
  return {
    send(value: A) {
      const resolve = waiters.shift();
      if (resolve) resolve(value);
      else queued.push(value);
    },
    next(): Promise<A> {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function hostWith(relay: Omit<PressTransport, "inspections" | "answerInspection"> & Partial<Pick<PressTransport, "inspections" | "answerInspection">>, overrides: Partial<RelayedPressHostOptions> = {}) {
  const host = createRelayedPressHost({
    workspaceId: "ws-1",
    host: {
      runsHere: async () => true,
      stillRuns: () => true,
      generation: () => 7,
      hold: () => () => undefined,
    },
    transport: async () => ({ inspections: () => [], answerInspection: async () => undefined, ...relay }),
    heldClaim: async () => null,
    inspect: async () => ({ kind: "unchecked", reason: "not ready" }),
    press: async () => ({ pressed: { busy: true }, field: null }),
    notifyFailure: async () => undefined,
    onError: () => undefined,
    ...overrides,
  });
  hosts.push(host);
  return host;
}

const pendingPress: RelayAutomationPress = {
  hostPressId: "p1", definitionHash: "0123456789abcdef", state: "pending",
  automationId: "collection:Invoices#paid", collectionPath: "Invoices",
  recordId: "rec-12", pressedBy: "ana", createdAtMs: 1, confirmed: [],
};

describe("relay polling lifetime", () => {
  it("clears the default retry timer when stopped during backoff", async () => {
    vi.useFakeTimers();
    const errors = channel<unknown>();
    const failure = new Error("relay offline");
    const list = vi.fn(async () => { throw failure; });
    const host = hostWith({ list, accept: async () => [], settle: async () => undefined }, {
      onError: (_context, error) => errors.send(error),
    });
    host.start();
    expect(await errors.next()).toBe(failure);
    expect(vi.getTimerCount()).toBe(1);
    host.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("caps exponential retries and resets the delay after a successful list", async () => {
    const delays = channel<{ ms: number; finish: () => void }>();
    let listCalls = 0;
    const host = hostWith({
      list: async () => {
        listCalls += 1;
        if (listCalls === 8) return [];
        throw "offline";
      },
      accept: async () => [], settle: async () => undefined,
    }, {
      delay: (ms) => new Promise((resolve) => delays.send({ ms, finish: resolve })),
    });
    host.start();
    for (const ms of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const delayed = await delays.next();
      expect(delayed.ms).toBe(ms);
      delayed.finish();
    }
    const reset = await delays.next();
    expect(listCalls).toBe(9);
    expect(reset.ms).toBe(2_000);
  });

  it("aborts an injected retry wait and starts a fresh lifetime immediately", async () => {
    const delays = channel<AbortSignal>();
    const aborted = channel<void>();
    const errors = channel<unknown>();
    const failure = { status: 503 };
    const list = vi.fn(async () => { throw failure; });
    const host = hostWith({ list, accept: async () => [], settle: async () => undefined }, {
      onError: (_context, error) => errors.send(error),
      delay: (_ms, signal) => new Promise((resolve) => {
        delays.send(signal);
        signal.addEventListener("abort", () => { aborted.send(); resolve(); }, { once: true });
      }),
    });
    host.start();
    const first = await delays.next();
    expect(await errors.next()).toBe(failure);
    host.stop();
    expect(first.aborted).toBe(true);
    await aborted.next();
    host.start();
    const second = await delays.next();
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("takes nothing when stopped after a list resolves but before acceptance", async () => {
    const polls = channel<(presses: RelayAutomationPress[]) => void>();
    const accept = vi.fn(async () => ["p1"]);
    const press = vi.fn(async () => ({ pressed: { busy: true } as const, field: null }));
    const host = hostWith({
      list: () => new Promise<RelayAutomationPress[]>((resolve) => polls.send(resolve)),
      accept, settle: async () => undefined,
    }, { press });
    host.start();
    const answer = await polls.next();
    answer([pendingPress]);
    host.stop();
    host.start();
    await polls.next();
    await setImmediate();
    expect(accept).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it("keeps one poll per start and never lets an old completion clear the new lifetime", async () => {
    const polls = channel<{ signal: AbortSignal; finish: (presses: RelayAutomationPress[]) => void }>();
    const list = vi.fn((signal: AbortSignal) => new Promise<RelayAutomationPress[]>((resolve) => {
      polls.send({ signal, finish: resolve });
    }));
    const host = hostWith({ list, accept: async () => [], settle: async () => undefined });
    host.start();
    host.start();
    const first = await polls.next();
    await setImmediate();
    expect(list).toHaveBeenCalledTimes(1);
    host.stop();
    expect(first.signal.aborted).toBe(true);
    host.start();
    const second = await polls.next();
    first.finish([pendingPress]);
    await setImmediate();
    host.start();
    await setImmediate();
    expect(list).toHaveBeenCalledTimes(2);
    host.stop();
    expect(second.signal.aborted).toBe(true);
    host.start();
    const third = await polls.next();
    await setImmediate();
    expect(third.signal.aborted).toBe(false);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("finishes acceptance and pressing under the hold after stop without taking the next press", async () => {
    const acceptStarted = channel<void>();
    const accepting = Promise.withResolvers<string[]>();
    const pressed = channel<void>();
    const released = channel<void>();
    let holds = 0;
    const accept = vi.fn(() => { acceptStarted.send(); return accepting.promise; });
    const press = vi.fn(async () => {
      pressed.send();
      return { pressed: { busy: true } as const, field: "Paid" };
    });
    const settle = vi.fn(async () => undefined);
    const host = hostWith({
      list: async () => [pendingPress, { ...pendingPress, hostPressId: "p2" }],
      accept, settle,
    }, {
      host: {
        runsHere: async () => true, stillRuns: () => true, generation: () => 7,
        hold: () => {
          holds += 1;
          return () => { holds -= 1; released.send(); };
        },
      },
      press,
    });
    host.start();
    await acceptStarted.next();
    host.stop();
    expect(holds).toBe(1);
    accepting.resolve(["p1"]);
    await pressed.next();
    await released.next();
    await setImmediate();
    expect(holds).toBe(0);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({ hostPressId: "p1", outcome: "busy", error: null });
  });

  it("does not list after stopping during the final unsent settlement", async () => {
    const settling = Promise.withResolvers<void>();
    const settlementStarted = channel<void>();
    const list = vi.fn(async () => [pendingPress]);
    let settleCalls = 0;
    const settle = vi.fn(async () => {
      settleCalls += 1;
      if (settleCalls === 1) throw new Error("relay offline");
      settlementStarted.send();
      await settling.promise;
    });
    const host = hostWith({ list, accept: async () => ["p1"], settle });
    host.start();
    await settlementStarted.next();
    expect(settle).toHaveBeenCalledTimes(2);
    host.stop();
    settling.resolve();
    await setImmediate();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("finishes a started inspection after stop without inspecting or pressing the next request", async () => {
    const started = channel<void>();
    const answered = channel<void>();
    const inspection = Promise.withResolvers<{ kind: "unchecked"; reason: string }>();
    const inspect = vi.fn(() => { started.send(); return inspection.promise; });
    const answerInspection = vi.fn(async () => { answered.send(); });
    const accept = vi.fn(async () => []);
    const host = hostWith({
      list: async () => [pendingPress], accept, settle: async () => undefined,
      inspections: () => [{ ...pendingPress, inspectionId: "i1" }, { ...pendingPress, inspectionId: "i2" }],
      answerInspection,
    }, { inspect });
    host.start();
    await started.next();
    host.stop();
    inspection.resolve({ kind: "unchecked", reason: "not ready" });
    await answered.next();
    await setImmediate();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(answerInspection).toHaveBeenCalledWith(7, "i1", { kind: "unchecked", reason: "not ready" });
    expect(accept).not.toHaveBeenCalled();
  });
});
