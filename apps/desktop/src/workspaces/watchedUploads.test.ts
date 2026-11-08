import {afterEach, expect, it, vi} from "vitest";
import {createRelaySyncEngine} from "./relaySyncEngine";
import {createRelayLogWait} from "./relayLogWait";
import type {WorkspaceEngineCapture} from "./workspaceEngineCapture";
import type {PullWorkspaceFromRelayResult, PushWorkspaceToRelayResult} from "@dohc/workspace-contracts/relay";
import {startRelayWatch} from "./relayWatch";
import {RelayUnauthorizedError, RelayOriginDivergedError, RelayClaimRefusedError, RelayIdentityMissingError} from "@dohc/workspace-contracts/relay";

afterEach(() => vi.useRealTimers());

function fixture(joinBootstrap = false) {
  const listeners = new Set<(path: string) => void>();
  let answer!: (value: {hasMore: boolean; watched: boolean}) => void;
  let fail!: (error: unknown) => void;
  const push = vi.fn(async (): Promise<PushWorkspaceToRelayResult> => ({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []}));
  const pull = vi.fn(async (): Promise<PullWorkspaceFromRelayResult> => ({fetched: 0, applied: 0, skipped: 0, conflictsOpened: 0, fastForwardedPaths: [], nextCursor: 0, sharingDeclined: []}));
  const onChange = vi.fn(), shared = vi.fn(async () => false), afterPull = vi.fn(async () => {}), claim = vi.fn(async () => {});
  const capture = {runRelaySync: async (task: (materialize: () => Promise<void>) => Promise<unknown>) => task(async () => {}),
    onDurableLocalChange: (handler: (path: string) => void) => {listeners.add(handler); return () => listeners.delete(handler);}} as unknown as WorkspaceEngineCapture;
  const sync = createRelaySyncEngine({rootDir: "test", relay: {baseUrl: "http://relay.test", token: "token"}, capture,
    operations: {push, pull, claim, recoverOrigin: vi.fn()}, onChange,
    syncSharedChannels: shared, afterSuccessfulPull: afterPull, joinBootstrap,
    waitForChange: (_since, signal) => new Promise((resolve, reject) => {
      answer = resolve; fail = reject; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }),
  });
  return {sync, capture, push, pull, claim, onChange, shared, afterPull, listeners,
    answer: (watched: boolean, hasMore = false) => answer({hasMore, watched}),
    fail: (error: unknown) => fail(error),
    edit: (path = "a.md") => {for (const handler of listeners) handler(path);}};
}

it("does not start a watched window for work already covered by an ordinary pass", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.edit(); await f.sync.retryNow({countsAsAttempt: true}); await vi.advanceTimersByTimeAsync(0);
  const calls = f.push.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10); f.edit(); await vi.advanceTimersByTimeAsync(0);
  expect(f.push).toHaveBeenCalledTimes(calls + 1);
  await f.sync.stop();
});

it("clears an empty-push pause when a fresh journaled edit arrives", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.push.mockResolvedValueOnce({pushed: 0, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(0); const calls = f.push.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000); expect(f.push).toHaveBeenCalledTimes(calls);
  f.edit(); await vi.advanceTimersByTimeAsync(0);
  expect(f.push).toHaveBeenCalledTimes(calls + 1);
  await f.sync.stop();
});

it("does not start a queued watched push once capture shutdown begins", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.edit(); await vi.advanceTimersByTimeAsync(0); f.edit();
  Object.defineProperty(f.capture, "shuttingDown", {value: true});
  await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(2);
  await f.sync.stop();
});

it.each([[false, 1], [true, 1], [false, 0], [true, 0]] as const)("keeps a durable wake arriving during a push (ordinary: %s, accepted: %s)", async (ordinary, pushed) => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  const pass = ordinary ? f.sync.retryNow({countsAsAttempt: true}) : (f.edit(), undefined);
  await vi.advanceTimersByTimeAsync(0); f.edit(); finish(); await pass; await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(3);
  await f.sync.stop();
});

it("merges watched sharing declines with pull notices and replaces the same object once", async () => {
  vi.useFakeTimers(); const f = fixture();
  const decline = {objectId: "old", versionId: "main", path: "a.md", lineagePruned: false, headBlobSha256: null, constraint: "limit", limitBytes: 1, observedBytes: 2};
  f.pull.mockResolvedValueOnce({...await f.pull(), sharingDeclined: [decline]});
  f.pull.mockClear(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  const next = {...decline, objectId: "new", path: "b.md"};
  f.push.mockResolvedValueOnce({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [next], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sync.snapshot().sharingDeclined).toEqual([decline, next]);
  const renamed = {...next, path: "c.md"};
  f.push.mockResolvedValueOnce({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [renamed], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(250);
  expect(f.sync.snapshot().sharingDeclined).toEqual([decline, renamed]);
  await f.sync.stop();
});

it("shows claiming identity while a watched push waits for a claim", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void; f.claim.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  f.push.mockRejectedValueOnce(new RelayIdentityMissingError());
  f.edit(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sync.snapshot().claimingIdentity).toBe(true);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sync.snapshot().claimingIdentity).toBe(false);
  await f.sync.stop();
});

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

it("resumes an empty-push pause on an ordinary pass", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  f.push.mockResolvedValueOnce({pushed: 0, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});
  f.edit(); await vi.advanceTimersByTimeAsync(0); const calls = f.push.mock.calls.length;
  await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(calls);
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
  f.sync.queueWatchedUpload(); await vi.advanceTimersByTimeAsync(1000); expect(f.push).not.toHaveBeenCalled();
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
  f.sync.queueWatchedUpload(); await vi.advanceTimersByTimeAsync(100);
  f.edit("outside.md"); await vi.advanceTimersByTimeAsync(200);
  expect(f.push).toHaveBeenCalledTimes(2);
  finish(); await vi.advanceTimersByTimeAsync(0); expect(f.push).toHaveBeenCalledTimes(3);
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
  sync.queueWatchedUpload(); expect(vi.getTimerCount()).toBe(2);
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

it("rechecks a later wake after an ordinary in-flight push", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed: 1, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  f.sync.queuePull(); await vi.advanceTimersByTimeAsync(0); f.edit("later.md");
  finish(); await vi.advanceTimersByTimeAsync(250);
  expect(f.push).toHaveBeenCalledTimes(3);
  f.edit(); await vi.advanceTimersByTimeAsync(250); expect(f.push).toHaveBeenCalledTimes(4);
  await f.sync.stop();
});

it("rechecks a wake even if a watched push reports draining multiple edits", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.sync.start(); await vi.advanceTimersByTimeAsync(0);
  f.answer(true); await vi.advanceTimersByTimeAsync(0);
  let finish!: () => void;
  f.push.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({pushed: 2, hasMore: false, originsPushed: [], sharingDeclined: [], ownerAdmissionPending: []});}));
  f.edit(); await vi.advanceTimersByTimeAsync(100); f.edit("b.md");
  finish(); await vi.advanceTimersByTimeAsync(150);
  expect(f.push).toHaveBeenCalledTimes(3);
  f.edit(); await vi.advanceTimersByTimeAsync(250); expect(f.push).toHaveBeenCalledTimes(4);
  await f.sync.stop();
});
