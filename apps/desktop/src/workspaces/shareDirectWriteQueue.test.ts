import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PushShareDirectWritesResult } from "../ipc/bridgeContract";
import { createShareDirectWriteQueue, DIRECT_WRITE_PUSH_DELAY_MS } from "./shareDirectWriteQueue";

const NOTHING: PushShareDirectWritesResult = { status: "pushed", writes: [] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const push = vi.fn<(workspaceId: string) => Promise<PushShareDirectWritesResult>>(async () => NOTHING);
  const report = vi.fn<(workspaceId: string, result: PushShareDirectWritesResult) => void>();
  return { push, report, queue: createShareDirectWriteQueue({ push, report }) };
}

it("pushes once per view after a burst of saves settles, and reports it", async () => {
  const f = fixture();
  f.queue.edited("a");
  f.queue.edited("b");
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.push.mock.calls).toEqual([["b"], ["a"]]);
  expect(f.report.mock.calls).toEqual([["b", NOTHING], ["a", NOTHING]]);
});

it("runs one push per view at a time, and one more after it for a request during it", async () => {
  const f = fixture();
  let finish!: (result: PushShareDirectWritesResult) => void;
  f.push.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const opened = f.queue.pushNow("a");
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.push).toHaveBeenCalledTimes(1);
  finish(NOTHING);
  await expect(opened).resolves.toEqual(NOTHING);
  await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(2));
});

it("stops asking a relay that takes no direct writes, and turns a thrown push into a failure", async () => {
  const f = fixture();
  f.push.mockRejectedValueOnce(new Error("offline"));
  await expect(f.queue.pushNow("a")).resolves.toEqual({ status: "failed", writes: [], errorMessage: "offline", lasting: false });
  f.push.mockResolvedValueOnce({ status: "unavailable" });
  await expect(f.queue.pushNow("a")).resolves.toEqual({ status: "unavailable" });
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  await expect(f.queue.pushNow("a")).resolves.toEqual({ status: "unavailable" });
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.report).not.toHaveBeenCalled();
});
