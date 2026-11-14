// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AgentThreadLine, AgentThreadLinesEvent } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { createAgentThreadLinesStore } from "./agentThreadLines";

const line = (state: AgentThreadLine["state"], chatThreadId = "thread-1"): AgentThreadLine => ({
  agentId: "nova",
  chatThreadId,
  forwardedAtMs: 0,
  state,
  sinceMs: 1_000,
});

function stubDesktop() {
  const listeners = new Set<(event: AgentThreadLinesEvent) => void>();
  const reads: Array<ReturnType<typeof deferred<AgentThreadLinesEvent>>> = [];
  const order: string[] = [];
  const desktop = {
    readAgentThreadLines: vi.fn((_input: { workspaceId: string }) => {
      order.push("read");
      const read = deferred<AgentThreadLinesEvent>();
      reads.push(read);
      return read.promise;
    }),
    onAgentThreadLines: vi.fn((listener: (event: AgentThreadLinesEvent) => void) => {
      order.push("listen");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  vi.stubGlobal("dohcDesktop", desktop);
  return {
    desktop,
    listeners,
    reads,
    order,
    push: (event: AgentThreadLinesEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("listens before it reads, reads once, and keeps no timer", async () => {
  vi.useFakeTimers();
  const { desktop, order, reads, push } = stubDesktop();
  const store = createAgentThreadLinesStore("ws-a", vi.fn());
  expect(desktop.onAgentThreadLines).not.toHaveBeenCalled();
  const changed = vi.fn();
  store.subscribe(changed);
  store.subscribe(vi.fn());
  expect(order).toEqual(["listen", "read"]);
  expect(desktop.readAgentThreadLines).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });

  reads[0]!.resolve({ workspaceId: "ws-a", revision: 1, lines: [line("in-line")] });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.lines()).toEqual([line("in-line")]);
  push({ workspaceId: "ws-a", revision: 2, lines: [line("working")] });
  expect(store.lines()).toEqual([line("working")]);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("drops an older revision and another workspace's event", () => {
  const { push } = stubDesktop();
  const store = createAgentThreadLinesStore("ws-a", vi.fn());
  const changed = vi.fn();
  store.subscribe(changed);
  push({ workspaceId: "ws-a", revision: 4, lines: [line("working")] });
  push({ workspaceId: "ws-a", revision: 3, lines: [line("in-line")] });
  push({ workspaceId: "ws-a", revision: 4, lines: [line("silent")] });
  push({ workspaceId: "ws-b", revision: 9, lines: [line("waiting-in-tool")] });
  expect(store.lines()).toEqual([line("working")]);
  expect(changed).toHaveBeenCalledOnce();
  push({ workspaceId: "ws-a", revision: 5, lines: [] });
  expect(store.lines()).toEqual([]);
});

it("keeps a newer event over a slow first read", async () => {
  const { reads, push } = stubDesktop();
  const store = createAgentThreadLinesStore("ws-a", vi.fn());
  store.subscribe(vi.fn());
  push({ workspaceId: "ws-a", revision: 7, lines: [line("working")] });
  reads[0]!.resolve({ workspaceId: "ws-a", revision: 6, lines: [line("in-line")] });
  await Promise.resolve();
  expect(store.lines()).toEqual([line("working")]);
});

it("tells nobody when nothing is in line before or after", async () => {
  const { reads } = stubDesktop();
  const store = createAgentThreadLinesStore("ws-a", vi.fn());
  const changed = vi.fn();
  store.subscribe(changed);
  const before = store.lines();
  reads[0]!.resolve({ workspaceId: "ws-a", revision: 1, lines: [] });
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
  expect(store.lines()).toBe(before);
});

it("stops listening with its last listener, and reads again when shown again", () => {
  const { desktop, listeners } = stubDesktop();
  const store = createAgentThreadLinesStore("ws-a", vi.fn());
  const first = store.subscribe(vi.fn());
  const second = store.subscribe(vi.fn());
  first();
  expect(listeners.size).toBe(1);
  second();
  expect(listeners.size).toBe(0);
  store.subscribe(vi.fn());
  expect(listeners.size).toBe(1);
  expect(desktop.readAgentThreadLines).toHaveBeenCalledTimes(2);
});

it("reports a failed read with a retry while it listens, and not after", async () => {
  const { desktop, reads } = stubDesktop();
  const onReadError = vi.fn();
  const store = createAgentThreadLinesStore("ws-a", onReadError);
  const stop = store.subscribe(vi.fn());
  const failure = new Error("main refused");
  reads[0]!.reject(failure);
  await vi.waitFor(() => expect(onReadError).toHaveBeenCalledOnce());
  const [cause, retry] = onReadError.mock.calls[0] as [unknown, () => void];
  expect(cause).toBe(failure);
  retry();
  reads[1]!.resolve({ workspaceId: "ws-a", revision: 2, lines: [line("silent")] });
  await vi.waitFor(() => expect(store.lines()).toEqual([line("silent")]));

  stop();
  retry();
  expect(desktop.readAgentThreadLines).toHaveBeenCalledTimes(2);
  const late = createAgentThreadLinesStore("ws-a", onReadError);
  const stopLate = late.subscribe(vi.fn());
  stopLate();
  reads[2]!.reject(failure);
  await Promise.resolve();
  await Promise.resolve();
  expect(onReadError).toHaveBeenCalledOnce();
});

it("says nothing of a read that failed for an earlier time it listened", async () => {
  const { reads } = stubDesktop();
  const failures: unknown[] = [];
  const store = createAgentThreadLinesStore("ws-a", (error) => void failures.push(error));

  const stopFirst = store.subscribe(() => undefined);
  stopFirst();
  const stopSecond = store.subscribe(() => undefined);
  // The second read answers, and then the first one fails.
  reads[1]!.resolve({ workspaceId: "ws-a", revision: 1, lines: [line("working")] });
  await reads[1]!.promise;
  reads[0]!.reject(new Error("the first read failed"));
  await reads[0]!.promise.catch(() => undefined);
  await Promise.resolve();

  expect(failures).toEqual([]);
  expect(store.lines()).toEqual([line("working")]);

  // A read that fails for the time it listens now is still reported.
  stopSecond();
  store.subscribe(() => undefined);
  const failed = new Error("the third read failed");
  reads[2]!.reject(failed);
  await reads[2]!.promise.catch(() => undefined);
  await Promise.resolve();
  expect(failures).toEqual([failed]);
});
