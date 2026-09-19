import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {afterEach, expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {OwnerYDocFrameDeliveryOptions} from "./ownerYDocFrameDelivery";
import {runNativeOwnerDeliveryPass} from "./nativeOwnerDelivery";
import {parseDesktopOwnerDeliveryConfig} from "./desktopOwnerDelivery";

const mock = vi.hoisted(() => ({options: undefined as unknown, drain: vi.fn(), dispose: vi.fn(), authority: vi.fn()}));
vi.mock("./ownerYDocFrameDelivery", () => ({OwnerYDocFrameDelivery: class {
  constructor(options: unknown) {mock.options = options;}
  dispose = mock.dispose;
  freshOwnerAuthority = mock.authority;
}}));
vi.mock("./ownerYDocOutbox", () => ({OwnerYDocOutboxDrainer: class {drainOnce = mock.drain; dispose() {}}}));
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const config = parseDesktopOwnerDeliveryConfig({version: 1, nativeConfigPath: "C:/native.json", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
  relayUrl: "https://relay.example.test", frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
    maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
  attemptTimeoutMs: 5000, retryDelayMs: 1000, documents: [{binding, relayDatabaseNamespace: "namespace", shareId: "share"}]});
afterEach(() => vi.clearAllMocks());

it("advances only from captured native positions and checks exact receipts", async () => {
  const receipt = {deliveryId: "delivery", updateDigest: "b".repeat(64), journalCursor: 8, acceptingHostEpoch: parseHostEpoch(1)};
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status:"observed", draft:{outboxId:"outbox"}})), ownerYDocReadState: vi.fn(async () => ({revision: 2, acceptedCursor: 3, nativeHeadSequence: 4, stateVector: Buffer.from([0])})),
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
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status:"observed", draft:{outboxId:"outbox"}})), ownerYDocReadState: vi.fn((_request, _target, signal) => {nativeSignal = signal; return native;})};
  let stopped = false;
  const pass = runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config,
    document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential", assertCurrent() {}}).then(() => {stopped = true;});
  await vi.waitFor(() => expect(nativeSignal).toBeDefined());
  expect(nativeSignal.aborted).toBe(true);
  expect(stopped).toBe(false);
  release({revision: 2, acceptedCursor: 3, nativeHeadSequence: 4, stateVector: Buffer.from([0])});
  await pass; await read;
  expect(stopped).toBe(true);
});

it("requests a complete host checkpoint before discovering the enrolled outbox", async () => {
  const captured={nativeHeadSequence:2,localStateDigest:"c".repeat(64)};
  const draft={binding,relayDatabaseNamespace:"namespace",revision:1,acceptedCursor:7,nativeHeadSequence:3,outboxId:"enrolled",pendingBytes:2,state:"active"};
  const client={ownerYDocPrepareEnrollment:vi.fn().mockResolvedValueOnce({status:"capture",captured}).mockResolvedValue({status:"observed",draft}),
    ownerYDocEnroll:vi.fn().mockResolvedValue(draft),ownerYDocReadState:vi.fn()};
  mock.authority.mockImplementation(async () => {
    const state=(mock.options as OwnerYDocFrameDeliveryOptions).acceptedState;
    const signal=new AbortController().signal;
    expect(await state.readState(binding,signal)).toEqual({stateVector:Uint8Array.of(0),journalCursor:0});
    expect(client.ownerYDocReadState).not.toHaveBeenCalled();
    await state.applyInitialSync({binding,hostVector:Uint8Array.of(1),missingStateUpdate:Uint8Array.of(2,3),appliedThroughJournalCursor:7},signal);
    return {kind:"authority",authority:{value:{},hostEpoch:parseHostEpoch(1)}};
  });
  mock.drain.mockResolvedValue("acknowledged");
  expect(await runNativeOwnerDeliveryPass({client:client as unknown as EngineClient,workspaceHandle:"handle",config,document:config.documents[0]!,signal:new AbortController().signal,bearer:"credential",assertCurrent(){}})).toBe("acknowledged");
  expect(client.ownerYDocEnroll).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({captured,journalCursor:7,hostVector:Uint8Array.of(1),checkpoint:Uint8Array.of(2,3)}),expect.any(AbortSignal));
  expect(client.ownerYDocPrepareEnrollment).toHaveBeenCalledTimes(2);
});

it("pulls accepted state when an enrolled owner has no pending edits", async () => {
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId: "outbox"}}))};
  mock.drain.mockResolvedValue("empty");
  mock.authority.mockResolvedValue({kind: "authority", authority: {}});
  expect(await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config,
    document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential", assertCurrent() {}})).toBe("empty");
  expect(mock.authority).toHaveBeenCalledWith(binding);
});
