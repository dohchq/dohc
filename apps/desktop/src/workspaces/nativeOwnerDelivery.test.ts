import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {afterEach, expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {OwnerYDocFrameDeliveryOptions} from "./ownerYDocFrameDelivery";
import {runNativeOwnerDeliveryPass} from "./nativeOwnerDelivery";
import {parseDesktopOwnerDeliveryConfig} from "./desktopOwnerDelivery";

const mock = vi.hoisted(() => ({options: undefined as unknown, drain: vi.fn(), dispose: vi.fn()}));
vi.mock("./ownerYDocFrameDelivery", () => ({OwnerYDocFrameDelivery: class {
  constructor(options: unknown) {mock.options = options;}
  dispose = mock.dispose;
}}));
vi.mock("./ownerYDocOutbox", () => ({OwnerYDocOutboxDrainer: class {drainOnce = mock.drain; dispose() {}}}));
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const config = parseDesktopOwnerDeliveryConfig({version: 1, nativeConfigPath: "C:/native.json", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
  relayUrl: "https://relay.example.test", frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
    maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
  attemptTimeoutMs: 5000, retryDelayMs: 1000, documents: [{binding, outboxId: "outbox", relayDatabaseNamespace: "namespace", shareId: "share"}]});
afterEach(() => vi.clearAllMocks());

it("advances only from captured native positions and checks exact receipts", async () => {
  const receipt = {deliveryId: "delivery", updateDigest: "b".repeat(64), journalCursor: 8, acceptingHostEpoch: parseHostEpoch(1)};
  const client = {ownerYDocReadState: vi.fn(async () => ({revision: 2, acceptedCursor: 3, nativeHeadSequence: 4, stateVector: Buffer.from([0])})),
    ownerYDocApplyInitialSync: vi.fn(async () => ({revision: 5, acceptedCursor: 6, nativeHeadSequence: 7})),
    ownerYDocApplyAcceptedFrame: vi.fn(async () => ({revision: 9, acceptedCursor: 8, nativeHeadSequence: 10})),
    ownerYDocIsReceiptApplied: vi.fn(async () => false)};
  mock.drain.mockImplementation(async () => {
    const {acceptedState: state} = mock.options as OwnerYDocFrameDeliveryOptions;
    expect(await state.readState(binding, new AbortController().signal)).toEqual({stateVector: Buffer.from([0]), journalCursor: 3});
    await state.applyInitialSync({binding, hostVector: new Uint8Array([0]), missingStateUpdate: new Uint8Array([1]), appliedThroughJournalCursor: 6}, new AbortController().signal);
    expect(await state.applyAcceptedFrame({binding, previousAcceptedCursor: 3, journalCursor: 8, updateBytes: new Uint8Array([2])}, new AbortController().signal)).toBe("retry");
    expect(client.ownerYDocApplyAcceptedFrame).not.toHaveBeenCalled();
    await state.applyAcceptedFrame({binding, previousAcceptedCursor: 6, journalCursor: 8, updateBytes: new Uint8Array([2])}, new AbortController().signal);
    expect(await state.isReceiptApplied({binding, receipt}, new AbortController().signal)).toBe(false);
    await expect(state.readState({...binding, objectId: "foreign"}, new AbortController().signal)).rejects.toThrow("binding changed");
    return "retry";
  });
  await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, document: config.documents[0]!,
    signal: new AbortController().signal, bearer: "credential", assertCurrent() {}});
  expect(client.ownerYDocApplyInitialSync.mock.calls[0]).toEqual([expect.objectContaining({workspace: "handle"}), expect.objectContaining({expectedRevision: 2, expectedNativeHeadSequence: 4, previousAcceptedCursor: 3}), expect.any(AbortSignal)]);
  expect(client.ownerYDocApplyAcceptedFrame.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({expectedRevision: 5, expectedNativeHeadSequence: 7, previousAcceptedCursor: 6}), expect.any(AbortSignal)]);
  expect(client.ownerYDocIsReceiptApplied.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({receipt, relayDatabaseNamespace: "namespace"}), expect.any(AbortSignal)]);
});

it("awaits an interrupted native read before releasing the pass", async () => {
  let release!: (value: unknown) => void;
  const native = new Promise(resolve => {release = resolve;});
  const attempt = new AbortController();
  let nativeSignal!: AbortSignal, read!: Promise<unknown>;
  mock.drain.mockImplementation(async () => {
    read = (mock.options as OwnerYDocFrameDeliveryOptions).acceptedState.readState(binding, attempt.signal).catch(() => undefined);
    attempt.abort();
    return "retry";
  });
  const client = {ownerYDocReadState: vi.fn((_request, _target, signal) => {nativeSignal = signal; return native;})};
  let stopped = false;
  const pass = runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config,
    document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential", assertCurrent() {}}).then(() => {stopped = true;});
  await Promise.resolve();
  expect(nativeSignal.aborted).toBe(true);
  expect(stopped).toBe(false);
  release({revision: 2, acceptedCursor: 3, nativeHeadSequence: 4, stateVector: Buffer.from([0])});
  await pass; await read;
  expect(stopped).toBe(true);
});
