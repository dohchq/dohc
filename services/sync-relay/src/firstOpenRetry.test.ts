import {expect, it, vi} from "vitest";
import {firstOpenOutcome, type FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";
import {FirstOpenRetry} from "./firstOpenRetry";

const source: FirstOpenSourceIdentity = {workspaceId: "w", objectId: "o", path: "a.md", sourceMomentId: "m", sourceDigest: "a".repeat(64)};
const deadline = (s = source, retryAfterMs = 1) => firstOpenOutcome(s, {kind: "unavailable", reason: "build-deadline", retryAfterMs});
function fixture(jitter = 0.5) {
  let now = 0;
  const retry = new FirstOpenRetry({nowMs: () => now, random: () => jitter});
  return {retry, advance(ms: number) {now += ms;}};
}

it.each([[0, 60_000, 120_000], [1, 90_000, 180_000]])("doubles the minimum at jitter %s", async (jitter, first, second) => {
  const f = fixture(jitter);
  await f.retry.attempt(source, async () => deadline());
  expect(f.retry.state(source)?.retryAtMs).toBe(first);
  f.advance(first!);
  await f.retry.attempt(source, async () => deadline());
  expect(f.retry.state(source)?.retryAtMs).toBe(first! + second!);
});

it("waits at least a minute, doubles with jitter, honors a later retry-after, and stops after three deadlines", async () => {
  const f = fixture(), ask = vi.fn(async () => deadline());
  await f.retry.attempt(source, ask);
  expect(f.retry.state(source)).toMatchObject({deadlineAnswers: 1, retryAtMs: 75_000, inFlight: false});
  f.advance(74_999);
  expect(await f.retry.attempt(source, ask)).toBeUndefined();
  f.advance(1);
  await f.retry.attempt(source, async () => deadline(source, 200_000));
  expect(f.retry.state(source)).toMatchObject({deadlineAnswers: 2, retryAtMs: 275_000});
  f.advance(200_000);
  await f.retry.attempt(source, ask);
  expect(f.retry.state(source)?.stop).toEqual({source, reason: "retry-stopped", code: "build-deadline", deadlineAnswers: 3, recovery: "retry-later"});
  f.advance(10_000_000);
  expect(await f.retry.attempt(source, ask)).toBeUndefined();
  expect(ask).toHaveBeenCalledTimes(2);
  expect(f.retry.retry(source)).toBe(true);
  expect(f.retry.state(source)).toMatchObject({deadlineAnswers: 0, retryAtMs: 10_275_000});
  await f.retry.attempt(source, ask);
  expect(f.retry.state(source)?.deadlineAnswers).toBe(1);
});

it("uses a jittered minimum for busy and transport failure, without suppressing the source", async () => {
  const f = fixture(), ask = vi.fn(async () => firstOpenOutcome(source, {kind: "unavailable", reason: "busy"}));
  await f.retry.attempt(source, ask);
  expect(f.retry.state(source)).toMatchObject({retryAtMs: 1_250, deadlineAnswers: 0});
  f.advance(1_249);
  expect(await f.retry.attempt(source, ask)).toBeUndefined();
  f.advance(1);
  await expect(f.retry.attempt(source, async () => {throw new Error("bad response");})).rejects.toThrow("bad response");
  f.advance(2_500);
  await f.retry.attempt(source, ask);
  expect(ask).toHaveBeenCalledTimes(2);
});

it("keeps one flight through retry and A-B-A edits, rejecting an old answer even if it ignores abort", async () => {
  const f = fixture();
  let finish!: (answer: ReturnType<typeof deadline>) => void;
  let signal!: AbortSignal;
  const first = f.retry.attempt(source, async s => {signal = s; return new Promise(resolve => {finish = resolve;});});
  const ask = vi.fn(async () => deadline());
  expect(await f.retry.attempt(source, ask)).toBeUndefined();
  f.retry.retry(source);
  expect(signal.aborted).toBe(true);
  expect(await f.retry.attempt(source, ask)).toBeUndefined();
  const edited = {...source, sourceMomentId: "m2", sourceDigest: "b".repeat(64)};
  await f.retry.attempt(edited, async () => deadline(edited));
  expect(f.retry.state(edited)?.deadlineAnswers).toBe(1);
  expect(await f.retry.attempt(source, ask)).toBeUndefined();
  finish(deadline());
  expect(await first).toBeUndefined();
  expect(f.retry.state(source)?.deadlineAnswers).toBe(0);
  await f.retry.attempt(source, ask);
  expect(ask).toHaveBeenCalledTimes(1);
});

it("resets on moment or digest changes, isolates workspaces, and discards cancelled or mismatched answers", async () => {
  const f = fixture(), other = {...source, workspaceId: "other"};
  await f.retry.attempt(source, async () => deadline());
  await f.retry.attempt(other, async () => deadline(other));
  const edited = {...source, sourceMomentId: "m2"};
  expect(f.retry.state(edited)).toBeUndefined();
  await f.retry.attempt(edited, async () => deadline(edited));
  expect(f.retry.state(edited)?.deadlineAnswers).toBe(1);
  expect(f.retry.state(other)?.deadlineAnswers).toBe(1);
  f.retry.retry(edited);
  await expect(f.retry.attempt(edited, async () => deadline(other))).rejects.toThrow();
  expect(f.retry.state(edited)?.deadlineAnswers).toBe(0);
  f.advance(1_250);
  const abort = new AbortController();
  await expect(f.retry.attempt(edited, async signal => {
    abort.abort(new Error("departed")); signal.throwIfAborted(); return deadline(edited);
  }, abort.signal)).rejects.toThrow("departed");
  expect(f.retry.state(edited)?.deadlineAnswers).toBe(0);
  f.retry.forget(other);
  expect(f.retry.state(other)).toBeUndefined();
});

it("resets a temporary stop after an edit without forging a permanent refusal", async () => {
  const f = fixture(0);
  for (let i = 0; i < 3; i++) {await f.retry.attempt(source, async () => deadline()); f.advance(120_000);}
  expect(f.retry.state(source)?.stop?.reason).toBe("retry-stopped");
  const edited = {...source, sourceDigest: "c".repeat(64)};
  await f.retry.attempt(edited, async () => deadline(edited));
  expect(f.retry.state(edited)).toMatchObject({deadlineAnswers: 1, stop: undefined});
});

it("discards a departed workspace's late answer while another workspace can make progress", async () => {
  const f = fixture();
  let finish!: (answer: ReturnType<typeof deadline>) => void;
  const pending = f.retry.attempt(source, () => new Promise(resolve => {finish = resolve;}));
  f.retry.forget(source);
  const other = {...source, workspaceId: "other"};
  await f.retry.attempt(other, async () => deadline(other));
  finish(deadline());
  expect(await pending).toBeUndefined();
  expect(f.retry.state(source)).toBeUndefined();
  expect(f.retry.state(other)?.deadlineAnswers).toBe(1);
});

it.each([0, 0.5, 1])("backs off repeated transient answers and errors with capped jitter %s", async jitter => {
  const f = fixture(jitter);
  const reasons = ["busy", "contention", "worker-failed", "host-absent", "host-unreachable", "check-failed", "check-deadline", "reconfigured", "history-unavailable", "storage-failed"] as const;
  let elapsed = 0;
  for (let i = 0; i < 14; i++) {
    if (i >= reasons.length) await expect(f.retry.attempt(source, async () => {throw new Error("transport");})).rejects.toThrow("transport");
    else await f.retry.attempt(source, async () => firstOpenOutcome(source, {kind: "unavailable", reason: reasons[i]!}));
    const delay = Math.min(300_000, Math.ceil(1_000 * 2 ** i * (1 + jitter / 2)));
    const due = elapsed + delay;
    expect(f.retry.state(source)?.retryAtMs).toBe(due);
    f.advance(delay - 1);
    expect(await f.retry.attempt(source, async () => deadline())).toBeUndefined();
    f.advance(1);
    elapsed = due;
  }
});

it("resets transient backoff on another answer, a new source, and explicit retry, honoring retry-after", async () => {
  const f = fixture(0);
  const busy = (s = source) => firstOpenOutcome(s, {kind: "unavailable", reason: "busy"});
  const fail = async (s = source) => {await f.retry.attempt(s, async () => busy(s));};
  await fail(); f.advance(1_000);
  await fail();
  expect(f.retry.state(source)?.retryAtMs).toBe(3_000);
  f.retry.retry(source);
  await fail();
  expect(f.retry.state(source)?.retryAtMs).toBe(2_000);
  f.advance(1_000);
  await f.retry.attempt(source, async () => deadline(source, 400_000));
  expect(f.retry.state(source)?.retryAtMs).toBe(402_000);
  f.advance(400_000);
  await fail();
  expect(f.retry.state(source)?.retryAtMs).toBe(403_000);
  const edited = {...source, sourceMomentId: "m2"};
  await fail(edited);
  expect(f.retry.state(edited)?.retryAtMs).toBe(403_000);
  f.advance(1_000);
  await f.retry.attempt(edited, async () => firstOpenOutcome(edited, {kind: "refused", reason: "stale-source"}));
  f.retry.retry(edited);
  await fail(edited);
  expect(f.retry.state(edited)?.retryAtMs).toBe(404_000);
});
