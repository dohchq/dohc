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
