import {afterEach, expect, it, vi} from "vitest";
import {readyOwnerDeliveryDocuments, startServerOwnerDelivery} from "./serverOwnerDelivery";
import {deferred} from "../testing/deferred";

const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 1};
const document = {binding, relayDatabaseNamespace: "namespace", shareId: "share"};
const ready = {path: "docs/a.md", status: "ready", document};
afterEach(() => vi.useRealTimers());

it("discovers only ready documents, including after restart, and drops revoked targets", () => {
  const response = {ok: true, documents: [ready, {path: "docs/b.md", status: "preparing"}, {path: "docs/c.md", status: "paused"}]};
  expect(readyOwnerDeliveryDocuments(response, "workspace")).toEqual([document]);
  expect(readyOwnerDeliveryDocuments(structuredClone(response), "workspace")).toEqual([document]);
  expect(readyOwnerDeliveryDocuments({ok: true, documents: [{...ready, status: "unavailable"}]}, "workspace")).toEqual([]);
});

it("rejects foreign workspaces, versions, paths, duplicates and excessive target counts", () => {
  for (const row of [{...ready, document: {...document, binding: {...binding, workspaceId: "foreign"}}},
    {...ready, document: {...document, binding: {...binding, mainVersionId: "version"}}}, {...ready, path: "another.md"}]) {
    expect(() => readyOwnerDeliveryDocuments({ok: true, documents: [row]}, "workspace")).toThrow();
  }
  expect(() => readyOwnerDeliveryDocuments({ok: true, documents: [ready, ready]}, "workspace")).toThrow();
  expect(() => readyOwnerDeliveryDocuments({ok: true, documents: Array(65).fill(ready)}, "workspace")).toThrow();
});

it("rotates one bounded workspace and document pass, and forgets removed workspaces", async () => {
  vi.useFakeTimers();
  let ids = ["one", "two"];
  const runPass = vi.fn().mockResolvedValue({documentCount: 2, acknowledged: false});
  const owner = startServerOwnerDelivery({workspaceIds: () => ids, attemptTimeoutMs: 5000, retryDelayMs: 100,
    runPass, onError: vi.fn()});
  await vi.advanceTimersByTimeAsync(300);
  expect(runPass.mock.calls.slice(0, 4).map(([id, index]) => [id, index])).toEqual([["one", 0], ["two", 0], ["one", 1], ["two", 1]]);
  ids = ["one"];
  await vi.advanceTimersByTimeAsync(100);
  ids = ["two"];
  const before = runPass.mock.calls.length;
  await vi.advanceTimersByTimeAsync(100);
  expect(runPass.mock.calls[before]!.slice(0, 2)).toEqual(["two", 0]);
  await owner.stop();
});

it("aborts and awaits an active pass before stopping, without starting another", async () => {
  vi.useFakeTimers();
  const pending = deferred<{documentCount: number; acknowledged: boolean}>();
  let signal!: AbortSignal;
  const runPass = vi.fn((_id, _index, value: AbortSignal) => {signal = value; return pending.promise;});
  const owner = startServerOwnerDelivery({workspaceIds: () => ["workspace"], attemptTimeoutMs: 5000, retryDelayMs: 100, runPass, onError: vi.fn()});
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  const stopping = owner.stop().then(() => {stopped = true;});
  expect(signal.aborted).toBe(true); expect(stopped).toBe(false);
  pending.resolve({documentCount: 1, acknowledged: true});
  await stopping; await vi.advanceTimersByTimeAsync(1000);
  expect(runPass).toHaveBeenCalledTimes(1);
});

it("prioritizes an explicit retry without canceling an active pass", async () => {
  vi.useFakeTimers();
  const pending = deferred<{documentCount: number; acknowledged: boolean}>();
  const runPass = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue({documentCount: 1, acknowledged: false});
  const owner = startServerOwnerDelivery({workspaceIds: () => ["one", "two"], attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError: vi.fn()});
  await vi.advanceTimersByTimeAsync(0);
  owner.retry("two");
  expect(runPass.mock.calls[0]![2].aborted).toBe(false);
  pending.resolve({documentCount: 1, acknowledged: false});
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass.mock.calls[1]![0]).toBe("two");
  owner.retry("one"); await vi.advanceTimersByTimeAsync(1);
  expect(runPass.mock.calls[2]![0]).toBe("one");
  await owner.stop();
});

it("coalesces retries to the latest workspace and consumes its wake without an extra pass", async () => {
  vi.useFakeTimers();
  const pending = deferred<{documentCount: number; acknowledged: boolean}>();
  let lastPassAt = 0;
  const runPass = vi.fn().mockImplementationOnce(() => {lastPassAt = Date.now(); return pending.promise;})
    .mockImplementation(async () => {lastPassAt = Date.now(); return {documentCount: 1, acknowledged: false};});
  const owner = startServerOwnerDelivery({workspaceIds: () => ["one", "two", "three"], attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError() {}});
  await vi.advanceTimersByTimeAsync(0);
  owner.retry("two"); owner.retry("three");
  expect(runPass.mock.calls[0]![2].aborted).toBe(false);
  pending.resolve({documentCount: 1, acknowledged: false});
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass.mock.calls.map(call => call[0])).toEqual(["one", "three"]);
  await vi.advanceTimersByTimeAsync(lastPassAt + 999 - Date.now());
  expect(runPass).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass).toHaveBeenCalledTimes(3);
  owner.retry("two"); owner.retry("three");
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass.mock.lastCall![0]).toBe("three");
  await vi.advanceTimersByTimeAsync(lastPassAt + 999 - Date.now());
  expect(runPass).toHaveBeenCalledTimes(4);
  await owner.stop();
});

it("consumes a retry after the last workspace disappears and returns to empty polling cadence", async () => {
  vi.useFakeTimers();
  let ids = ["workspace"];
  const workspaceIds = vi.fn(() => ids), runPass = vi.fn().mockResolvedValue({documentCount: 1, acknowledged: false});
  const owner = startServerOwnerDelivery({workspaceIds, attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError() {}});
  await vi.advanceTimersByTimeAsync(0);
  owner.retry("workspace"); ids = [];
  await vi.advanceTimersByTimeAsync(1);
  expect(workspaceIds).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4998);
  expect(workspaceIds).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2);
  expect(workspaceIds).toHaveBeenCalledTimes(3);
  expect(runPass).toHaveBeenCalledTimes(1);
  await owner.stop();
});

it("consumes a retry when workspace discovery throws and keeps its failure cadence", async () => {
  vi.useFakeTimers();
  const failure = new Error("Workspace list is temporarily unavailable.");
  const workspaceIds = vi.fn().mockReturnValueOnce(["workspace"]).mockImplementationOnce(() => {throw failure;}).mockReturnValue([]);
  const runPass = vi.fn().mockResolvedValue({documentCount: 1, acknowledged: false}), onError = vi.fn();
  const owner = startServerOwnerDelivery({workspaceIds, attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError});
  await vi.advanceTimersByTimeAsync(0);
  owner.retry("workspace");
  await vi.advanceTimersByTimeAsync(1);
  expect(onError).toHaveBeenCalledWith(failure);
  await vi.advanceTimersByTimeAsync(4998);
  expect(workspaceIds).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2);
  expect(workspaceIds).toHaveBeenCalledTimes(3);
  expect(runPass).toHaveBeenCalledTimes(1);
  await owner.stop();
});

it.each([
  ["acknowledged", {documentCount: 1, acknowledged: true}, 200],
  ["more documents", {documentCount: 2, acknowledged: false}, 200],
  ["unacknowledged", {documentCount: 1, acknowledged: false}, 1000],
  ["empty", {documentCount: 0, acknowledged: false}, 5000],
  ["failed", null, 5000],
] as const)("keeps the %s pass cadence", async (_name, result, intervalMs) => {
  vi.useFakeTimers();
  const runPass = vi.fn();
  if (result) runPass.mockResolvedValue(result); else runPass.mockRejectedValue(new Error("Temporary failure."));
  const onError = vi.fn(() => {throw new Error("Logger failed.");});
  const owner = startServerOwnerDelivery({workspaceIds: () => ["workspace"], attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError});
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(intervalMs - 1);
  expect(runPass).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(runPass).toHaveBeenCalledTimes(2);
  if (result === null) expect(onError).toHaveBeenCalledTimes(2);
  await owner.stop();
});

it("stop cancels the initial wait and ignores later retries", async () => {
  vi.useFakeTimers();
  const runPass = vi.fn();
  const owner = startServerOwnerDelivery({workspaceIds: () => ["workspace"], attemptTimeoutMs: 5000, retryDelayMs: 1000, runPass, onError() {}});
  await owner.stop(); owner.retry("workspace");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(runPass).not.toHaveBeenCalled();
});

it("retains an abort-ignoring pass after its deadline until both stop calls finish", async () => {
  const entered = deferred<AbortSignal>(), settled = deferred<{documentCount: number; acknowledged: boolean}>();
  let passSettled = false;
  const runPass = vi.fn(async (_id, _index, signal: AbortSignal) => {
    entered.resolve(signal);
    const result = await settled.promise;
    passSettled = true;
    return result;
  });
  const owner = startServerOwnerDelivery({workspaceIds: () => ["workspace"], attemptTimeoutMs: 10, retryDelayMs: 1000, runPass, onError() {}});
  const signal = await entered.promise;
  await new Promise<void>(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), {once: true});
  });
  owner.retry("workspace");
  const stopped = vi.fn(() => {expect(passSettled).toBe(true);});
  const stops = Promise.all([owner.stop().then(stopped), owner.stop().then(stopped)]);
  void stops.catch(() => undefined);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(passSettled).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
    expect(runPass).toHaveBeenCalledTimes(1);
  } finally {settled.resolve({documentCount: 1, acknowledged: true});}
  await stops;
  expect(stopped).toHaveBeenCalledTimes(2);
  expect(runPass).toHaveBeenCalledTimes(1);
});
