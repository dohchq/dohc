import {afterEach, expect, it, vi} from "vitest";
import {parseDesktopOwnerDeliveryConfig, startDesktopOwnerDelivery} from "./desktopOwnerDelivery";
import type {OwnerYDocDrainResult} from "./ownerYDocOutbox";
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const frames = {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
const config = {version: 1, nativeConfigPath: "C:/test/native-owner.json", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2}, relayUrl: "https://relay.example.test", frames, attemptTimeoutMs: 10_000, retryDelayMs: 2500,
  documents: [{binding, outboxId: "outbox", relayDatabaseNamespace: "namespace", shareId: "share"}]};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
afterEach(() => vi.useRealTimers());

it("accepts only explicit existing owner targets and unchanged frame budgets", () => {
  const parsed = parseDesktopOwnerDeliveryConfig(config);
  expect(parsed.documents).toEqual(config.documents); expect(parsed.frames).toEqual(frames);
  for (const changed of [{...config, version: 2}, {...config, documents: []}, {...config, bearer: "forbidden"},
    {...config, documents: [config.documents[0], config.documents[0]]}, {...config, retryDelayMs: 0},
    {...config, relayUrl: "https://user:password@relay.example.test"}]) expect(() => parseDesktopOwnerDeliveryConfig(changed)).toThrow();
});

it("holds one pass, rotates targets and waits the configured retry interval", async () => {
  vi.useFakeTimers();
  const pending = deferred<OwnerYDocDrainResult>(), run = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue("retry");
  const parsed = parseDesktopOwnerDeliveryConfig({...config, documents: [...config.documents, {...config.documents[0], outboxId: "second"}]});
  const owner = startDesktopOwnerDelivery({config: parsed, runPass: run, onError: error => {throw error;}});
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(run).toHaveBeenCalledTimes(1);
  pending.resolve("empty"); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2499); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.map(call => call[0].outboxId)).toEqual(["outbox", "second"]);
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
