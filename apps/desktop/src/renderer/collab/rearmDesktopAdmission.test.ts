import {expect, it, vi} from "vitest";
import {rearmDesktopAdmission} from "./rearmDesktopAdmission";

it("re-arms unavailable and timed-out waits with bounded exponential backoff", async () => {
  vi.useFakeTimers();
  const cancel = new AbortController(), ready = vi.fn();
  const wait = vi.fn().mockResolvedValue(false);
  try {
    const running = rearmDesktopAdmission({signal: cancel.signal, wait, ready});
    await vi.advanceTimersByTimeAsync(0);
    expect(wait).toHaveBeenCalledTimes(1);
    for (const [delay, count] of [[1000, 2], [2000, 3], [4000, 4], [8000, 5], [16000, 6], [30000, 7], [30000, 8]] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(wait).toHaveBeenCalledTimes(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wait).toHaveBeenCalledTimes(count);
    }
    wait.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await running;
    expect(ready).toHaveBeenCalledOnce();
  } finally { cancel.abort(); vi.useRealTimers(); }
});

it("cancels backoff and ignores late readiness after the editor stops waiting", async () => {
  vi.useFakeTimers();
  const cancel = new AbortController(), ready = vi.fn();
  const wait = vi.fn().mockRejectedValue(new Error("unavailable"));
  try {
    const running = rearmDesktopAdmission({signal: cancel.signal, wait, ready});
    await vi.advanceTimersByTimeAsync(0);
    cancel.abort(); await running;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
    const late = new AbortController();
    let resolve!: (ready: boolean) => void;
    const pending = rearmDesktopAdmission({signal: late.signal, wait: () => new Promise(done => {resolve = done;}), ready});
    late.abort(); resolve(true); await pending;
    expect(ready).not.toHaveBeenCalled();
  } finally { cancel.abort(); vi.useRealTimers(); }
});
