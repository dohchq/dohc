import { afterEach, expect, it, vi } from "vitest";
import { createReplicaReadPool } from "./replica-read-pool.js";

afterEach(() => vi.useRealTimers());

it("reuses idle workers, caps busy workers, and closes the oldest idle worker before replacement", async () => {
  const pool = createReplicaReadPool(2), a = Symbol(), b = Symbol(), c = Symbol();
  const first = { close: vi.fn(async () => {}) }, second = { close: vi.fn(async () => {}) }, third = { close: vi.fn(async () => {}) };
  const open = vi.fn(async () => first);
  const one = await pool.acquire(a, open), two = await pool.acquire(b, async () => second);
  await expect(pool.acquire(c, async () => third)).rejects.toThrow("busy");
  one.release();
  const again = await pool.acquire(a, open); expect(open).toHaveBeenCalledOnce(); again.release();
  const next = await pool.acquire(c, async () => { expect(first.close).toHaveBeenCalledOnce(); return third; });
  expect(second.close).not.toHaveBeenCalled();
  two.release(); next.release(); await pool.invalidate(b); await pool.invalidate(c);
});

it("evicts inactive workers after a finite idle interval", async () => {
  vi.useFakeTimers();
  const pool = createReplicaReadPool(1, 60_000), key = Symbol(), worker = { close: vi.fn(async () => {}) }, open = vi.fn(async () => worker);
  const lease = await pool.acquire(key, open);
  await vi.advanceTimersByTimeAsync(120_000); expect(worker.close).not.toHaveBeenCalled();
  lease.release();
  await vi.advanceTimersByTimeAsync(59_999); expect(worker.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(worker.close).toHaveBeenCalledOnce();
  const next = await pool.acquire(key, open); expect(open).toHaveBeenCalledTimes(2);
  next.release(); await pool.invalidate(key);
});

it("does not open a replacement until the previous worker exits", async () => {
  const pool = createReplicaReadPool(1), a = Symbol(), b = Symbol();
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const one = await pool.acquire(a, async () => ({ close: () => stopped })); one.release();
  const open = vi.fn(async () => ({ close: async () => {} }));
  const next = pool.acquire(b, open);
  await Promise.resolve(); await Promise.resolve(); expect(open).not.toHaveBeenCalled();
  finish(); (await next).release(); await pool.invalidate(b);
});
