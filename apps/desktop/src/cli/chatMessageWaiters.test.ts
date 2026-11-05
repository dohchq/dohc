import { describe, expect, it, vi } from "vitest";
import { ChatMessageWaiters } from "./chatMessageWaiters";

function fixture(limit = 2) {
  const listeners = new Set<() => void>();
  const waiters = new ChatMessageWaiters(limit);
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return { waiters, listeners, subscribe, write: () => { for (const listener of listeners) listener(); } };
}

const empty = { messages: [] as string[], cursor: "cursor" };

describe("chat message waits", () => {
  it("returns an existing batch and releases its subscription", async () => {
    const f = fixture();
    const batch = { messages: ["message"], cursor: "next" };
    expect(await f.waiters.wait({ subscribe: f.subscribe, query: async () => batch, empty, timeoutMs: 25_000 })).toEqual(batch);
    expect(f.listeners.size).toBe(0);
    expect(f.waiters.size).toBe(0);
  });

  it("queries once before a zero-timeout result", async () => {
    const f = fixture();
    const result = Promise.withResolvers<{ messages: string[]; cursor: string }>();
    const pending = f.waiters.wait({ subscribe: f.subscribe, query: () => result.promise, empty, timeoutMs: 0 });
    result.resolve({ messages: ["message"], cursor: "next" });
    expect((await pending).messages).toEqual(["message"]);
    expect(f.waiters.size).toBe(0);
  });

  it("wakes on a write, including a write during the first query", async () => {
    const f = fixture();
    let release!: (value: typeof empty) => void;
    const queried = Promise.withResolvers<void>();
    let calls = 0;
    const pending = f.waiters.wait({ subscribe: f.subscribe, empty, timeoutMs: 25_000, query: async () => {
      if (++calls === 1) { queried.resolve(); return new Promise<typeof empty>(resolve => { release = resolve; }); }
      return { messages: ["message"], cursor: "next" };
    } });
    await queried.promise;
    f.write();
    release(empty);
    expect((await pending).messages).toEqual(["message"]);
    expect(calls).toBe(2);
    expect(f.listeners.size).toBe(0);
  });

  it("returns an empty batch at the timeout without querying on a timer", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const query = vi.fn(async () => empty);
      const pending = f.waiters.wait({ subscribe: f.subscribe, query, empty, timeoutMs: 25_000 });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await pending).toEqual(empty);
      expect(query).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(0);
      expect(f.waiters.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([0, 25_000])("returns the latest empty cursor with timeout %i", async timeoutMs => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const compacted = { messages: [] as string[], cursor: "compacted" };
      const query = vi.fn(async () => compacted);
      const pending = f.waiters.wait({ subscribe: f.subscribe, query, empty, timeoutMs });
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(await pending).toEqual(compacted);
      expect(query).toHaveBeenCalledOnce();
      expect(f.listeners.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("releases disconnected and retired workspaces", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.waiters.wait({ subscribe: f.subscribe, query: async () => empty, empty, timeoutMs: 25_000, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
    expect(f.listeners.size).toBe(0);
    expect(f.waiters.size).toBe(0);
  });

  it("bounds waits and releases the slot on cancellation", async () => {
    const f = fixture(1);
    const controller = new AbortController();
    const pending = f.waiters.wait({ subscribe: f.subscribe, query: async () => empty, empty, timeoutMs: 25_000, signal: controller.signal });
    await expect(f.waiters.wait({ subscribe: f.subscribe, query: async () => empty, empty, timeoutMs: 25_000 })).rejects.toThrow("Too many");
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(await f.waiters.wait({ subscribe: f.subscribe, query: async () => ({ messages: ["message"], cursor: "next" }), empty, timeoutMs: 25_000 })).toMatchObject({ messages: ["message"] });
  });

  it("cancels every wait on shutdown", async () => {
    const f = fixture();
    const pending = f.waiters.wait({ subscribe: f.subscribe, query: async () => empty, empty, timeoutMs: 25_000 });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    f.waiters.close();
    await rejected;
    expect(f.listeners.size).toBe(0);
    await expect(f.waiters.wait({ subscribe: f.subscribe, query: async () => empty, empty, timeoutMs: 25_000 })).rejects.toThrow("closed");
  });
});
