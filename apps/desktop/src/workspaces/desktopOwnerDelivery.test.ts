import {afterEach, expect, it, vi} from "vitest";
import {parseDesktopOwnerDeliveryConfig, startDesktopOwnerDelivery} from "./desktopOwnerDelivery";
import type {OwnerYDocDrainResult} from "./ownerYDocOutbox";
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const frames = {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
const config = {version: 1, nativeConfigPath: "C:/test/native-owner.json", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2}, relayUrl: "https://relay.example.test", frames, attemptTimeoutMs: 10_000, retryDelayMs: 2500,
  documents: [{binding, relayDatabaseNamespace: "namespace", shareId: "share"}]};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
afterEach(() => vi.useRealTimers());

it("accepts only explicit owner document targets and unchanged frame budgets", () => {
  const parsed = parseDesktopOwnerDeliveryConfig(config);
  expect(parsed.documents).toEqual(config.documents); expect(parsed.frames).toEqual(frames);
  for (const changed of [{...config, version: 2}, {...config, documents: []}, {...config, bearer: "forbidden"},
    {...config, documents: [config.documents[0], config.documents[0]]}, {...config, retryDelayMs: 0},
    {...config, relayUrl: "https://user:password@relay.example.test"}]) expect(() => parseDesktopOwnerDeliveryConfig(changed)).toThrow();
});

it("holds one pass, rotates targets and waits the configured retry interval", async () => {
  vi.useFakeTimers();
  const pending = deferred<OwnerYDocDrainResult>(), run = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue("retry");
  const parsed = parseDesktopOwnerDeliveryConfig({...config, documents: [...config.documents, {...config.documents[0], binding: {...binding, objectId: "second"}}]});
  const owner = startDesktopOwnerDelivery({config: parsed, runPass: run, onError: error => {throw error;}});
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(run).toHaveBeenCalledTimes(1);
  pending.resolve("empty"); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2499); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.map(call => call[0].binding.objectId)).toEqual(["object", "second"]);
  await owner.stop(); await vi.advanceTimersByTimeAsync(10000); expect(run).toHaveBeenCalledTimes(2);
});

it("stop aborts the current pass and waits for its resources to settle", async () => {
  vi.useFakeTimers(); const closed = deferred<void>(); let activeSignal!: AbortSignal;
  const owner = startDesktopOwnerDelivery({config: parseDesktopOwnerDeliveryConfig(config), runPass: async (_document, signal) => {
    activeSignal = signal; await closed.promise; return "retry";
  }, onError() {}});
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false; const stop = owner.stop().then(() => {stopped = true;});
  expect(activeSignal.aborted).toBe(true); expect(stopped).toBe(false);
  closed.resolve(); await stop; expect(stopped).toBe(true);
});

it("stops before the initial pass without starting native work", async () => {
  vi.useFakeTimers();
  const runPass = vi.fn().mockResolvedValue("retry");
  const owner = startDesktopOwnerDelivery({config: parseDesktopOwnerDeliveryConfig(config), runPass, onError() {}});
  await owner.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(runPass).not.toHaveBeenCalled();
});

it("continues acknowledged work at zero delay and retries even when logging throws", async () => {
  vi.useFakeTimers();
  const failure = new Error("Temporary transport failure.");
  const onError = vi.fn(() => {throw new Error("Logger failed.");});
  const runPass = vi.fn().mockResolvedValueOnce("acknowledged").mockRejectedValueOnce(failure).mockResolvedValue("empty");
  const owner = startDesktopOwnerDelivery({config: parseDesktopOwnerDeliveryConfig(config), runPass, onError});
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledWith(failure);
  await vi.advanceTimersByTimeAsync(2499);
  expect(runPass).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass).toHaveBeenCalledTimes(3);
  await owner.stop();
});

it("a deadline aborts the pass but keeps its slot and every stop until actual settlement", async () => {
  const entered = deferred<AbortSignal>(), settled = deferred<OwnerYDocDrainResult>();
  let passSettled = false;
  const runPass = vi.fn(async (_document, signal: AbortSignal) => {
    entered.resolve(signal);
    const result = await settled.promise;
    passSettled = true;
    return result;
  });
  const owner = startDesktopOwnerDelivery({config: {...parseDesktopOwnerDeliveryConfig(config), attemptTimeoutMs: 10}, runPass, onError() {}});
  const signal = await entered.promise;
  await new Promise<void>(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), {once: true});
  });
  const stopped = vi.fn(() => {expect(passSettled).toBe(true);});
  const stops = Promise.all([owner.stop().then(stopped), owner.stop().then(stopped)]);
  void stops.catch(() => undefined);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    expect(passSettled).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
    expect(runPass).toHaveBeenCalledTimes(1);
  } finally {settled.resolve("acknowledged");}
  await stops;
  expect(stopped).toHaveBeenCalledTimes(2);
  expect(runPass).toHaveBeenCalledTimes(1);
});
