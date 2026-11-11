import {LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES} from "@dohc/live-session-contract/live-frame";
import {resolve} from "node:path";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {afterEach, expect, it, vi} from "vitest";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {startServerOwnerDelivery} from "./serverOwnerDelivery";
import type {OwnerYDocFrameDeliveryOptions} from "./ownerYDocFrameDelivery";
import {runNativeOwnerDeliveryPass} from "./nativeOwnerDelivery";
import {parseDesktopOwnerDeliveryConfig} from "./desktopOwnerDelivery";

const mock = vi.hoisted(() => ({options: undefined as unknown, drain: vi.fn(), dispose: vi.fn(), authority: vi.fn(), synchronized: false}));
vi.mock("./ownerYDocFrameDelivery", () => ({OwnerYDocFrameDelivery: class {
  constructor(options: unknown) {mock.options = options;}
  dispose = mock.dispose;
  freshOwnerAuthority = mock.authority;
  get synchronized() {return mock.synchronized;}
}}));
vi.mock("./ownerYDocOutbox", () => ({OwnerYDocOutboxDrainer: class {drainOnce = mock.drain; dispose() {}}}));
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const config = parseDesktopOwnerDeliveryConfig({version: 1, nativeConfigPath: resolve("native.json"), nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
  relayUrl: "https://relay.example.test", frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
    maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
  attemptTimeoutMs: 5000, retryDelayMs: 1000, documents: [{binding, relayDatabaseNamespace: "namespace"}]});
afterEach(() => {vi.clearAllMocks(); vi.useRealTimers(); mock.synchronized = false;});

it("keeps a known-document preparation overload on the work retry cadence", async () => {
  vi.useFakeTimers();
  const client = {ownerYDocPrepareEnrollment: vi.fn().mockRejectedValue(
    new EngineRequestError(1, {code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff"}))};
  const runPass = vi.fn(async (_workspace: string, _index: number, signal: AbortSignal) => {
    const outcome = await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(),
      document: config.documents[0]!, signal, bearer: "credential", accountId: "owner", assertCurrent() {}});
    return {documentCount: 1, acknowledged: outcome === "acknowledged"};
  });
  const onError = vi.fn(), owner = startServerOwnerDelivery({workspaceIds: () => ["workspace"],
    attemptTimeoutMs: config.attemptTimeoutMs, retryDelayMs: config.retryDelayMs, runPass, onError});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(config.retryDelayMs + 1);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(mock.drain).not.toHaveBeenCalled();
  } finally {await owner.stop();}
});

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
  await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(), document: config.documents[0]!,
    signal: new AbortController().signal, bearer: "credential", accountId: "owner", assertCurrent() {}});
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
  const pass = runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(),
    document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential", accountId: "owner", assertCurrent() {}}).then(() => {stopped = true;});
  await vi.waitFor(() => expect(nativeSignal).toBeDefined());
  expect(nativeSignal.aborted).toBe(true);
  expect(stopped).toBe(false);
  release({revision: 2, acceptedCursor: 3, nativeHeadSequence: 4, stateVector: Buffer.from([0])});
  await pass; await read;
  expect(stopped).toBe(true);
});

it("requests a complete host checkpoint before discovering the enrolled outbox", async () => {
  const onEnrolled = vi.fn(async () => undefined);
  const captured={nativeHeadSequence:2,localStateDigest:"c".repeat(64)};
  const draft={binding,relayDatabaseNamespace:"namespace",revision:1,acceptedCursor:7,nativeHeadSequence:3, nativeUnsettled: false,outboxId:"enrolled",pendingBytes:2,state:"active"};
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
  expect(await runNativeOwnerDeliveryPass({client:client as unknown as EngineClient,workspaceHandle:"handle",config,refusals:new OwnerKnownRefusals(),document:config.documents[0]!,signal:new AbortController().signal,bearer:"credential",accountId:"owner",assertCurrent(){},onEnrolled})).toBe("acknowledged");
  expect(client.ownerYDocEnroll).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({captured,journalCursor:7,hostVector:Uint8Array.of(1),checkpoint:Uint8Array.of(2,3)}),expect.any(AbortSignal));
  expect(client.ownerYDocPrepareEnrollment).toHaveBeenCalledTimes(2);
  expect(onEnrolled).toHaveBeenCalledExactlyOnceWith();
});

it("pulls accepted state when an enrolled owner has no pending edits", async () => {
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId: "outbox"}}))};
  mock.drain.mockResolvedValue("empty");
  mock.authority.mockResolvedValue({kind: "authority", authority: {}});
  expect(await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(),
    document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential", accountId: "owner", assertCurrent() {}})).toBe("empty");
  expect(mock.authority).toHaveBeenCalledWith(binding);
});

it("persists a fenced idle outbox instead of requesting it again indefinitely", async () => {
  const sendRequest = vi.fn(async request => ({id: request.id, result: {}}));
  const client = {sendRequest, ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId: "outbox"}}))};
  mock.drain.mockResolvedValue("empty");
  mock.authority.mockResolvedValue({kind: "quarantine", reason: "binding changed", observedBinding: binding});
  expect(await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(),
    document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential", accountId: "owner", assertCurrent() {}})).toBe("frozen");
  expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({method: "ydoc.ownerOutbox.quarantine", workspace: "handle",
    params: {outboxId: "outbox", reason: "binding changed", observedBinding: binding}}), expect.any(AbortSignal));
});

// #3089: a move's owner sync never enrolls, and answers only after an opening sync installed.
const observedPass = (client: unknown) => runNativeOwnerDeliveryPass({client: client as EngineClient, workspaceHandle: "handle", config,
  refusals: new OwnerKnownRefusals(), document: config.documents[0]!, signal: new AbortController().signal, bearer: "credential",
  accountId: "owner", assertCurrent() {}, observedOnly: true});

it("answers unbound for a page this device has not enrolled, without asking the host or enrolling", async () => {
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "capture", captured: {nativeHeadSequence: 2, localStateDigest: "c".repeat(64)}})),
    ownerYDocEnroll: vi.fn()};
  expect(await observedPass(client)).toBe("unbound");
  expect(mock.authority).not.toHaveBeenCalled();
  expect(client.ownerYDocEnroll).not.toHaveBeenCalled();
  expect(client.ownerYDocPrepareEnrollment).toHaveBeenCalledTimes(1);
});

it.each([
  {name: "no outbox", outboxId: null, drained: undefined, synchronized: false, expected: "retry"},
  {name: "no outbox", outboxId: null, drained: undefined, synchronized: true, expected: "empty"},
  {name: "a drained outbox", outboxId: "outbox", drained: "acknowledged", synchronized: false, expected: "retry"},
  {name: "a drained outbox", outboxId: "outbox", drained: "acknowledged", synchronized: true, expected: "acknowledged"},
  {name: "an empty outbox", outboxId: "outbox", drained: "empty", synchronized: false, expected: "retry"},
  {name: "an empty outbox", outboxId: "outbox", drained: "empty", synchronized: true, expected: "empty"},
])("answers $expected for $name when the opening sync installed is $synchronized", async ({outboxId, drained, synchronized, expected}) => {
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId}})), ownerYDocEnroll: vi.fn()};
  mock.authority.mockImplementation(async () => {mock.synchronized = synchronized; return {kind: "authority", authority: {}};});
  mock.drain.mockImplementation(async () => {mock.synchronized = synchronized; return drained;});
  expect(await observedPass(client)).toBe(expected);
  expect(client.ownerYDocEnroll).not.toHaveBeenCalled();
});

it("answers empty at once for a retired generation, so a move's pull is not held", async () => {
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "retired"})), ownerYDocEnroll: vi.fn()};
  expect(await observedPass(client)).toBe("empty");
  expect(client.ownerYDocPrepareEnrollment).toHaveBeenCalledTimes(1);
  expect(mock.authority).not.toHaveBeenCalled();
  expect(mock.drain).not.toHaveBeenCalled();
  expect(client.ownerYDocEnroll).not.toHaveBeenCalled();
});

it("skips a retired generation without authority or a drain, and the next page delivers", async () => {
  vi.useFakeTimers();
  const second = {...config.documents[0]!, binding: {...binding, objectId: "second", currentPath: "b.md", selectorPaths: ["b.md"]}};
  const client = {ownerYDocPrepareEnrollment: vi.fn(async (_request: unknown, target: {binding: {objectId: string}}) =>
    target.binding.objectId === "object" ? {status: "retired"} : {status: "observed", draft: {outboxId: "outbox"}})};
  mock.drain.mockResolvedValue("acknowledged");
  const outcomes: string[] = [];
  const runPass = vi.fn(async (_workspace: string, index: number, signal: AbortSignal) => {
    const documents = [config.documents[0]!, second];
    const outcome = await runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(),
      document: documents[index % documents.length]!, signal, bearer: "credential", accountId: "owner", assertCurrent() {}});
    outcomes.push(outcome);
    return {documentCount: documents.length, acknowledged: outcome === "acknowledged"};
  });
  const onError = vi.fn(), owner = startServerOwnerDelivery({workspaceIds: () => ["workspace"],
    attemptTimeoutMs: config.attemptTimeoutMs, retryDelayMs: config.retryDelayMs, runPass, onError});
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(outcomes).toEqual(["empty", "acknowledged"]));
    expect(runPass.mock.calls.map(call => call[1])).toEqual([0, 1]);
    expect(mock.authority).not.toHaveBeenCalled();
    expect(mock.drain).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  } finally {await owner.stop();}
});
