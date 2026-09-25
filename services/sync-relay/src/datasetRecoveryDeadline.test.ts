import { afterEach, expect, it, vi } from "vitest";
import { createDatasetRoutes } from "./datasetRoutes";
import type { RelayDatasetHost } from "./datasetHost";
import type { SyncRelayStorage } from "./storage";

const cursor = {workspaceId: "w", datasetId: "d", hostEpoch: "h", approvedRevisionHash: "a".repeat(64), revision: 1, digest: "b".repeat(64)};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request("https://relay/sync/w/datasets/d/imports/t", {
    method: "POST", body, signal, duplex: "half",
    headers: {"content-type": "application/octet-stream", "x-dohc-dataset-source-cursor": JSON.stringify(cursor), "x-dohc-dataset-manifest-sha256": "c".repeat(64)},
  } as RequestInit);
}
function route(run: (input: {stream: AsyncIterable<Uint8Array>; signal: AbortSignal}) => Promise<unknown>, unavailable = new AbortController()) {
  const handler = createDatasetRoutes({importRecovery: (_auth: unknown, input: Parameters<typeof run>[0]) => run(input)} as unknown as RelayDatasetHost,
    {workspaceIsOwnedBy: () => true, unavailable: unavailable.signal} as unknown as SyncRelayStorage, {nowMs: () => 1});
  return (req: Request) => handler(req, {route: "dataset", workspaceId: "w", datasetId: "d", transferId: "t", action: "import"},
    {kind: "named", workspaceId: "w", userId: "owner"});
}

it("allows a progressing upload beyond the old total deadline", async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({start(value) {controller = value;}});
  const received: number[] = [];
  const handle = route(async ({stream, signal}) => {
    for await (const chunk of stream) received.push(chunk[0]!);
    signal.throwIfAborted();
    return {installed: true};
  });
  const result = handle(request(body)).then(response => response.json(), error => ({error}));
  for (let n = 0; n < 6; n++) {
    await vi.advanceTimersByTimeAsync(60_000);
    controller.enqueue(Uint8Array.of(n));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(Array.from({length: n + 1}, (_, index) => index));
  }
  controller.close();
  expect(await result).toEqual({installed: true});
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a stalled body and never completes installation", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const handle = route(async ({stream, signal}) => {
    for await (const _chunk of stream) { /* Consume until stalled. */ }
    signal.throwIfAborted();
    return {installed: true};
  });
  const result = handle(request(new ReadableStream({cancel}))).catch(error => error);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await result).toMatchObject({name: "TimeoutError"});
  expect(cancel).toHaveBeenCalledOnce();
});

it("bounds processing after a progressing body has finished", async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({start(value) {controller = value;}});
  const handle = route(async ({stream, signal}) => {
    for await (const _chunk of stream) { /* Stage bytes. */ }
    signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
    return {installed: true};
  });
  const result = handle(request(body)).catch(error => error);
  await vi.advanceTimersByTimeAsync(60_000);
  controller.enqueue(Uint8Array.of(1));
  await vi.advanceTimersByTimeAsync(60_000);
  controller.close();
  let settled = false;
  void result.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(119_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({name: "TimeoutError"});
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["caller", "storage"])("cancels an upload immediately when its %s disconnects", async source => {
  vi.useFakeTimers();
  const disconnect = new AbortController();
  const cancel = vi.fn();
  const handle = route(async ({stream}) => {
    for await (const _chunk of stream) { /* Consume until disconnected. */ }
    return {installed: true};
  }, source === "storage" ? disconnect : undefined);
  const result = handle(request(new ReadableStream({cancel}), source === "caller" ? disconnect.signal : undefined)).catch(error => error);
  disconnect.abort();
  expect(await result).toMatchObject({name: "AbortError"});
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
