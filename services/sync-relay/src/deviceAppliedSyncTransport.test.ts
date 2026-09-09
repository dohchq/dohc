import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import type {WebSocket} from "ws";
import {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import type {DeviceControlLimits} from "@dohc/live-session-contract/device-control";
import {DeviceEngineConnection} from "./deviceEngineConnection.js";
import {startExistingOwnerDeviceTransport} from "./deviceExistingOwnerTransport.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const origin = {eventCount: 0, journalCursor: 0, evidenceDigest: "b".repeat(64)};
const updateBytes = Buffer.alloc(300_000, 7);
const ack = {deliveryId: "delivery", updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
  journalCursor: 30, acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: 4, applicationReplayed: true};
const cut = () => ({binding, position: origin, observedLocalYDocHeadSequence: 7,
  hostVector: Buffer.from([0]), missingStateUpdate: Buffer.from([0, 0])});

async function fixture({sync = true, adopted = true, aggregateBytes = 200_000_000} = {}) {
  let transport!: ReturnType<typeof startExistingOwnerDeviceTransport>, connection: DeviceEngineConnection | undefined, peer: EngineClient | undefined;
  const started = deferred<void>();
  const events: Array<{name: string; payload: unknown; seq: number}> = [];
  let outputGate: ReturnType<typeof deferred<void>> | undefined, outputEntered: ReturnType<typeof deferred<void>> | undefined;
  const limits = {maxPayloadBytes: 4096, maxPendingBytes: 2_000_000} as DeviceControlLimits;
  const start = {type: "liveHost.start" as const, version: 1 as const, relayNamespace: "namespace", authToken: "A".repeat(43),
    host: {hostId: "host", hostEpoch: parseHostEpoch(1), instanceId: "instance", connectionId: "connection"}, receive: limits};
  const device = {readyState: 1, bufferedAmount: 0, send(bytes: Buffer, options: {binary: boolean}, done: () => void) {
    setImmediate(async () => {
      if (options.binary && outputGate) {outputEntered!.resolve(); await outputGate.promise;}
      if (options.binary) connection!.receive(bytes);
      else {
        const value = JSON.parse(bytes.toString());
        if (value.type === "liveHost.transport") {
          connection = new DeviceEngineConnection(relay, limits, value.receive, 2_000_000, () => undefined);
          peer = new EngineClient(connection, {authToken: start.authToken, protocolVersion: 2, capabilities: ["blobs"], maxFrameBytes: 1_048_576,
            privateLiveApplication: {aggregateBytes: 200_000_000, maxUploads: 2}});
          peer.onEvent(event => {if (event.name === "liveApplication.ownerOutboxChanged") events.push(event);});
          started.resolve();
        } else connection!.credit(value.receivedBytes);
      }
      done();
    });
  }} as unknown as WebSocket;
  const relay = {readyState: 1, bufferedAmount: 0, send(bytes: Buffer, options: {binary: boolean}, done: () => void) {
    queueMicrotask(() => {if (options.binary) transport.receive(bytes); else transport.credit(JSON.parse(bytes.toString()).receivedBytes); done();});
  }} as unknown as WebSocket;
  const listeners = new Set<() => void>(), disposed = vi.fn();
  const owner = {nativeSessionId: "session", assertCurrent: vi.fn(), prepareHandoff: vi.fn(async () => undefined),
    onDurableLocalChange: vi.fn((handler: () => void) => {listeners.add(handler); return () => {disposed(); listeners.delete(handler);};}),
    finishHandoff: vi.fn(async () => undefined), remoteApplied: vi.fn(async () => undefined)};
  const singleton = {ready: vi.fn(async () => undefined), close: vi.fn(),
    sendRequest: vi.fn(async (request: {method: string}): Promise<{result: Record<string, unknown>}> => ({result:
      request.method === "liveApplication.register" ? {registrationId: 9} : request.method === "liveApplication.ownerState"
        ? {adoptionId: "adoption", expectedLocalSequence: 0, throughCursor: 0, outboxId: null, pendingBytes: 0, outboxState: null} : {provisioned: true}})),
    openLiveAppliedSync: vi.fn<EngineClient["openLiveAppliedSync"]>(async () => cut()),
    readNextLiveApplied: vi.fn<EngineClient["readNextLiveApplied"]>(async () => ({position: {eventCount: 1, journalCursor: 30, evidenceDigest: "c".repeat(64)}, ack, updateBytes})),
    readLiveApplicationAck: vi.fn<EngineClient["readLiveApplicationAck"]>(async () => ack),
  };
  transport = startExistingOwnerDeviceTransport({config: {client: singleton as unknown as EngineClient,
    workspaces: [{workspaceId: "workspace", workspaceHandle: "handle"}], ownerFor: () => owner,
    maxQueuedBytes: 2_000_000, maxFrameBytes: 1_048_576, maxUploads: 2, maxRegistrations: 1, aggregateBytes,
    maxAdoptionBytes: 1_000_000, maxAdoptionEvents: 10, requestDeadlineMs: 30_000,
    ...(sync ? {sync: {maxClientVectorBytes: 1024, maxOutputBytes: 1_000_000}} : {})}, start, ws: device, limits, stop: () => connection?.close()});
  await started.promise; await peer!.ready();
  await peer!.sendRequest({id: 1, method: "liveApplication.register", workspace: "handle", params: {binding,
    ...(adopted ? {resumeAdoptionId: "adoption"} : {})}});
  let id = 1;
  return {peer: peer!, singleton, owner, disposed, events, change: () => {for (const listener of listeners) listener();},
    holdOutput() {
      const gate = deferred<void>(); outputGate = gate; outputEntered = deferred<void>();
      return {entered: outputEntered.promise, release() {outputGate = undefined; gate.resolve();}};
    },
    next: () => ({id: ++id, workspace: "handle", registrationId: 9, deadlineMs: 30_000}),
    async close() {await transport.close(); peer!.close();}};
}

it("forwards atomic sync, chunked applied bytes, empty reads and durable ACKs through the existing owner", async () => {
  const f = await fixture();
  try {
    expect(await f.peer.openLiveAppliedSync(f.next(), Buffer.from([0]), {maxInputBytes: 1024, maxOutputBytes: 1_000_000})).toEqual(cut());
    expect(f.singleton.openLiveAppliedSync.mock.calls[0]![0]).toMatchObject({workspace: "handle", registrationId: 9});
    const update = await f.peer.readNextLiveApplied(f.next(), origin, 1_000_000);
    expect(update).toEqual({position: {eventCount: 1, journalCursor: 30, evidenceDigest: "c".repeat(64)}, ack, updateBytes});
    f.singleton.readNextLiveApplied.mockResolvedValueOnce(null);
    expect(await f.peer.readNextLiveApplied(f.next(), update!.position, 1_000_000)).toBeNull();
    expect(await f.peer.readLiveApplicationAck(f.next(), ack)).toEqual(ack);
    f.singleton.readLiveApplicationAck.mockResolvedValueOnce(null);
    expect(await f.peer.readLiveApplicationAck(f.next(), ack)).toBeNull();
    expect(f.owner.remoteApplied).not.toHaveBeenCalled();
    expect(f.singleton.close).not.toHaveBeenCalled();
  } finally {await f.close();}
});

it("sends only registration metadata for durable owner changes and removes its subscription on close", async () => {
  const f = await fixture();
  await expect.poll(() => f.events.length).toBe(1);
  expect(f.events[0]).toMatchObject({name: "liveApplication.ownerOutboxChanged", seq: 1, payload: {registrationId: 9, binding}});
  expect(Object.keys(f.events[0]!.payload as object).sort()).toEqual(["binding", "registrationId"]);
  f.change(); await expect.poll(() => f.events.length).toBe(2);
  expect(f.events[1]!.seq).toBe(2);
  await f.close(); await f.close(); f.change();
  expect(f.disposed).toHaveBeenCalledTimes(1); expect(f.events).toHaveLength(2);
});

it("keeps one dirty notice while output is blocked and sends changes received during that write", async () => {
  const f = await fixture();
  await expect.poll(() => f.events.length).toBe(1);
  const hold = f.holdOutput();
  try {
    f.change(); await hold.entered;
    for (let i = 0; i < 100; i++) f.change();
    expect(f.events).toHaveLength(1);
    hold.release(); await expect.poll(() => f.events.length).toBe(3);
    expect(f.events.map(event => event.seq)).toEqual([1, 2, 3]);
  } finally {hold.release(); await f.close();}
});

it("retains dirty debt until an active read releases the configured aggregate reservation", async () => {
  const f = await fixture({aggregateBytes: 7_200_000}), entered = deferred<void>(), release = deferred<null>();
  try {
    await expect.poll(() => f.events.length).toBe(1);
    f.singleton.readNextLiveApplied.mockImplementationOnce(async () => {entered.resolve(); return release.promise;});
    const read = f.peer.readNextLiveApplied(f.next(), origin, 1_000_000); await entered.promise;
    for (let i = 0; i < 100; i++) f.change();
    await Promise.resolve(); expect(f.events).toHaveLength(1);
    release.resolve(null); expect(await read).toBeNull();
    await expect.poll(() => f.events.length).toBe(2);
  } finally {release.resolve(null); await f.close();}
});

it("subscribes before adoption but does not publish unadopted local changes", async () => {
  const f = await fixture({adopted: false});
  try {
    f.change(); await f.peer.sendRequest({id: f.next().id, method: "liveApplication.hosts", params: {}});
    expect(f.events).toHaveLength(0); expect(f.owner.onDurableLocalChange).toHaveBeenCalledTimes(1);
  } finally {await f.close();}
  expect(f.disposed).toHaveBeenCalledTimes(1);
});

it("admits its configured maximum sync input even while the reserved notice writer is blocked", async () => {
  const aggregateBytes = 1024 * 3 + 1_000_000 * 3 + 1_048_576 * 4;
  const f = await fixture({aggregateBytes}), entered = deferred<void>();
  await expect.poll(() => f.events.length).toBe(1);
  const hold = f.holdOutput();
  try {
    f.change(); await hold.entered;
    f.singleton.openLiveAppliedSync.mockImplementationOnce(async () => {entered.resolve(); return cut();});
    const read = f.peer.openLiveAppliedSync(f.next(), Buffer.alloc(1024), {maxInputBytes: 1024, maxOutputBytes: 1_000_000});
    await entered.promise;
    hold.release(); expect(await read).toEqual(cut());
    expect(f.singleton.close).not.toHaveBeenCalled();
  } finally {hold.release(); await f.close();}
});

it("does not expose a sync cut or ACK before owner adoption", async () => {
  const f = await fixture({adopted: false});
  try {
    await expect(f.peer.openLiveAppliedSync(f.next(), Buffer.from([0]), {maxInputBytes: 1024, maxOutputBytes: 1_000_000})).rejects.toThrow();
    await expect(f.peer.readLiveApplicationAck(f.next(), ack)).rejects.toThrow();
    expect(f.singleton.openLiveAppliedSync).not.toHaveBeenCalled();
    expect(f.singleton.readLiveApplicationAck).not.toHaveBeenCalled();
  } finally {await f.close();}
});

it("leaves sync forwarding disabled when no bridge bounds are configured", async () => {
  const f = await fixture({sync: false});
  try {
    await expect(f.peer.readNextLiveApplied(f.next(), origin, 1_000_000)).rejects.toThrow();
    expect(f.singleton.readNextLiveApplied).not.toHaveBeenCalled();
  } finally {await f.close();}
});

it("cancels one native read and releases bridge capacity without closing the shared daemon", async () => {
  const f = await fixture(), entered = deferred<AbortSignal>();
  try {
    f.singleton.readNextLiveApplied.mockImplementationOnce(async (_request, _after, _maximum, signal) => {
      entered.resolve(signal!);
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), {once: true}));
    });
    const cancel = new AbortController();
    const pending = f.peer.readNextLiveApplied(f.next(), origin, 1_000_000, cancel.signal);
    const failed = expect(pending).rejects.toThrow();
    const nativeSignal = await entered.promise;
    // A subsequent reply proves the read request has left the sender's drain queue.
    await f.peer.sendRequest({id: f.next().id, method: "liveApplication.hosts", params: {}});
    cancel.abort(new Error("reader closed"));
    await failed;
    await expect.poll(() => nativeSignal.aborted).toBe(true);
    expect(await f.peer.readLiveApplicationAck(f.next(), ack)).toEqual(ack);
    expect(f.singleton.close).not.toHaveBeenCalled();
  } finally {await f.close();}
});

it("suppresses a cut whose borrowed registration was fenced while the native read was queued", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<ReturnType<typeof cut>>();
  try {
    f.singleton.openLiveAppliedSync.mockImplementationOnce(async () => {entered.resolve(); return release.promise;});
    const pending = f.peer.openLiveAppliedSync(f.next(), Buffer.from([0]), {maxInputBytes: 1024, maxOutputBytes: 1_000_000});
    const refused = expect(pending).rejects.toThrow(); await entered.promise;
    const operation = {operationId: "stop", relayDatabaseNamespace: "namespace", oldBinding: binding, hostId: "host", newFence: 2,
      origin: {kind: "owner", id: "adoption"}, terminal: null, appliedSequence: 0};
    const receipt = {operation, localHeadSequence: 7, recordedAtMs: 1};
    f.singleton.sendRequest.mockResolvedValueOnce({result: {status: "fenced", receipt}});
    await f.peer.sendRequest({...f.next(), method: "liveApplication.fenceRestore", params: {operation}});
    expect(f.disposed).toHaveBeenCalledTimes(1);
    release.resolve(cut()); await refused;
    expect(f.singleton.close).not.toHaveBeenCalled();
  } finally {release.resolve(cut()); await f.close();}
});
