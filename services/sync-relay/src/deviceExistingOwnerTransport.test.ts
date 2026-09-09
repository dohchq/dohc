import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import { EngineClient,FrameDecoder,FrameType,encodeFrame } from "@dohc/workspace-engine-client/daemon";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { DeviceEngineConnection } from "./deviceEngineConnection.js";
import { startExistingOwnerDeviceTransport } from "./deviceExistingOwnerTransport.js";
import type {NativeRestoreFence} from "./liveRestoreFence.js";

it.each(["ownerState","register"])("releases cancelled %s capacity while its response is still backpressured",async method => {
  const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise,resolve};};
  const started = deferred(), held = deferred();
  const replies = new Map<number,ReturnType<typeof deferred>>();
  const decoder = new FrameDecoder(1_048_576,256*1024);
  let release: (() => void) | undefined;
  const ws = {readyState:1,bufferedAmount:0,send(bytes:Buffer,options:{binary:boolean},done:() => void) {
    let hold = false;
    if (options.binary) decoder.push(bytes,frame => {
      const value = JSON.parse(frame.payload.toString());
      replies.get(value.id)?.resolve();
      if (value.id === 3) {hold = true; release = done; held.resolve();}
    });
    else if (JSON.parse(bytes.toString()).type === "liveHost.transport") started.resolve();
    if (!hold) done();
  }} as unknown as WebSocket;
  const limits = {maxPayloadBytes:4096,maxPendingBytes:2_000_000} as DeviceControlLimits;
  const start = {type:"liveHost.start" as const,version:1 as const,relayNamespace:"namespace",authToken:"A".repeat(43),
    host:{hostId:"host",hostEpoch:parseHostEpoch(1),instanceId:"instance",connectionId:"connection"},receive:limits};
  const owner = {nativeSessionId:"session",assertCurrent:vi.fn(),prepareHandoff:vi.fn(async () => undefined),
    finishHandoff:vi.fn(async (_adopted:boolean) => undefined),remoteApplied:vi.fn(async () => undefined)};
  const client = {ready:async () => undefined,sendRequest:async (request:{method:string}) => ({result:
    request.method === "liveApplication.register" ? {registrationId:9} : {adoptionId:"adoption",expectedLocalSequence:0,throughCursor:null,outboxId:null,pendingBytes:0,outboxState:null}})} as unknown as EngineClient;
  const stop = vi.fn();
  const transport = startExistingOwnerDeviceTransport({config:{client,workspaces:[{workspaceId:"workspace",workspaceHandle:"handle"}],ownerFor:() => owner,
    maxQueuedBytes:2_000_000,maxFrameBytes:1_048_576,maxUploads:2,maxRegistrations:10,aggregateBytes:200_000_000,
    maxAdoptionBytes:1_000_000,maxAdoptionEvents:10,requestDeadlineMs:30_000},start,ws,limits,stop});
  const send = (value:unknown) => transport.receive(encodeFrame(FrameType.Control,0,Buffer.from(JSON.stringify(value)),1_048_576));
  const request = (id:number,method:string,params:object) => {
    const response = deferred(); replies.set(id,response);
    send({type:"request",id,method,workspace:"handle",params}); return response.promise;
  };
  try {
    await started.promise;
    send({type:"hello",protocolVersion:2,authToken:start.authToken,capabilities:["blobs"],maxFrameBytes:1_048_576,lastSessionGeneration:null});
    const registration = {binding:{workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"a".repeat(64),
      currentPath:"a.md",selectorPaths:["a.md"],restoreFenceGeneration:1}};
    await request(2,"liveApplication.register",registration);
    void request(3,`liveApplication.${method}`,method === "register" ? registration : {registrationId:9}); await held.promise;
    const beforeCancel = owner.assertCurrent.mock.calls.length;
    send({type:"cancel",id:3});
    await expect.poll(() => owner.assertCurrent.mock.calls.length,{timeout:1000}).toBeGreaterThan(beforeCancel);
    expect(owner.finishHandoff.mock.calls).toEqual(method === "ownerState" ? [[false]] : []);
    const nextState = request(4,"liveApplication.ownerState",{registrationId:9});
    const nextRegistration = request(5,"liveApplication.register",registration);
    await expect.poll(() => owner.prepareHandoff.mock.calls.length).toBe(method === "ownerState" ? 2 : 1);
    expect(stop).not.toHaveBeenCalled();
    release!(); release = undefined;
    await Promise.all([nextState,nextRegistration]);
  } finally {release?.(); await transport.close();}
});

it("uses an existing client for bounded owner adoption and refuses ordinary remote methods", async () => {
  let transport!: ReturnType<typeof startExistingOwnerDeviceTransport>, peerConnection: DeviceEngineConnection | undefined, peer: EngineClient | undefined;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const limits = { maxPayloadBytes: 4096,maxPendingBytes: 2_000_000 } as DeviceControlLimits;
  const start = { type: "liveHost.start" as const,version: 1 as const,relayNamespace: "namespace",authToken: "A".repeat(43),
    host: { hostId: "host",hostEpoch: parseHostEpoch(1),instanceId: "instance",connectionId: "connection" },receive: { maxPayloadBytes: 4096,maxPendingBytes: 2_000_000 } };
  const deviceSocket = { readyState: 1,bufferedAmount: 0,send(bytes: Buffer,options: {binary: boolean},done: () => void) {
    setImmediate(() => {
      if (options.binary) peerConnection!.receive(bytes);
      else {
        const value = JSON.parse(bytes.toString());
        if (value.type === "liveHost.transport") {
          peerConnection = new DeviceEngineConnection(relaySocket,limits,value.receive,2_000_000,() => undefined);
          peer = new EngineClient(peerConnection,{ authToken: start.authToken,protocolVersion: 2,capabilities: ["blobs"],maxFrameBytes: 1_048_576,
            privateLiveApplication: { aggregateBytes: 200_000_000,maxUploads: 2 } });
          ready();
        } else peerConnection!.credit(value.receivedBytes);
      }
      done();
    });
  } } as unknown as WebSocket;
  const relaySocket = { readyState: 1,bufferedAmount: 0,send(bytes: Buffer,options: {binary: boolean},done: () => void) {
    queueMicrotask(() => { if (options.binary) transport.receive(bytes); else transport.credit(JSON.parse(bytes.toString()).receivedBytes); done(); });
  } } as unknown as WebSocket;
  const owner = { nativeSessionId: "ordinary-session",assertCurrent: vi.fn(),prepareHandoff: vi.fn(async () => undefined),finishHandoff: vi.fn(async () => undefined),remoteApplied: vi.fn(async (_update: Uint8Array) => undefined) };
  const singleton = { ready: vi.fn(async () => undefined),close: vi.fn(),sendRequest: vi.fn(async (request: {method: string}): Promise<{result: Record<string,unknown>}> => ({ result:
    request.method === "liveApplication.provisionOwner" ? { provisioned: true } : request.method === "liveApplication.register" ? { registrationId: 9 } : { adoptionId: "adoption",expectedLocalSequence: 0,throughCursor: null,outboxId: null,pendingBytes: 0,outboxState: null } })),
    forwardLiveOwnerAdoption: vi.fn(async (_request: { sessionId: string }) => ({ result: { status: "adopted",adoption: { adoptionId: "adoption",localYDocSequence: 0,terminalCursor: 0,adoptionReplayed: false } } })),
    sendLiveApplication: vi.fn(async (_request: unknown,_event: unknown) => ({result: {status: "applied",ack: {}}})) };
  const ownerFor = vi.fn(() => owner);
  transport = startExistingOwnerDeviceTransport({ config: { client: singleton as unknown as EngineClient,workspaces: [{workspaceId: "workspace",workspaceHandle: "ws-ordinary"}],ownerFor,
    maxQueuedBytes: 2_000_000,maxFrameBytes: 1_048_576,maxUploads: 2,maxRegistrations: 1,aggregateBytes: 200_000_000,maxAdoptionBytes: 1_000_000,maxAdoptionEvents: 10,requestDeadlineMs: 30_000 },start,ws: deviceSocket,limits,stop: () => peerConnection?.close() });
  try {
    await started; await peer!.ready();
    const discovery = await peer!.sendRequest({id: 1,method: "liveApplication.hosts",params: {}});
    expect(discovery.result).toMatchObject({ownerSessions: {maxEvents: 10}});
    await peer!.sendRequest({id: 2,method: "liveApplication.register",workspace: "ws-ordinary",params: {binding: {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1}}});
    owner.prepareHandoff.mockRejectedValueOnce(new Error("renderer refused"));
    await expect(peer!.sendRequest({id: 3,method: "liveApplication.ownerState",workspace: "ws-ordinary",params: {registrationId: 9}})).rejects.toThrow();
    let release!: () => void;
    owner.prepareHandoff.mockImplementationOnce(() => new Promise<undefined>(resolve => {release = () => resolve(undefined);}));
    const pendingState = peer!.sendRequest({id: 4,method: "liveApplication.ownerState",workspace: "ws-ordinary",params: {registrationId: 9}});
    await expect.poll(() => owner.prepareHandoff.mock.calls.length).toBe(2);
    const finished = owner.finishHandoff.mock.calls.length;
    await expect(peer!.sendRequest({id: 5,method: "liveApplication.ownerState",workspace: "ws-ordinary",params: {registrationId: 9}})).rejects.toThrow();
    expect(owner.finishHandoff.mock.calls.length).toBe(finished);
    release();
    const state = await pendingState;
    expect(state.result).toMatchObject({throughCursor: 0});
    let completeAdoption!: () => void;
    singleton.forwardLiveOwnerAdoption.mockImplementationOnce(() => new Promise(resolve => {
      completeAdoption = () => resolve({result: {status: "adopted",adoption: {adoptionId: "adoption",localYDocSequence: 0,terminalCursor: 0,adoptionReplayed: false}}});
    }));
    const adopt = (id: number) => peer!.sendLiveOwnerAdoption({id,workspace: "ws-ordinary",registrationId: 9,sessionId: "9",deadlineMs: 30_000},
      { relayDatabaseNamespace: "namespace",adoptionId: "adoption",sourceMomentId: "source",sourceDigest: "b".repeat(64),sourceByteLength: 0,baselineMomentRelaySequence: 1,
        baselineRegisteredAtMs: 0,expectedLocalSequence: 0,terminalReceipt: null,baselineBytes: new Uint8Array([0,0]),events: [] },{maxBytes: 1_000_000,maxEvents: 10});
    const firstAdoption = adopt(6);
    await expect.poll(() => singleton.forwardLiveOwnerAdoption.mock.calls.length).toBe(1);
    const beforeDuplicate = owner.finishHandoff.mock.calls.length;
    await expect(adopt(7)).rejects.toThrow();
    expect(owner.finishHandoff.mock.calls.length).toBe(beforeDuplicate);
    expect(singleton.forwardLiveOwnerAdoption).toHaveBeenCalledTimes(1);
    completeAdoption();
    const result = await firstAdoption;
    expect(result.result).toMatchObject({status: "adopted"});
    expect(singleton.forwardLiveOwnerAdoption.mock.calls[0]![0]).toMatchObject({sessionId: "ordinary-session"});
    const updateBytes = new Uint8Array(1_100_000).fill(1);
    let applied!: () => void;
    const nativeApplied = {result: {status: "applied",ack: {cursor: 1}}};
    singleton.sendLiveApplication.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {applied = resolve;});
      return nativeApplied;
    });
    const applying = peer!.sendLiveApplication({id: 8,workspace: "ws-ordinary",registrationId: 9,deadlineMs: 30_000},{updateBytes,metadata: {firstSeen: [],accepted: {
      receipt: {deliveryId: "large",updateDigest: createHash("sha256").update(updateBytes).digest("hex"),journalCursor: 1,acceptingHostEpoch: parseHostEpoch(1)},
      binding: {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1},
      authority: {principalKind: "owner",principalId: "owner",grantId: null,grantGeneration: null},receivedAtMs: 1,
    }}});
    await expect.poll(() => singleton.sendLiveApplication.mock.calls.length).toBe(1);
    expect(owner.remoteApplied).not.toHaveBeenCalled();
    applied();
    expect((await applying).result).toEqual(nativeApplied.result);
    expect(owner.remoteApplied).toHaveBeenCalledOnce();
    expect(singleton.sendLiveApplication).toHaveBeenCalledTimes(1);
    const received = singleton.sendLiveApplication.mock.calls[0]![1] as {updateBytes: Uint8Array};
    expect(owner.remoteApplied.mock.calls[0]![0]).toBe(received.updateBytes);
    expect(Buffer.from(received.updateBytes).equals(Buffer.from(updateBytes))).toBe(true);
    const binding = {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1};
    const durableOwner = {adoptionId: "adoption",expectedLocalSequence: 0,throughCursor: 0,outboxId: null,pendingBytes: 0,outboxState: null};
    const handoffs = owner.prepareHandoff.mock.calls.length;
    singleton.sendRequest.mockResolvedValueOnce({result: durableOwner});
    await expect(peer!.sendRequest({id: 9,method: "liveApplication.register",workspace: "ws-ordinary",params: {binding,resumeAdoptionId: "wrong"}})).rejects.toThrow();
    singleton.sendRequest.mockResolvedValueOnce({result: durableOwner});
    expect((await peer!.sendRequest({id: 10,method: "liveApplication.register",workspace: "ws-ordinary",params: {binding,resumeAdoptionId: "adoption"}})).result).toEqual({registrationId: 9});
    expect(owner.prepareHandoff).toHaveBeenCalledTimes(handoffs);
    expect(singleton.forwardLiveOwnerAdoption).toHaveBeenCalledTimes(1);
    const operation: NativeRestoreFence = {operationId: "stop", relayDatabaseNamespace: "namespace", oldBinding: binding,
      hostId: "host", newFence: 2, origin: {kind: "owner",id: "adoption"}, terminal: null, appliedSequence: 0};
    const receipt = {operation,localHeadSequence: 4,recordedAtMs: 10};
    const calls = singleton.sendRequest.mock.calls.length;
    await expect(peer!.sendRequest({id: 11,method: "liveApplication.fenceRestore",workspace: "ws-ordinary",params: {operation: {...operation,hostId: "foreign"} as never}})).rejects.toThrow();
    expect(singleton.sendRequest).toHaveBeenCalledTimes(calls);
    singleton.sendRequest.mockResolvedValueOnce({result: {status: "fenced",receipt}});
    expect((await peer!.sendRequest({id: 12,method: "liveApplication.fenceRestore",workspace: "ws-ordinary",params: {operation: operation as never}})).result).toEqual({status: "fenced",receipt});
    const acquired = ownerFor.mock.calls.length;
    ownerFor.mockImplementationOnce(() => {throw new Error("renderer session is closed");});
    singleton.sendRequest.mockResolvedValueOnce({result: {status: "fenced",receipt}});
    expect((await peer!.sendRequest({id: 13,method: "liveApplication.fenceRestore",workspace: "ws-ordinary",params: {operation: operation as never}})).result).toEqual({status: "fenced",receipt});
    expect(ownerFor).toHaveBeenCalledTimes(acquired);
    const pending = await peer!.sendRequest({id: 14,method: "liveApplication.register",workspace: "ws-ordinary",params: {binding,resumeAdoptionId: "adoption"}});
    expect(pending.result).toMatchObject({status: "pending"});
    expect(singleton.forwardLiveOwnerAdoption).toHaveBeenCalledTimes(1);
    const resume = (id: number, target = binding) => peer!.sendRequest({id,method: "liveApplication.register",workspace: "ws-ordinary",params: {binding: target,resumeAdoptionId: "adoption"}});
    expect((await resume(15)).result).toMatchObject({status: "pending"});
    const nativeRegisters = () => singleton.sendRequest.mock.calls.filter(call => call[0].method === "liveApplication.register").length;
    const registeredCount = nativeRegisters();
    expect((await resume(16)).result).toMatchObject({status: "pending"});
    expect(nativeRegisters()).toBe(registeredCount);
    await expect(resume(17,{...binding,objectId: "second",currentPath: "b.md",selectorPaths: ["b.md"]})).rejects.toThrow();
    expect(nativeRegisters()).toBe(registeredCount);
    singleton.sendRequest.mockResolvedValueOnce({result: durableOwner});
    expect((await resume(18)).result).toEqual({registrationId: 9});
    singleton.sendRequest.mockResolvedValueOnce({result: {...durableOwner,outboxId: "outbox",pendingBytes: 1,outboxState: "frozen"}});
    await peer!.sendRequest({id: 19,method: "liveApplication.ownerOutbox",workspace: "ws-ordinary",params: {registrationId: 9}});
    singleton.sendRequest.mockResolvedValueOnce({result: durableOwner});
    await resume(20);
    singleton.sendRequest.mockResolvedValueOnce({result: {entries: []}});
    await peer!.sendRequest({id: 21,method: "liveApplication.readOwnerOutbox",workspace: "ws-ordinary",params: {registrationId: 9}});
    expect(singleton.sendRequest.mock.lastCall?.[0]).toMatchObject({method: "ydoc.ownerOutbox.readPending",params: {outboxId: "outbox"}});
    await expect(peer!.sendRequest({id: 22,method: "workspace.close",workspace: "ws-ordinary",params: {}})).rejects.toThrow();
    expect(singleton.sendRequest.mock.calls.map(call => call[0].method)).not.toContain("workspace.close");
    expect(singleton.close).not.toHaveBeenCalled();
  } finally { await transport.close(); peer?.close(); }
});
