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

it("refreshes delivery status for acceptance and offline failure", async () => {
  const settled = vi.fn(), push = vi.fn(async (): Promise<PushShareDirectWritesResult> => ({ status: "pushed", writes: [{ result: "written", paths: ["Tasks/automations.yaml"] }] }));
  const queue = createShareDirectWriteQueue({ push, report: () => true, settled });
  await queue.pushNow("a");
  expect(settled).toHaveBeenCalledWith("a");
  push.mockRejectedValueOnce(new Error("offline"));
  await queue.pushNow("a");
  expect(settled).toHaveBeenCalledTimes(2);
});

it("does not refresh definitions after an empty mount poll", async () => {
  const settled = vi.fn();
  const queue = createShareDirectWriteQueue({ push: async () => NOTHING, report: () => true, settled });
  await queue.pushNow("a");
  expect(settled).not.toHaveBeenCalled();
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
  await expect(opened).resolves.toBeUndefined();
  await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(2));
});

it("sends a save waiting for its delay with a push on open", async () => {
  const f = fixture();
  f.queue.edited("a");
  await expect(f.queue.pushNow("a")).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  expect(f.push).toHaveBeenCalledTimes(1);
});

it("reports a push joined by a draft retry even when its caller ignores the result", async () => {
  const f = fixture();
  let finish!: (result: PushShareDirectWritesResult) => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.queue.edited("a");
  await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  const opened = f.queue.pushNow("a");
  f.push.mockResolvedValueOnce(NOTHING);
  finish(REFUSED);
  await opened;
  await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(2));
  expect(f.report).toHaveBeenCalledExactlyOnceWith("a", REFUSED);
});

it("reports a background push once when several delayed saves join it", async () => {
  const f = fixture();
  let finish!: (result: PushShareDirectWritesResult) => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  for (let save = 0; save < 3; save += 1) {
    f.queue.edited("a");
    await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  }
  f.push.mockResolvedValueOnce(NOTHING);
  finish(REFUSED);
  await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(2));
  expect(f.report).toHaveBeenCalledExactlyOnceWith("a", REFUSED);
});

it("reports each push once and gives concurrent callers only completion", async () => {
  const f = fixture();
  let finish!: (result: PushShareDirectWritesResult) => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = f.queue.pushNow("a"), second = f.queue.pushNow("a");
  f.push.mockResolvedValueOnce(NOTHING);
  finish(REFUSED);
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  expect(f.report).toHaveBeenCalledExactlyOnceWith("a", REFUSED);
});

it("asks again after an ended share's answer, and turns a thrown push into a failure", async () => {
  const f = fixture();
  f.push.mockRejectedValueOnce(new Error("offline"));
  await expect(f.queue.pushNow("a")).resolves.toBeUndefined();
  expect(f.report).toHaveBeenLastCalledWith("a", { status: "failed", writes: [], errorMessage: "offline", lasting: false });
  f.push.mockResolvedValueOnce({ status: "unavailable" });
  await expect(f.queue.pushNow("a")).resolves.toBeUndefined();
  expect(f.report).toHaveBeenLastCalledWith("a", { status: "unavailable" });
  f.push.mockResolvedValueOnce(NOTHING);
  await expect(f.queue.pushNow("a")).resolves.toBeUndefined();
  expect(f.push).toHaveBeenCalledTimes(3);
  expect(f.report).toHaveBeenCalledTimes(2);
});
