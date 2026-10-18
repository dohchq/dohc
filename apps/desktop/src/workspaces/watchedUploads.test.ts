import {afterEach, expect, it, vi} from "vitest";
import {createRelaySyncEngine} from "./relaySyncEngine";
import {createRelayLogWait} from "./relayLogWait";
import type {WorkspaceEngineCapture} from "./workspaceEngineCapture";
import {startServerOwnerDelivery} from "./serverOwnerDelivery";
import {startRelayWatch} from "./relayWatch";
import {RelayUnauthorizedError, RelayOriginDivergedError, RelayClaimRefusedError} from "@dohc/workspace-contracts/relay";

afterEach(() => vi.useRealTimers());

function fixture(joinBootstrap = false) {
  const listeners = new Set<(path: string) => void>();
  let answer!: (value: {hasMore: boolean; watched: boolean}) => void;
  let fail!: (error: unknown) => void;
  const push = vi.fn(async () => ({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []}));
  const pull = vi.fn(async () => ({fetched: 0, applied: 0, skipped: 0, conflictsOpened: 0, fastForwardedPaths: [], nextCursor: 0, sharingDeclined: []}));
  const onChange = vi.fn(), shared = vi.fn(async () => false), afterPull = vi.fn(async () => {}), retryOwner = vi.fn();
  const capture = {runRelaySync: async (task: (materialize: () => Promise<void>) => Promise<unknown>) => task(async () => {}),
    onDurableLocalChange: (handler: (path: string) => void) => {listeners.add(handler); return () => listeners.delete(handler);}} as unknown as WorkspaceEngineCapture;
  const sync = createRelaySyncEngine({rootDir: "test", relay: {baseUrl: "http://relay.test", token: "token"}, capture,
    operations: {push, pull, claim: async () => {}, recoverOrigin: vi.fn()}, onChange,
    syncSharedChannels: shared, afterSuccessfulPull: afterPull, joinBootstrap,
    retryOwnerDelivery: retryOwner,
    waitForChange: (_since, signal) => new Promise((resolve, reject) => {
      answer = resolve; fail = reject; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }),
  });
  return {sync, capture, push, pull, onChange, shared, afterPull, retryOwner, listeners,
    answer: (watched: boolean, hasMore = false) => answer({hasMore, watched}),
    fail: (error: unknown) => fail(error),
    edit: (path = "a.md") => {for (const handler of listeners) handler(path);}};
}

it("pushes continuous watched edits within 250 ms without pulling or announcing a change", async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.listeners.size).toBe(1);
  f.push.mockClear(); f.pull.mockClear(); f.onChange.mockClear(); f.shared.mockClear(); f.afterPull.mockClear();
  const starts: number[] = []; f.push.mockImplementation(async () => {starts.push(Date.now()); return {pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []};});
  const edits: number[] = [];
  for (let t = 0; t < 3000; t += 100) {edits.push(Date.now()); f.edit(); await vi.advanceTimersByTimeAsync(100);}
  await vi.advanceTimersByTimeAsync(250);
  for (const edit of edits) expect(starts.find(start => start >= edit)! - edit).toBeLessThanOrEqual(250);
  expect(starts.length).toBeLessThanOrEqual(13);
  expect(f.pull).not.toHaveBeenCalled(); expect(f.onChange).not.toHaveBeenCalled();
  expect(f.shared).not.toHaveBeenCalled(); expect(f.afterPull).not.toHaveBeenCalled();
  expect(f.sync.snapshot().pendingChangeCount).toBe(0);
  await f.sync.stop(); expect(f.listeners.size).toBe(0);
});

it("keeps a held-read pull on its deadline while watched uploads drain typing", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  f.edit(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true, true); await vi.advanceTimersByTimeAsync(0);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(f.pull).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 14; index++) {f.edit(); await vi.advanceTimersByTimeAsync(100);}
  expect(f.pull).toHaveBeenCalledTimes(1);
  f.edit(); await vi.advanceTimersByTimeAsync(99); expect(f.pull).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.pull).toHaveBeenCalledTimes(2);
  await f.sync.stop();
});

it("pulls a held-read change immediately while watched uploads are idle", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.answer(true, true); await vi.advanceTimersByTimeAsync(0);
  expect(f.pull).toHaveBeenCalledTimes(2); await f.sync.stop();
});

it("suppresses watched pushes in backoff and resumes after an ordinary successful pass", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.listeners.size).toBe(1);
  f.push.mockRejectedValueOnce(new Error("offline")); f.edit(); await vi.advanceTimersByTimeAsync(0);
  const calls = f.push.mock.calls.length;
  for (let t = 0; t < 1000; t += 100) {f.edit(); await vi.advanceTimersByTimeAsync(100);}
  expect(f.push).toHaveBeenCalledTimes(calls);
  await f.sync.retryNow({countsAsAttempt: true}); f.edit(); await vi.advanceTimersByTimeAsync(250);
  expect(f.push.mock.calls.length).toBeGreaterThan(calls);
  await f.sync.stop();
});

it("expires the watch on a held-read failure and detaches on expired sign-in", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0); expect(f.listeners.size).toBe(1);
  f.fail(new Error("capacity")); await vi.advanceTimersByTimeAsync(0); expect(f.listeners.size).toBe(0);
  await vi.advanceTimersByTimeAsync(5000); f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.fail(new RelayUnauthorizedError()); await vi.advanceTimersByTimeAsync(0);
  const calls = f.push.mock.calls.length; f.edit(); await vi.advanceTimersByTimeAsync(10_000);
  expect(f.push).toHaveBeenCalledTimes(calls); expect(f.listeners.size).toBe(0); expect(f.sync.snapshot().authExpired).toBe(true);
  await f.sync.stop();
});

it("pauses zero-op watched pushes while continuing owner delivery and resumes on an ordinary pass", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.push.mockResolvedValueOnce({pushed: 0, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(0); const calls = f.push.mock.calls.length;
  f.edit("b.md"); await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(calls); expect(f.retryOwner).toHaveBeenLastCalledWith("b.md");
  await f.sync.retryNow({countsAsAttempt: true}); f.edit(); await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(calls + 2); await f.sync.stop();
});

it("queues ordinary origin recovery after watched divergence", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.push.mockRejectedValueOnce(new RelayOriginDivergedError("diverged")); f.edit(); await vi.advanceTimersByTimeAsync(0);
  expect(f.pull).toHaveBeenCalledTimes(2); expect(f.push).toHaveBeenCalledTimes(3);
  await f.sync.stop();
});

it("never pushes before join bootstrap succeeds, and suppresses watched work after a refused claim", async () => {
  vi.useFakeTimers(); const f = fixture(true);
  f.pull.mockRejectedValueOnce(new Error("bootstrap unavailable")); await expect(f.sync.start()).rejects.toThrow();
  f.sync.queueWatchedUpload(["a.md"]); await vi.advanceTimersByTimeAsync(1000); expect(f.push).not.toHaveBeenCalled();
  await f.sync.stop();
  const refused = fixture(); await refused.sync.start(); await vi.advanceTimersByTimeAsync(0);
  refused.answer(true); await vi.advanceTimersByTimeAsync(0);
  refused.push.mockRejectedValueOnce(new RelayClaimRefusedError("refused")); refused.edit(); await vi.advanceTimersByTimeAsync(0);
  const calls = refused.push.mock.calls.length; refused.edit(); await vi.advanceTimersByTimeAsync(10_000);
  expect(refused.push).toHaveBeenCalledTimes(calls); await refused.sync.stop();
});

it("cancels the watched deadline and detaches all durable listeners on unwatch", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0); expect(f.listeners.size).toBe(1); f.edit(); await vi.advanceTimersByTimeAsync(100); f.edit();
  f.answer(false); await vi.advanceTimersByTimeAsync(0);
  const pushed = f.push.mock.calls.length; expect(f.listeners.size).toBe(0);
  await vi.advanceTimersByTimeAsync(1000); expect(f.push).toHaveBeenCalledTimes(pushed);
  await f.sync.stop(); expect(vi.getTimerCount()).toBe(0);
});

it("coalesces edits behind an in-flight push and captured edits use the same deadline", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed: 1, hasMore: true, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  f.edit(); await vi.advanceTimersByTimeAsync(0);
  f.sync.queueWatchedUpload(["agent.md"]); await vi.advanceTimersByTimeAsync(100);
  f.edit("outside.md"); await vi.advanceTimersByTimeAsync(200);
  expect(f.push).toHaveBeenCalledTimes(2);
  finish(); await vi.advanceTimersByTimeAsync(0); expect(f.push).toHaveBeenCalledTimes(3);
  expect(f.retryOwner.mock.calls.map(call => call[0])).toEqual(["a.md", "agent.md", "outside.md"]);
  await f.sync.stop();
});

it("keeps ten idle unwatched minutes at main's held-read and ordinary-pass cadence", async () => {
  vi.useFakeTimers();
  const listeners = vi.fn(() => () => {}), push = vi.fn(async () => ({pushed: 0, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []}));
  const pull = vi.fn(async () => ({fetched: 0, applied: 0, skipped: 0, conflictsOpened: 0, fastForwardedPaths: [], nextCursor: 0, sharingDeclined: []}));
  const wait = vi.fn((_since: number, signal: AbortSignal) => new Promise<{hasMore: boolean; watched: boolean}>((resolve, reject) => {
    const aborted = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal.removeEventListener("abort", aborted); resolve({hasMore: false, watched: false});}, 25_000);
    signal.addEventListener("abort", aborted, {once: true});
  }));
  const sync = createRelaySyncEngine({rootDir: "idle", relay: {baseUrl: "http://relay.test", token: "t"},
    capture: {runRelaySync: async (task: (materialize: () => Promise<void>) => Promise<unknown>) => task(async () => {}), onDurableLocalChange: listeners} as unknown as WorkspaceEngineCapture,
    operations: {push, pull, claim: async () => {}, recoverOrigin: vi.fn()}, onChange: vi.fn(), waitForChange: wait, idlePullMs: 300_000});
  await sync.start(); await vi.advanceTimersByTimeAsync(600_000);
  expect(push).toHaveBeenCalledTimes(3); expect(pull).toHaveBeenCalledTimes(3); expect(wait).toHaveBeenCalledTimes(25);
  expect(listeners).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(2);
  sync.queueWatchedUpload(["ignored.md"]); expect(vi.getTimerCount()).toBe(2);
  await sync.stop(); expect(vi.getTimerCount()).toBe(0);
});

it("accepts early watch transitions but refuses a steady watched capacity answer", async () => {
  const urls: string[] = [];
  const bodies = [{ok: true, hasMore: false, watched: true}, {ok: true, hasMore: false, watched: true}, {ok: true, hasMore: false}];
  const wait = createRelayLogWait({workspaceId: "w", nowMs: () => 0, relay: {baseUrl: "http://relay.test", token: "t",
    fetch: async resource => {urls.push(String(resource)); return Response.json(String(resource).endsWith("bootstrap")
      ? {ok: true, hasContent: true, replicationEpoch: "epoch", streamIdentity: "stream"} : bodies.shift());}}});
  const signal = new AbortController().signal;
  await expect(wait(0, signal)).resolves.toEqual({hasMore: false, watched: true});
  await expect(wait(0, signal)).rejects.toThrow(/early/);
  expect(urls.at(-1)).toContain("watched=1");
  // The failed read forgets the watch, so the following unchanged early answer fails too.
  await expect(wait(0, signal)).rejects.toThrow(/early/);
  expect(urls.at(-1)).not.toContain("watched=1");
});

it("keeps its reported watch when its caller replaces a held read", async () => {
  const urls: string[] = []; let held = 0, started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  const wait = createRelayLogWait({workspaceId: "w", nowMs: () => 0, relay: {baseUrl: "http://relay.test", token: "t",
    fetch: (resource, init) => {
      urls.push(String(resource));
      if (String(resource).endsWith("bootstrap")) return Promise.resolve(Response.json({ok: true, hasContent: true, replicationEpoch: "epoch", streamIdentity: "stream"}));
      if (++held !== 2) return Promise.resolve(Response.json({ok: true, hasMore: false, watched: true}));
      return new Promise((_resolve, reject) => {init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {once: true}); started();});
    }}});
  await wait(0, new AbortController().signal);
  const replacement = new AbortController(), pending = wait(0, replacement.signal);
  const rejected = expect(pending).rejects.toBeDefined();
  await waiting; replacement.abort(); await rejected;
  await expect(wait(1, new AbortController().signal)).rejects.toThrow(/early/);
  expect(urls.at(-1)).toContain("watched=1");
});

it("serves an edited document next and gives rotation every other pass", async () => {
  vi.useFakeTimers();
  const served: string[] = [];
  const paths = ["a.md", "b.md", "c.md"];
  const owner = startServerOwnerDelivery({workspaceIds: () => ["w"], attemptTimeoutMs: 5000, retryDelayMs: 1000,
    runPass: async (_id, index, _signal, path) => {served.push(path ?? paths[index]!); return {documentCount: 3, acknowledged: false};}, onError: () => {}});
  await vi.advanceTimersByTimeAsync(0);
  owner.retry("w", "c.md"); await vi.advanceTimersByTimeAsync(1);
  expect(served).toEqual(["a.md", "c.md"]);
  owner.retry("w", "c.md"); await vi.advanceTimersByTimeAsync(1);
  expect(served[2]).toBe("b.md");
  await vi.advanceTimersByTimeAsync(1);
  expect(served.at(-1)).toBe("c.md");
  await owner.stop();
});

it("forgets a deferred document priority when every workspace disappears", async () => {
  vi.useFakeTimers(); let ids = ["w"];
  let lastPollAt = 0;
  const workspaceIds = vi.fn(() => {lastPollAt = Date.now(); return ids;}), runPass = vi.fn(async () => ({documentCount: 1, acknowledged: false}));
  const owner = startServerOwnerDelivery({workspaceIds, attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError: () => {}});
  await vi.advanceTimersByTimeAsync(0); owner.retry("w", "a.md"); await vi.advanceTimersByTimeAsync(1);
  ids = []; owner.retry("w", "a.md"); await vi.advanceTimersByTimeAsync(1);
  const polls = workspaceIds.mock.calls.length; await vi.advanceTimersByTimeAsync(lastPollAt + 4999 - Date.now());
  expect(workspaceIds).toHaveBeenCalledTimes(polls);
  await vi.advanceTimersByTimeAsync(1); expect(workspaceIds).toHaveBeenCalledTimes(polls + 1); await owner.stop();
});

it("keeps the last watch while replacing its held read with a newer cursor", async () => {
  vi.useFakeTimers();
  const watched = vi.fn(), reads: Array<(value: {hasMore: boolean; watched: boolean}) => void> = [];
  const watch = startRelayWatch({initialDelayMs: 5000, maxDelayMs: 10_000, watched, changed() {}, failed: vi.fn(),
    wait: (_since, signal) => new Promise((resolve, reject) => {reads.push(resolve); signal.addEventListener("abort", () => reject(signal.reason), {once: true});}),
  });
  watch.watchPast(0, false); await vi.advanceTimersByTimeAsync(0);
  reads[0]!({hasMore: false, watched: true}); await vi.advanceTimersByTimeAsync(0);
  expect(watched).toHaveBeenLastCalledWith(true);
  watch.watchPast(1, false); await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(3); expect(watched).toHaveBeenCalledTimes(1);
  reads[2]!({hasMore: false, watched: false}); await vi.advanceTimersByTimeAsync(0);
  expect(watched).toHaveBeenLastCalledWith(false); await watch.stop();
});

it("does not pause watched uploads after an ordinary pass covers a queued edit", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.edit(); await vi.advanceTimersByTimeAsync(100);
  f.edit(); f.sync.queuePull(); await vi.advanceTimersByTimeAsync(0);
  f.push.mockResolvedValueOnce({pushed: 0, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});
  await vi.advanceTimersByTimeAsync(150);
  expect(f.push).toHaveBeenCalledTimes(3);
  f.push.mockReset().mockResolvedValue({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(1);
  await f.sync.stop();
});

it("drains bounded watched pushes on the fixed cadence without another edit", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.push.mockResolvedValueOnce({pushed: 1, hasMore: true, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(0); expect(f.push).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(249); expect(f.push).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(f.push).toHaveBeenCalledTimes(3);
  await f.sync.stop();
});

it("does not pause after an ordinary in-flight push drains a later edit", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  f.sync.queuePull(); await vi.advanceTimersByTimeAsync(0); f.edit("later.md");
  finish(); await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(2); expect(f.retryOwner).toHaveBeenLastCalledWith("later.md");
  f.edit(); await vi.advanceTimersByTimeAsync(250); expect(f.push).toHaveBeenCalledTimes(3);
  await f.sync.stop();
});

it("does not repeat a watched push that already drained a later edit", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed: 2, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  f.edit(); await vi.advanceTimersByTimeAsync(100); f.edit("b.md");
  finish(); await vi.advanceTimersByTimeAsync(150);
  expect(f.push).toHaveBeenCalledTimes(2); expect(f.retryOwner).toHaveBeenLastCalledWith("b.md");
  f.edit(); await vi.advanceTimersByTimeAsync(250); expect(f.push).toHaveBeenCalledTimes(3);
  await f.sync.stop();
});

it("keeps a new edit arriving after the push result while capture releases the chain", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  // The fixture edits during the outer capture gate's completion, after push has returned.
  const run = f.capture.runRelaySync;
  f.capture.runRelaySync = async task => {const result = await run(task); f.edit("after.md"); f.capture.runRelaySync = run; return result;};
  f.edit(); await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(3); expect(f.retryOwner).toHaveBeenLastCalledWith("after.md");
  await f.sync.stop();
});
