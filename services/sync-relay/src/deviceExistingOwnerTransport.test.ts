import { expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { DeviceEngineConnection } from "./deviceEngineConnection.js";
import { startExistingOwnerDeviceTransport } from "./deviceExistingOwnerTransport.js";

it("uses an existing client for bounded owner adoption and refuses ordinary remote methods", async () => {
  let transport!: ReturnType<typeof startExistingOwnerDeviceTransport>, peerConnection: DeviceEngineConnection | undefined, peer: EngineClient | undefined;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const limits = { maxPayloadBytes: 4096,maxPendingBytes: 2_000_000 } as DeviceControlLimits;
  const start = { type: "liveHost.start" as const,version: 1 as const,relayNamespace: "namespace",authToken: "A".repeat(43),
    host: { hostId: "host",hostEpoch: parseHostEpoch(1),instanceId: "instance",connectionId: "connection" },receive: { maxPayloadBytes: 4096,maxPendingBytes: 2_000_000 } };
  const deviceSocket = { readyState: 1,bufferedAmount: 0,send(bytes: Buffer,options: {binary: boolean},done: () => void) {
    queueMicrotask(() => {
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
  const owner = { nativeSessionId: "ordinary-session",assertCurrent: vi.fn(),prepareHandoff: vi.fn(async () => undefined),finishHandoff: vi.fn(async () => undefined),remoteApplied: vi.fn(async () => undefined) };
  const singleton = { ready: vi.fn(async () => undefined),close: vi.fn(),sendRequest: vi.fn(async (request: {method: string}) => ({ result:
    request.method === "liveApplication.provisionOwner" ? { provisioned: true } : request.method === "liveApplication.register" ? { registrationId: 9 } : { adoptionId: "adoption",expectedLocalSequence: 0,throughCursor: null,outboxId: null } })),
    forwardLiveOwnerAdoption: vi.fn(async (_request: { sessionId: string }) => ({ result: { status: "adopted",adoption: { adoptionId: "adoption",localYDocSequence: 0,terminalCursor: 0,adoptionReplayed: false } } })) };
  transport = startExistingOwnerDeviceTransport({ config: { client: singleton as unknown as EngineClient,workspaces: [{workspaceId: "workspace",workspaceHandle: "ws-ordinary"}],ownerFor: () => owner,
    maxQueuedBytes: 2_000_000,maxFrameBytes: 1_048_576,maxUploads: 2,maxRegistrations: 10,aggregateBytes: 200_000_000,maxAdoptionBytes: 1_000_000,maxAdoptionEvents: 10,requestDeadlineMs: 30_000 },start,ws: deviceSocket,limits,stop: () => peerConnection?.close() });
  try {
    await started; await peer!.ready();
    const discovery = await peer!.sendRequest({id: 1,method: "liveApplication.hosts",params: {}});
    expect(discovery.result).toMatchObject({ownerSessions: {maxEvents: 10}});
    await peer!.sendRequest({id: 2,method: "liveApplication.register",workspace: "ws-ordinary",params: {binding: {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1}}});
    owner.prepareHandoff.mockRejectedValueOnce(new Error("renderer refused"));
    await expect(peer!.sendRequest({id: 3,method: "liveApplication.ownerState",workspace: "ws-ordinary",params: {registrationId: 9}})).rejects.toThrow();
    const state = await peer!.sendRequest({id: 4,method: "liveApplication.ownerState",workspace: "ws-ordinary",params: {registrationId: 9}});
    expect(state.result).toMatchObject({throughCursor: 0});
    const result = await peer!.sendLiveOwnerAdoption({id: 5,workspace: "ws-ordinary",registrationId: 9,sessionId: "9",deadlineMs: 30_000},
      { relayDatabaseNamespace: "namespace",adoptionId: "adoption",sourceMomentId: "source",sourceDigest: "b".repeat(64),sourceByteLength: 0,baselineMomentRelaySequence: 1,
        baselineRegisteredAtMs: 0,expectedLocalSequence: 0,terminalReceipt: null,baselineBytes: new Uint8Array([0,0]),events: [] },{maxBytes: 1_000_000,maxEvents: 10});
    expect(result.result).toMatchObject({status: "adopted"});
    expect(singleton.forwardLiveOwnerAdoption.mock.calls[0]![0]).toMatchObject({sessionId: "ordinary-session"});
    await expect(peer!.sendRequest({id: 6,method: "workspace.close",workspace: "ws-ordinary",params: {}})).rejects.toThrow();
    expect(singleton.sendRequest.mock.calls.map(call => call[0].method)).not.toContain("workspace.close");
    expect(singleton.close).not.toHaveBeenCalled();
  } finally { await transport.close(); peer?.close(); }
});
