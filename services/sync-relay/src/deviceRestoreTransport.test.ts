import {expect,it,vi} from "vitest";
import type {WebSocket} from "ws";
import {EngineClient,encodeNativeRestoreInput} from "@dohc/workspace-engine-client/daemon";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import type {DeviceControlLimits} from "@dohc/live-session-contract/device-control";
import {DeviceEngineConnection} from "./deviceEngineConnection.js";
import {startExistingOwnerDeviceTransport} from "./deviceExistingOwnerTransport.js";

async function fixture(maxRestoreBytes: number | null = 1_000_000) {
  let transport!: ReturnType<typeof startExistingOwnerDeviceTransport>, connection: DeviceEngineConnection | undefined;
  let ready!: (client: EngineClient) => void;
  const started = new Promise<EngineClient>(resolve => {ready=resolve;});
  const limits = {maxPayloadBytes:4096,maxPendingBytes:2_000_000} as DeviceControlLimits;
  const start = {type:"liveHost.start" as const,version:1 as const,relayNamespace:"namespace",authToken:"A".repeat(43),
    host:{hostId:"host",hostEpoch:parseHostEpoch(1),instanceId:"instance",connectionId:"connection"},receive:limits};
  const relaySocket = {readyState:1,bufferedAmount:0,send(bytes:Buffer,options:{binary:boolean},done:()=>void) {
    setImmediate(() => {if(options.binary)transport.receive(bytes);else transport.credit(JSON.parse(bytes.toString()).receivedBytes);done();});
  }} as unknown as WebSocket;
  const deviceSocket = {readyState:1,bufferedAmount:0,send(bytes:Buffer,options:{binary:boolean},done:()=>void) {
    setImmediate(() => {
      if(options.binary)connection!.receive(bytes);
      else {
        const value = JSON.parse(bytes.toString());
        if(value.type === "liveHost.transport") {
          connection = new DeviceEngineConnection(relaySocket,limits,value.receive,2_000_000,()=>undefined);
          ready(new EngineClient(connection,{authToken:start.authToken,protocolVersion:2,capabilities:["blobs"],
            maxFrameBytes:1_048_576,privateLiveApplication:{aggregateBytes:200_000_000,maxUploads:2}}));
        } else connection!.credit(value.receivedBytes);
      }
      done();
    });
  }} as unknown as WebSocket;
  const output = Buffer.alloc(600_001,37);
  const native = {ready:async()=>undefined,sendRequest:vi.fn(async()=>({result:{provisioned:true}})),
    sendLiveRestore:vi.fn(async(_request:unknown,_operation:string,_bytes:Uint8Array,_maxBytes:number,_signal?:AbortSignal) => ({response:{result:{}},bytes:output}))};
  const ownerFor = vi.fn(async ()=>{throw Error("A stopped restore must not reacquire its retired owner session.");});
  const stop = vi.fn(()=>connection?.close());
  transport = startExistingOwnerDeviceTransport({config:{client:native as unknown as EngineClient,
    workspaces:[{workspaceId:"workspace",workspaceHandle:"handle"}],ownerFor,maxQueuedBytes:2_000_000,maxFrameBytes:1_048_576,
    maxUploads:2,maxRegistrations:2,aggregateBytes:1_000_000 * 5 + 1_048_576 * 4,maxAdoptionBytes:1_000_000,maxAdoptionEvents:10,maxRestoreBytes:maxRestoreBytes ?? undefined,
    requestDeadlineMs:30_000},start,ws:deviceSocket,limits,stop});
  const peer = await started;await peer.ready();
  const fence = {operation:{operationId:"restore",relayDatabaseNamespace:"namespace",hostId:"host",newFence:2,
    oldBinding:{workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"a".repeat(64),
      currentPath:"a.md",selectorPaths:["a.md"],restoreFenceGeneration:1},origin:{kind:"owner",id:"adoption"},
    terminal:null,appliedSequence:0},localHeadSequence:0,recordedAtMs:10};
  const header = (operation:string) => ({fence,point:{},...(operation === "prepare" ? {} : {candidateDigest:"b".repeat(64),nativeSourceManifestDigest:"c".repeat(64),admitted:{}}),
    ...(operation === "resume" ? {settlementId:"settlement"} : {})});
  const encode = (value:unknown) => encodeNativeRestoreInput(Buffer.from(JSON.stringify(value)),1_000_000);
  return {peer,native,output,ownerFor,stop,header,encode,async close(){await transport.close();peer.close();}};
}

it.each(["prepare","apply","settle","resume"] as const)("forwards bounded private %s and its multi-chunk output on the existing client",async operation=>{
  const f = await fixture();
  try {
    const bytes=f.encode(f.header(operation));
    const response=await f.peer.sendLiveRestore({id:1,workspace:"handle",deadlineMs:30_000},operation,bytes,1_000_000);
    expect(response.bytes).toEqual(f.output);
    expect(response.response.result).toMatchObject({status:({prepare:"prepared",apply:"applied",settle:"settled",resume:"resumed"} as const)[operation]});
    expect(f.native.sendLiveRestore).toHaveBeenCalledOnce();
    const [request,method,forwarded,bound,signal]=f.native.sendLiveRestore.mock.calls[0]!;
    expect(request).toMatchObject({workspace:"handle"});expect(method).toBe(operation);
    expect(Buffer.from(forwarded)).toEqual(Buffer.from(bytes));expect(bound).toBe(1_000_000);expect(signal).toBeInstanceOf(AbortSignal);
    expect(f.ownerFor).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it.each(["workspace","namespace","host","framing","fields"])("refuses changed restore %s before forwarding",async change=>{
  const f=await fixture();
  try{
    const header=f.header("prepare");
    if(change==="workspace")header.fence.operation.oldBinding.workspaceId="foreign";
    if(change==="namespace")header.fence.operation.relayDatabaseNamespace="foreign";
    if(change==="host")header.fence.operation.hostId="foreign";
    if(change==="fields")Object.assign(header,{command:"ydoc.apply"});
    const bytes=f.encode(header);if(change==="framing")bytes[0]=0;
    await expect(f.peer.sendLiveRestore({id:1,workspace:"handle",deadlineMs:30_000},"prepare",bytes,1_000_000)).rejects.toThrow();
    expect(f.native.sendLiveRestore).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it("refuses an oversized native response and returns capacity for a later valid operation",async()=>{
  const f=await fixture();
  try{
    f.native.sendLiveRestore.mockResolvedValueOnce({response:{result:{}},bytes:Buffer.alloc(1_000_001)});
    const request={id:1,workspace:"handle",deadlineMs:30_000},bytes=f.encode(f.header("prepare"));
    await expect(f.peer.sendLiveRestore(request,"prepare",bytes,1_000_000)).rejects.toThrow();
    await expect(f.peer.sendLiveRestore({...request,id:2},"prepare",bytes,1_000_000)).resolves.toHaveProperty("bytes");
    expect(f.stop).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it("uses the caller's smaller output reservation without retiring the connection",async()=>{
  const f=await fixture();
  try{
    const request={id:1,workspace:"handle",deadlineMs:30_000},bytes=f.encode(f.header("prepare"));
    await expect(f.peer.sendLiveRestore(request,"prepare",bytes,600_000)).rejects.toThrow("owner-device-operation-refused");
    expect(f.native.sendLiveRestore.mock.calls[0]![3]).toBe(600_000);
    await expect(f.peer.sendLiveRestore({...request,id:2},"prepare",bytes,600_001)).resolves.toHaveProperty("bytes",f.output);
    expect(f.stop).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it.each([0,1_000_000])("streams a native output of exactly %s bytes",async length=>{
  const f=await fixture();
  try{
    const output=Buffer.alloc(length,13);f.native.sendLiveRestore.mockResolvedValueOnce({response:{result:{}},bytes:output});
    const result=await f.peer.sendLiveRestore({id:1,workspace:"handle",deadlineMs:30_000},"prepare",f.encode(f.header("prepare")),1_000_000);
    expect(result.bytes).toEqual(output);expect(f.stop).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it.each(["prepare","apply","settle","resume"] as const)("refuses invalid %s header fields before native forwarding",async operation=>{
  const f=await fixture();
  try{
    const header:Record<string,unknown>=f.header(operation);
    if(operation==="prepare")header.candidateDigest="b".repeat(64);
    else delete header[operation==="resume" ? "settlementId" : "admitted"];
    await expect(f.peer.sendLiveRestore({id:1,workspace:"handle",deadlineMs:30_000},operation,f.encode(header),1_000_000)).rejects.toThrow();
    expect(f.native.sendLiveRestore).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it.each([null,5])("refuses unconfigured or oversized restore uploads before native forwarding (%s)",async bound=>{
  const f=await fixture(bound);
  try{
    await expect(f.peer.sendLiveRestore({id:1,workspace:"handle",deadlineMs:30_000},"prepare",f.encode(f.header("prepare")),1_000_000)).rejects.toThrow();
    expect(f.native.sendLiveRestore).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it("forwards cancellation to native and releases the restore reservation before reuse",async()=>{
  const f=await fixture(),abort=new AbortController();
  try{
    let began!:()=>void,cancelled!:()=>void;
    const started=new Promise<void>(resolve=>{began=resolve;});
    const ended=new Promise<void>(resolve=>{cancelled=resolve;});
    f.native.sendLiveRestore.mockImplementationOnce(async(_request,_operation,_bytes,_bound,signal)=>new Promise((_,reject)=>{
      signal!.addEventListener("abort",()=>{cancelled();reject(signal!.reason);},{once:true});began();
    }));
    const request={id:1,workspace:"handle",deadlineMs:30_000},bytes=f.encode(f.header("prepare"));
    const pending=f.peer.sendLiveRestore(request,"prepare",bytes,1_000_000,abort.signal);
    const rejected=expect(pending).rejects.toThrow();
    await started;
    // This response proves the upload's final write drained before cancellation.
    await f.peer.sendRequest({id:2,method:"liveApplication.hosts",params:{},deadlineMs:30_000});
    abort.abort(new Error("Restore caller retired."));await rejected;await ended;
    await expect(f.peer.sendLiveRestore({...request,id:3},"prepare",bytes,1_000_000)).resolves.toHaveProperty("bytes");
    expect(f.native.sendLiveRestore).toHaveBeenCalledTimes(2);expect(f.stop).not.toHaveBeenCalled();
  }finally{abort.abort();await f.close();}
});
