import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PushShareDirectWritesResult } from "../ipc/bridgeContract";
import { createShareDirectWriteQueue, DIRECT_WRITE_PUSH_DELAY_MS } from "./shareDirectWriteQueue";

const NOTHING: PushShareDirectWritesResult = { status: "pushed", writes: [] };
const REFUSED: PushShareDirectWritesResult = {
  status: "pushed",
  writes: [{ result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" }],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const push = vi.fn<(workspaceId: string) => Promise<PushShareDirectWritesResult>>(async () => REFUSED);
  let shown = true;
  const report = vi.fn<(workspaceId: string, result: PushShareDirectWritesResult) => boolean>(() => shown);
  return { push, report, queue: createShareDirectWriteQueue({ push, report }), hide: (value: boolean) => { shown = !value; } };
}

it("pushes once per view after a burst of saves settles, and reports it", async () => {
  const f = fixture();
  f.queue.edited("a");
  f.queue.edited("b");
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.push.mock.calls).toEqual([["b"], ["a"]]);
  expect(f.report.mock.calls).toEqual([["b", REFUSED], ["a", REFUSED]]);
});

it("reports nothing when every write went", async () => {
  const f = fixture();
  f.push.mockResolvedValueOnce(NOTHING);
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.push).toHaveBeenCalledTimes(1);
  expect(f.report).not.toHaveBeenCalled();
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

it("sends a save waiting for its delay with a push on open", async () => {
  const f = fixture();
  f.queue.edited("a");
  await expect(f.queue.pushNow("a")).resolves.toEqual(REFUSED);
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.push).toHaveBeenCalledTimes(1);
});

it("holds an answer no window showed until the view opens again", async () => {
  const f = fixture();
  f.hide(true);
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.report).toHaveBeenCalledTimes(1);
  f.hide(false);
  f.push.mockResolvedValueOnce(NOTHING);
  await expect(f.queue.pushNow("a")).resolves.toEqual(NOTHING);
  expect(f.report.mock.calls).toEqual([["a", REFUSED], ["a", REFUSED]]);
  // Shown once, it is not held again.
  f.push.mockResolvedValueOnce(NOTHING);
  await f.queue.pushNow("a");
  expect(f.report).toHaveBeenCalledTimes(2);
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
