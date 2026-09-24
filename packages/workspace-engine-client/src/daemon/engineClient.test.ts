import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseRelayAcceptedLiveUpdate } from "@dohc/live-session-contract";
import type { Envelope, Request, JsonValue } from "../protocol";
import { isDaemonReconnectError } from "../live/daemonLiveAdapter";
import { encodeNativeRestoreInput } from "./nativeRestore";
import {
  EngineClient,
  EngineClientError,
  DuplexEngineClientConnection,
  EngineFrameError,
  EngineRequestDeadlineError,
  EngineRequestError,
  FrameDecoder,
  FrameType,
  encodeFrame,
  type EngineClientConnectOptions,
  type EngineClientConnection,
} from "./engineClient";

const LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxBlobChunkBytes: 64 * 1024,
  maxStringBytes: 64 * 1024,
  maxCollectionLen: 1024,
  maxBatchLen: 64,
  maxJsonDepth: 32,
};

describe("private owner delivery transport", () => {
  const request={id:970,workspace:"workspace",deadlineMs:30_000};
  const target={binding:{workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"cd".repeat(32),currentPath:"a.md",selectorPaths:["a.md"],restoreFenceGeneration:0},relayDatabaseNamespace:"relay"};
  it("discovers durable drafts, opens their binary state and appends without a caller base", async () => {
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge();await transport.ready();
    const descriptor={...target,revision:1,acceptedCursor:0,nativeHeadSequence:2,outboxId:null,pendingBytes:0,state:null};
    let wireId=0,digest="";
    peer.onEnvelope=e=>{
      if(e.type!=="request")return;
      if(e.method==="ydoc.ownerDelivery.listDrafts") peer.send({type:"response",id:e.id,result:{drafts:[descriptor],next:null}});
      else if(e.method==="ydoc.ownerDelivery.openDraft") {
        const bytes=Buffer.from([0,0]),sha=createHash("sha256").update(bytes).digest("hex");
        peer.send({type:"blobStart",requestId:e.id,streamId:e.id,totalBytes:2,sha256:sha});peer.sendRaw(blobChunkFrame(e.id,bytes,true));
        peer.send({type:"response",id:e.id,result:{status:"draft",draft:descriptor,streamId:e.id,byteLength:2,digest:sha}});
      } else { expect(e.method).toBe("ydoc.ownerDelivery.appendDraft");expect(e.params).not.toHaveProperty("baseUpdate");expect(e.params).not.toHaveProperty("registrationId");wireId=e.id;digest=(e.params as Record<string,string>).digest; }
    };
    peer.onBlobChunk=frame=>{if(frame.fin)peer.send({type:"response",id:wireId,result:{outboxId:"outbox",sequence:1,deliveryId:"delivery",updateDigest:digest,pendingBytes:2,oldestEntryAtMs:3,state:"active"}});};
    try {
      expect(await transport.ownerYDocListDrafts(request,{after:null,limit:8})).toEqual({drafts:[descriptor],next:null});
      expect(await transport.ownerYDocOpenDraft({...request,id:971},{binding:target.binding,expectedRevision:1})).toEqual({draft:descriptor,initialUpdate:Buffer.from([0,0])});
      expect(await transport.ownerYDocAppendDraft({...request,id:972},{binding:target.binding,expectedRevision:1,appendKey:"edit",updateBytes:Uint8Array.of(0,0)})).toMatchObject({outboxId:"outbox",sequence:1,pendingBytes:2});
    } finally {transport.close();}
  });
  it("captures native state and enrolls an exact binary host cut without caller limits", async () => {
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge(); await transport.ready();
    const captured={nativeHeadSequence:2,localStateDigest:"ab".repeat(32)}, draft={...target,revision:1,acceptedCursor:9,nativeHeadSequence:3,outboxId:"pending",pendingBytes:2,state:"active"};
    let wireId=0;const chunks:Buffer[]=[];
    peer.onEnvelope=e=>{if(e.type!=="request")return;
      if(e.method==="ydoc.ownerDelivery.prepareEnrollment") {expect(e.params).toEqual(target);peer.send({type:"response",id:e.id,result:{status:"capture",captured}});}
      else {expect(e.method).toBe("ydoc.ownerDelivery.enroll");expect(e.params).toMatchObject({...target,captured,journalCursor:9,hostVectorByteLength:1});expect(e.params).not.toHaveProperty("limits");wireId=e.id;}
    };
    peer.onBlobChunk=frame=>{chunks.push(Buffer.from(frame.payload));if(frame.fin)peer.send({type:"response",id:wireId,result:{draft}});};
    try {
      expect(await transport.ownerYDocPrepareEnrollment(request,target)).toEqual({status:"capture",captured});
      expect(await transport.ownerYDocEnroll({...request,id:971},{...target,captured,journalCursor:9,hostVector:Uint8Array.of(0),checkpoint:Uint8Array.of(0,0)})).toEqual(draft);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0,0,0]));
    } finally {transport.close();}
  });
  it("reads a bounded accepted vector without a host registration", async () => {
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge();await transport.ready();
    peer.onEnvelope=e=>{
      if(e.type!=="request")return;
      expect(e.method).toBe("ydoc.ownerDelivery.readState");expect(e.params).toEqual(target);
      const bytes=Buffer.from([0]),digest=createHash("sha256").update(bytes).digest("hex");
      peer.send({type:"blobStart",requestId:e.id,streamId:e.id,totalBytes:1,sha256:digest});
      peer.sendRaw(blobChunkFrame(e.id,bytes,true));
      peer.send({type:"response",id:e.id,result:{status:"state",revision:2,acceptedCursor:19,nativeHeadSequence:3,streamId:e.id,byteLength:1,digest}});
    };
    try { expect(await transport.ownerYDocReadState(request,target)).toEqual({revision:2,acceptedCursor:19,nativeHeadSequence:3,stateVector:Buffer.from([0])}); }
    finally {transport.close();}
  });
  it("streams a 20 MiB update with a separate host vector and retains its cut", async () => {
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge();await transport.ready();
    let wireId=0;const chunks:Buffer[]=[];
    peer.onEnvelope=e=>{if(e.type!=="request")return;wireId=e.id;expect(e.method).toBe("ydoc.ownerDelivery.applyInitialSync");expect(e.params).not.toHaveProperty("registrationId");expect(e.params).toHaveProperty("hostVectorByteLength",1);};
    peer.onBlobChunk=frame=>{chunks.push(Buffer.from(frame.payload));if(frame.fin)peer.send({type:"response",id:wireId,result:{revision:2,acceptedCursor:19,nativeHeadSequence:3}});};
    const updateBytes=Buffer.alloc(20*1024*1024,7);
    try {
      expect(await transport.ownerYDocApplyInitialSync(request,{...target,expectedRevision:1,expectedNativeHeadSequence:2,previousAcceptedCursor:0,journalCursor:19,updateBytes,hostVector:Uint8Array.of(0)})).toEqual({revision:2,acceptedCursor:19,nativeHeadSequence:3});
      const bytes=Buffer.concat(chunks);expect(bytes.length).toBe(updateBytes.length+1);expect(bytes[0]).toBe(0);expect(bytes.subarray(1).equals(updateBytes)).toBe(true);
    } finally {transport.close();}
  });
  it("checks receipt containment separately and rejects a mismatched applied cursor", async () => {
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge();await transport.ready();let wireId=0;
    peer.onEnvelope=e=>{if(e.type!=="request")return;wireId=e.id;if(e.method==="ydoc.ownerDelivery.isReceiptApplied")peer.send({type:"response",id:e.id,result:{applied:false}});};
    peer.onBlobChunk=frame=>{if(frame.fin)peer.send({type:"response",id:wireId,result:{revision:2,acceptedCursor:18,nativeHeadSequence:3}});};
    try {
      expect(await transport.ownerYDocIsReceiptApplied(request,{...target,receipt:{deliveryId:"delivery",updateDigest:"ab".repeat(32),journalCursor:19,acceptingHostEpoch:1}})).toBe(false);
      await expect(transport.ownerYDocApplyAcceptedFrame({...request,id:971},{...target,expectedRevision:1,expectedNativeHeadSequence:2,previousAcceptedCursor:0,journalCursor:19,updateBytes:Uint8Array.of(0,0)})).rejects.toThrow("differs from request");
    } finally {transport.close();}
  });
});

describe("private imported owner capture", () => {
  it("captures on an attached workspace before registration and preserves a shared client on cancellation", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 } });
    peer.acknowledge(); await transport.ready();
    const closed = vi.spyOn(peer, "close");
    const arrived = Promise.withResolvers<void>();
    let respond = false, retained = false;
    const baseline = Buffer.from([0, 0]), full = Buffer.from([1, 1, 1]), bytes = Buffer.concat([baseline, full]);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    peer.onEnvelope = envelope => {
      if (envelope.type !== "request") return;
      expect(envelope.method).toBe("liveApplication.captureOwnerActivation");
      expect(envelope.params).toEqual({ path: "owner.md", maxBytes: 1000, ...(retained ? {activationId:`ordinary-activation-${"a".repeat(64)}`} : {}) });
      arrived.resolve();
      if (!respond) return;
      const id = envelope.id;
      peer.send({ type: "blobStart", requestId: id, streamId: id, totalBytes: bytes.length, sha256: digest(bytes) });
      peer.sendRaw(blobChunkFrame(id, bytes, true));
      peer.send({ type: "response", id, result: {
        status: "captured", activationId: `ordinary-activation-${"a".repeat(64)}`, sessionId: "native-session",
        baselineByteLength: baseline.length, streamId: id, byteLength: bytes.length, digest: digest(bytes),
        source: { version: 1, relayDatabaseNamespace: "relay", workspaceId: "workspace", mainVersionId: "main",
          objectId: "object", lineageClaimId: digest(baseline), currentPath: "owner.md", replicationEpoch: "epoch",
          streamIdentity: "stream", committedCursor: 10, baseOriginId: "peer", baseOriginSeq: 2, baseRelaySeq: 8,
          sourceMomentId: "source", sourceDigest: digest(Buffer.from("source")), sourceByteLength: 6,
          nativeHeadSequence: 1, fullStateDigest: digest(full), fullStateByteLength: full.length },
      } });
    };
    try {
      const request = { id: 975, workspace: "workspace", deadlineMs: 30_000 };
      const abort = new AbortController();
      const pending = transport.captureOwnerActivation(request, "owner.md", 1000, abort.signal);
      const rejected = expect(pending).rejects.toThrow();
      await arrived.promise; abort.abort(); await rejected;
      expect(closed).not.toHaveBeenCalled();
      respond = true;
      const captured = await transport.captureOwnerActivation({ ...request, id: 976 }, "owner.md", 1000);
      expect(captured.sessionId).toBe("native-session");
      expect(captured.fullState).toEqual(full);
      retained = true;
      const resumed = await transport.captureOwnerActivation({...request,id:977}, "owner.md", 1000, undefined, captured.activationId);
      expect(resumed.activationId).toBe(captured.activationId);
      expect(resumed.source).toEqual(captured.source);
    } finally { transport.close(); }
  });
});

describe("private applied sync transport",()=>{
  const request={id:970,workspace:"workspace",registrationId:7,deadlineMs:30_000};
  const position={eventCount:0,journalCursor:0,evidenceDigest:"ab".repeat(32)};
  const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"cd".repeat(32),currentPath:"a.md",selectorPaths:["a.md"],restoreFenceGeneration:0};
  const outputBytes=Buffer.from([0,0,0]);
  function output(peer:FakePeerConnection,id:number,result:Record<string,JsonValue>,bytes=outputBytes) {
    const digest=createHash("sha256").update(bytes).digest("hex");
    peer.send({type:"blobStart",requestId:id,streamId:id,totalBytes:bytes.length,sha256:digest});
    peer.sendRaw(blobChunkFrame(id,bytes,true));
    peer.send({type:"response",id,result:{...result,streamId:id,byteLength:bytes.length,digest}});
  }
  it.each(["queued", "header", "chunk", "final"] as const)("finishes reserved sync input after cancellation at %s without closing another reader", async mode => {
    const peer = new FakePeerConnection(), transport = client(peer, {privateLiveApplication: {aggregateBytes: 128*1024*1024,maxUploads: 1}});
    peer.acknowledge(); await transport.ready();
    const closed = vi.spyOn(peer, "close"), reached = Promise.withResolvers<void>();
    const vector = Buffer.alloc(2 * LIMITS.maxBlobChunkBytes + 1, 7), expectedVector = vector.slice();
    const chunks: Buffer[] = [];
    let blockerId = 0, wireId = 0, held = false;
    const hold = () => {if (!held) {held = true; peer.backpressured = true; reached.resolve();}};
    peer.onEnvelope = envelope => {
      if (envelope.type !== "request") return;
      if (envelope.method === "blocker") {blockerId = envelope.id; hold();}
      else if (envelope.method === "liveApplication.syncOpen") {wireId = envelope.id; if (mode === "header") hold();}
      else if (envelope.method === "liveApplication.appliedRead") peer.send({type: "response",id: envelope.id,result: {status: "empty",after: position}});
      else if (envelope.method === "liveApplication.ack") peer.send({type: "response",id: envelope.id,result: {status: "missing"}});
    };
    peer.onBlobChunk = frame => {
      chunks.push(Buffer.from(frame.payload));
      if (mode === "chunk" && !frame.fin || mode === "final" && frame.fin) hold();
    };
    const signal = new AbortController();
    let blocker: Promise<unknown> | undefined;
    try {
      if (mode === "queued") {blocker = transport.sendRequest({id: 969,method: "blocker",params: {},deadlineMs: 30_000}); void blocker.catch(() => {}); await reached.promise;}
      const sync = transport.openLiveAppliedSync(request,vector,{maxInputBytes: vector.length,maxOutputBytes: 32},signal.signal);
      const cancelled = sync.catch(error => error);
      if (mode !== "queued") await reached.promise;
      signal.abort(new Error("browser closed"));
      expect(closed).not.toHaveBeenCalled();
      await expect(transport.readNextLiveApplied({...request,id: 971},position,32)).rejects.toThrow("capacity is full");
      if (blockerId) peer.send({type: "response",id: blockerId,result: {done: true}});
      peer.drain(); await blocker;
      expect(await cancelled).toBeInstanceOf(EngineClientError);
      expect(Buffer.concat(chunks)).toEqual(expectedVector);
      expect(await transport.readNextLiveApplied({...request,id: 972},position,32)).toBeNull();
      expect(await transport.readLiveApplicationAck({...request,id: 973},{deliveryId: "delivery",updateDigest: "ab".repeat(32)})).toBeNull();
      expect(peer.received).toContainEqual({type: "cancel",id: wireId});
      expect(closed).not.toHaveBeenCalled();
    } finally {peer.drain(); transport.close();}
  });
  it.each(["answered", "unanswered"] as const)("rejects duplicate sync responses after cancelling %s final input", async mode => {
    const peer = new FakePeerConnection(), transport = client(peer, {privateLiveApplication: {aggregateBytes: 128*1024*1024, maxUploads: 1}});
    peer.acknowledge(); await transport.ready();
    const closed = vi.spyOn(peer, "close"), reached = Promise.withResolvers<void>();
    let wireId = 0;
    peer.onEnvelope = envelope => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    peer.onBlobChunk = frame => {
      if (!frame.fin) return;
      peer.backpressured = true;
      if (mode === "answered") output(peer, wireId, {status: "sync", binding, position,
        observedLocalYDocHeadSequence: 5, hostVectorByteLength: 1});
      reached.resolve();
    };
    const signal = new AbortController();
    try {
      const sync = transport.openLiveAppliedSync(request, Uint8Array.of(0), {maxInputBytes: 8, maxOutputBytes: 32}, signal.signal);
      const cancelled = expect(sync).rejects.toThrow("cancelled");
      await reached.promise;
      signal.abort(); peer.drain(); await cancelled;
      expect(peer.received).toContainEqual({type: "cancel", id: wireId});
      expect(closed).not.toHaveBeenCalled();
      if (mode === "unanswered") {
        peer.send({type: "response", id: wireId, result: {status: "cancelled"}});
        expect(closed).not.toHaveBeenCalled();
      }
      peer.send({type: "response", id: wireId, result: {status: "duplicate"}});
      expect(closed).toHaveBeenCalledOnce();
      await expect(transport.sendRequest({id: 971, method: "after-duplicate", params: {}}))
        .rejects.toMatchObject({code: "protocol-error"});
    } finally {peer.drain(); transport.close();}
  });
  it.each(["queued", "written"] as const)("cancels a %s applied read without retiring the shared client", async mode => {
    const peer = new FakePeerConnection(), transport = client(peer, {privateLiveApplication: {aggregateBytes: 128*1024*1024,maxUploads: 1}});
    peer.acknowledge(); await transport.ready();
    const blocked = Promise.withResolvers<void>();
    let firstRead = true, blockerId = 0;
    peer.onEnvelope = envelope => {
      if (envelope.type !== "request") return;
      if (envelope.method === "blocker") {blockerId = envelope.id; peer.backpressured = true; blocked.resolve();}
      else if (envelope.method === "liveApplication.appliedRead") {
        if (mode === "written" && firstRead) {firstRead = false; peer.backpressured = true; blocked.resolve(); return;}
        peer.send({type: "response",id: envelope.id,result: {status: "empty",after: position}});
      } else if (envelope.method === "liveApplication.ack") peer.send({type: "response",id: envelope.id,result: {status: "missing"}});
    };
    const signal = new AbortController();
    let blocker: Promise<unknown> | undefined;
    try {
      if (mode === "queued") {
        blocker = transport.sendRequest({id: 969,method: "blocker",params: {},deadlineMs: 30_000});
        void blocker.catch(() => {}); await blocked.promise;
      }
      const read = transport.readNextLiveApplied(request,position,32,signal.signal);
      const cancelled = expect(read).rejects.toThrow("reader cancelled");
      if (mode === "written") await blocked.promise;
      signal.abort(new Error("reader cancelled")); await cancelled;
      if (blockerId) peer.send({type: "response",id: blockerId,result: {done: true}});
      peer.drain(); await blocker;
      expect(await transport.readNextLiveApplied({...request,id: 971},position,32)).toBeNull();
      expect(await transport.readLiveApplicationAck({...request,id: 972},{deliveryId: "delivery",updateDigest: "ab".repeat(32)})).toBeNull();
    } finally {peer.drain(); transport.close();}
  });
  it.each(["valid","vector-length","extra","position"])("checks %s sync output",async mode=>{
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge();await transport.ready();let id=0;
    peer.onEnvelope=e=>{if(e.type!=="request")return;id=e.id;expect(e.method).toBe("liveApplication.syncOpen");expect(e.params).toHaveProperty("registrationId",7);};
    peer.onBlobChunk=frame=>{if(frame.fin)output(peer,id,{status:"sync",binding,position:mode==="position"?{...position,eventCount:2}:position,
      observedLocalYDocHeadSequence:5,hostVectorByteLength:mode==="vector-length"?2:1,...(mode==="extra"?{extra:true}:{})});};
    try {
      const call=transport.openLiveAppliedSync(request,Uint8Array.of(0),{maxInputBytes:8,maxOutputBytes:32});
      if(mode==="valid") {const cut=await call;expect(cut.hostVector).toEqual(Buffer.from([0]));expect(cut.missingStateUpdate).toEqual(Buffer.from([0,0]));expect(cut.observedLocalYDocHeadSequence).toBe(5);}
      else await expect(call).rejects.toThrow();
    }finally{transport.close();}
  });
  it.each(["update","empty","gap","wrong-digest","empty-with-blob"])("checks %s applied feed output",async mode=>{
    const peer=new FakePeerConnection(),transport=client(peer,{privateLiveApplication:{aggregateBytes:128*1024*1024,maxUploads:1}});
    peer.acknowledge();await transport.ready();
    peer.onEnvelope=e=>{
      if(e.type!=="request")return;expect(e.method).toBe("liveApplication.appliedRead");
      if(mode==="empty") {peer.send({type:"response",id:e.id,result:{status:"empty",after:position}});return;}
      if(mode==="empty-with-blob") {output(peer,e.id,{status:"empty",after:position});return;}
      const digest=createHash("sha256").update(outputBytes).digest("hex");
      output(peer,e.id,{status:"update",position:{eventCount:mode==="gap"?2:1,journalCursor:11,evidenceDigest:"ef".repeat(32)},
        ack:{deliveryId:"delivery",updateDigest:mode==="wrong-digest"?"aa".repeat(32):digest,journalCursor:11,acceptingHostEpoch:1,localYDocSequence:1,applicationReplayed:true}});
    };
    try {
      const call=transport.readNextLiveApplied(request,position,32);
      if(mode==="update")expect((await call)?.position.journalCursor).toBe(11);
      else if(mode==="empty")expect(await call).toBeNull();
      else await expect(call).rejects.toThrow();
    }finally{transport.close();}
  });
});

describe("private application ACK read", () => {
  const call = { id: 920, workspace: "workspace", registrationId: 7, deadlineMs: 30_000 };
  const identity = { deliveryId: "delivery", updateDigest: "ab".repeat(32) };
  it.each(["historical", "missing", "wrong-id", "wrong-digest", "relay-receipt", "not-replayed", "extra"])("handles %s evidence", async mode => {
    const peer = new FakePeerConnection(), transport = client(peer);
    peer.acknowledge(); await transport.ready();
    const ack = { ...identity, journalCursor: 4, acceptingHostEpoch: 1, localYDocSequence: 2, applicationReplayed: true };
    peer.onEnvelope = envelope => {
      if (envelope.type !== "request") return;
      expect(envelope.method).toBe("liveApplication.ack");
      expect(envelope.params).toEqual({ registrationId: 7, ...identity });
      let result: Extract<Envelope, { type: "response" }>["result"] = { status: "applied", ack: { ...ack,
        ...(mode === "wrong-id" ? { deliveryId: "other" } : {}),
        ...(mode === "wrong-digest" ? { updateDigest: "cd".repeat(32) } : {}),
        ...(mode === "not-replayed" ? { applicationReplayed: false } : {}),
      } };
      if (mode === "missing") result = { status: "missing" };
      if (mode === "relay-receipt") result = { status: "applied", ack: { ...identity, journalCursor: 4, acceptingHostEpoch: 1 } };
      if (mode === "extra") result = { status: "missing", ack };
      peer.send({ type: "response", id: envelope.id, result });
    };
    try {
      const pending = transport.readLiveApplicationAck(call, identity);
      if (mode === "historical") expect(await pending).toEqual(ack);
      else if (mode === "missing") expect(await pending).toBeNull();
      else await expect(pending).rejects.toThrow();
    } finally { transport.close(); }
  });
});

describe("private native restore transport", () => {
  const input = encodeNativeRestoreInput(Buffer.from('{"fence":{}}'), 128);
  it("frames one bounded restore header without a caller-supplied owner cut", () => {
    const header = Buffer.from('{"fence":{}}'), encoded = encodeNativeRestoreInput(header, header.length + 4);
    expect(new DataView(encoded.buffer).getUint32(0, true)).toBe(header.length);
    expect(encoded.subarray(4)).toEqual(new Uint8Array(header));
    expect(encoded.length).toBe(header.length + 4);
    expect(() => encodeNativeRestoreInput(header, header.length + 3)).toThrow();
    expect(() => encodeNativeRestoreInput(new Uint8Array(), 128)).toThrow();
  });
  const call = { id: 903, workspace: "ws-0000000000000001", deadlineMs: 30_000 };
  async function connected() {
    const peer = new FakePeerConnection();
    const transport = client(peer, { privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 } });
    peer.acknowledge();
    await transport.ready();
    return { peer, transport };
  }
  function reply(peer: FakePeerConnection, wireId: number, bytes = Buffer.from("raw receipt"), status = "applied") {
    const digest = createHash("sha256").update(bytes).digest("hex");
    peer.send({ type: "blobStart", requestId: wireId, streamId: wireId, totalBytes: bytes.length, sha256: digest });
    peer.sendRaw(blobChunkFrame(wireId, bytes, true));
    peer.send({ type: "response", id: wireId, result: { status, streamId: wireId, byteLength: bytes.length, digest } });
  }
  it("sends host-scoped binary input and retains raw output through its final descriptor", async () => {
    const { peer, transport } = await connected();
    let wireId = -1;
    peer.onEnvelope = envelope => {
      if (envelope.type !== "request") return;
      wireId = envelope.id;
      expect(envelope.method).toBe("liveApplication.applyRestore");
      expect(envelope.params).not.toHaveProperty("registrationId");
      expect(envelope.params).toHaveProperty("maxOutputBytes",128);
    };
    peer.onBlobChunk = frame => { if (frame.fin) reply(peer, wireId); };
    try {
      const result = await transport.sendLiveRestore(call, "apply", input, 128);
      expect(result.response.id).toBe(call.id);
      expect(result.bytes.toString()).toBe("raw receipt");
    } finally { transport.close(); }
  });
  it("rejects an unsatisfiable restore bound before sending the request",async()=>{
    const {peer,transport}=await connected();
    const requests=vi.fn();peer.onEnvelope=requests;
    try{
      await expect(transport.sendLiveRestore(call,"prepare",input,64*1024*1024+1)).rejects.toThrow("Invalid native restore bounds");
      expect(requests).not.toHaveBeenCalled();
    }finally{transport.close();}
  });
  it.each(["too large", "unknown length", "duplicate", "missing blob", "wrong digest", "wrong status"])("refuses %s restore output", async mode => {
    const { peer, transport } = await connected();
    let wireId = -1;
    peer.onEnvelope = envelope => { if (envelope.type === "request") wireId = envelope.id; };
    peer.onBlobChunk = frame => {
      if (!frame.fin) return;
      if (mode === "missing blob") {
        peer.send({ type: "response", id: wireId, result: { status: "applied" } });
      } else if (mode === "wrong status") reply(peer, wireId, Buffer.from("raw"), "settled");
      else {
        peer.send({ type: "blobStart", requestId: wireId, streamId: wireId,
          totalBytes: mode === "unknown length" ? null : mode === "too large" ? 129 : 3, sha256: "a".repeat(64) });
        if (mode === "duplicate") peer.send({ type: "blobStart", requestId: wireId, streamId: wireId + 1, totalBytes: 3, sha256: "a".repeat(64) });
        if (mode === "wrong digest") peer.sendRaw(blobChunkFrame(wireId, Buffer.from("raw"), true));
      }
    };
    try { await expect(transport.sendLiveRestore(call, "apply", input, 128)).rejects.toThrow(); }
    finally { transport.close(); }
  });
  it("releases a cancelled partial response before accepting the next reserved request", async () => {
    const { peer, transport } = await connected();
    let wireId = -1;
    let uploadDone!: () => void;
    const drained = new Promise<void>(resolve => { uploadDone = resolve; });
    peer.onEnvelope = envelope => {
      if (envelope.type !== "request") return;
      if (envelope.method === "barrier") peer.send({ type: "response", id: envelope.id, result: {} });
      else wireId = envelope.id;
    };
    peer.onBlobChunk = frame => { if (frame.fin) uploadDone(); };
    const controller = new AbortController();
    const pending = transport.sendLiveRestore(call, "apply", input, 128, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    try {
      await drained;
      // Yield through the actual write completion before cancelling.
      await transport.sendRequest({ ...request(999, "barrier"), deadlineMs: 30_000 });
      const oldId = wireId;
      const bytes = Buffer.from("raw");
      peer.send({ type: "blobStart", requestId: oldId, streamId: oldId, totalBytes: 3, sha256: createHash("sha256").update(bytes).digest("hex") });
      peer.sendRaw(blobChunkFrame(oldId, bytes.subarray(0, 1), false));
      controller.abort();
      await rejected;
      peer.sendRaw(blobChunkFrame(oldId, bytes.subarray(1), true));
      peer.onBlobChunk = frame => { if (frame.fin) reply(peer, wireId); };
      await expect(transport.sendLiveRestore({ ...call, id: 904 }, "apply", input, 128)).resolves.toHaveProperty("bytes");
    } finally { controller.abort(); transport.close(); }
  });
});

function helloAck(
  limits: typeof LIMITS = LIMITS,
  capabilities: string[] = ["core", "blobs"],
): Extract<Envelope, { type: "helloAck" }> {
  return {
    type: "helloAck",
    protocolVersion: 2,
    sessionGeneration: 7,
    capabilities,
    limits,
  };
}

function event(seq = 1): Extract<Envelope, { type: "event" }> {
  return {
    type: "event",
    seq,
    sessionGeneration: 7,
    name: "workspace.changed",
    payload: { paths: ["note.md"] },
  };
}

function envelopeFrame(
  envelope: Envelope,
  maxFrameBytes = LIMITS.maxFrameBytes,
): Buffer {
  return encodeFrame(
    1,
    0,
    Buffer.from(JSON.stringify(envelope), "utf8"),
    maxFrameBytes,
  );
}

function blobChunkFrame(
  streamId: number,
  bytes: Buffer,
  fin: boolean,
  maxBlobChunkBytes = LIMITS.maxBlobChunkBytes,
): Buffer {
  return encodeFrame(
    FrameType.BlobChunk,
    fin ? 1 : 0,
    { streamId, bytes },
    maxBlobChunkBytes,
  );
}

class FakePeerConnection implements EngineClientConnection {
  readonly received: Envelope[] = [];
  onEnvelope: ((envelope: Envelope) => void) | null = null;
  onBlobChunk: ((frame: Extract<ReturnType<FrameDecoder["push"]>[number], { kind: "blobChunk" }>) => void) | null = null;
  private readonly decoder = new FrameDecoder(LIMITS.maxFrameBytes);
  private readonly dataHandlers = new Set<(chunk: Buffer | Uint8Array) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  private readonly drainHandlers = new Set<() => void>();
  backpressured = false;
  private closed = false;

  write(buffer: Buffer): boolean {
    if (this.closed) throw new Error("fake peer is closed");
    for (const frame of this.decoder.push(buffer)) {
      if (frame.kind === "blobChunk") {
        this.onBlobChunk?.(frame);
        continue;
      }
      const envelope = JSON.parse(frame.payload.toString("utf8")) as Envelope;
      this.received.push(envelope);
      this.onEnvelope?.(envelope);
    }
    return !this.backpressured;
  }

  send(envelope: Envelope, chunkSize = Number.POSITIVE_INFINITY): void {
    const frame = envelopeFrame(envelope);
    for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
      const chunk = frame.subarray(offset, Math.min(frame.byteLength, offset + chunkSize));
      for (const handler of [...this.dataHandlers]) handler(chunk);
    }
  }

  sendRaw(chunk: Buffer): void {
    for (const handler of [...this.dataHandlers]) handler(chunk);
  }

  acknowledge(): void {
    this.send(helloAck());
  }

  closeFromPeer(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler();
  }

  failFromPeer(error: unknown): void {
    for (const handler of [...this.errorHandlers]) handler(error);
  }

  onData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.dataHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandlers.add(handler);
  }

  onDrain(handler: () => void): void {
    this.drainHandlers.add(handler);
  }

  drain(): void {
    this.backpressured = false;
    for (const handler of [...this.drainHandlers]) handler();
  }

  offData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.dataHandlers.delete(handler);
  }

  offClose(handler: () => void): void {
    this.closeHandlers.delete(handler);
  }

  offError(handler: (error: unknown) => void): void {
    this.errorHandlers.delete(handler);
  }

  offDrain(handler: () => void): void {
    this.drainHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
  }
}

function client(
  peer: FakePeerConnection,
  options: Partial<EngineClientConnectOptions> = {},
): EngineClient {
  return new EngineClient(peer, {
    authToken: "parent-secret",
    protocolVersion: 2,
    capabilities: ["core", "ydoc", "blobs"],
    connectTimeoutMs: 5_000,
    maxFrameBytes: LIMITS.maxFrameBytes,
    ...options,
  });
}

function request(id: number, method: string): Request {
  return { id, method, params: { method } };
}

function realStreamClient(connectTimeoutMs = 5_000): {
  transport: EngineClient;
  readable: PassThrough;
} {
  const readable = new PassThrough();
  const writable = new PassThrough();
  writable.resume();
  const duplex = Duplex.from({ readable, writable });
  return {
    transport: new EngineClient(
      new DuplexEngineClientConnection(duplex),
      {
        authToken: "parent-secret",
        protocolVersion: 2,
        capabilities: ["core"],
        connectTimeoutMs,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
    ),
    readable,
  };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("outbound backpressure", () => {
  it("holds later frames until drain and releases the writer on close", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const firstWritten = Promise.withResolvers<void>();
    const secondWritten = Promise.withResolvers<void>();
    peer.onEnvelope = (envelope) => {
      if (envelope.type !== "request") return;
      if (envelope.method === "first") {
        peer.backpressured = true;
        firstWritten.resolve();
      } else {
        secondWritten.resolve();
      }
    };
    const first = transport.sendRequest(request(1, "first")).catch((error: unknown) => error);
    await firstWritten.promise;
    const secondRequest = request(2, "second");
    const second = transport.sendRequest(secondRequest).catch((error: unknown) => error);
    await nextImmediate();
    secondRequest.params = { method: "caller-mutated" };
    await nextImmediate();
    expect(peer.received.filter((envelope) => envelope.type === "request")).toHaveLength(1);
    peer.drain();
    await secondWritten.promise;
    expect(peer.received.find((envelope) => envelope.type === "request" && envelope.method === "second"))
      .toMatchObject({ params: { method: "second" } });
    peer.closeFromPeer();
    expect(await first).toBeInstanceOf(EngineClientError);
    expect(await second).toBeInstanceOf(EngineClientError);
  });

  it("rejects requests waiting for drain when the connection closes", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const written = Promise.withResolvers<void>();
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") {
        peer.backpressured = true;
        written.resolve();
      }
    };
    const first = transport.sendRequest(request(1, "first")).catch((error: unknown) => error);
    await written.promise;
    const second = transport.sendRequest(request(2, "second")).catch((error: unknown) => error);
    transport.close();
    expect(await first).toBeInstanceOf(EngineClientError);
    expect(await second).toBeInstanceOf(EngineClientError);
    peer.drain();
    expect(peer.received.filter((envelope) => envelope.type === "request")).toHaveLength(1);
  });
});

describe.each(["application", "bootstrap"] as const)(
  "private %s upload lifetime",
  (kind) => {
    const streamCount = kind === "application" ? 2 : 1;
    const upload = (
      transport: EngineClient,
      ...args: Parameters<EngineClient["sendLiveApplication"]>
    ) =>
      kind === "application"
        ? transport.sendLiveApplication(...args)
        : transport.sendLiveBootstrap(
            args[0],
            {
              bootstrapId: "bootstrap",
              bootstrapMomentId: "moment",
              baselineMomentRelaySequence: 1,
              baselineRegisteredAtMs: 0,
              baselineDigest: args[1].metadata.accepted.receipt.updateDigest,
              projectedMarkdownDigest: "a".repeat(64),
              projectedMarkdownByteLength: 0,
              baselineBytes: args[1].updateBytes,
            },
            args[2],
          );
  it.each(["local chunk", "local blob budget", "negotiated chunk"])("refuses a zero %s before writing an upload", async mode => {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      ...(mode === "local chunk" ? {maxBlobChunkBytes:0} : mode === "local blob budget" ? {maxBlobBytes:0} : {}),
    });
    peer.send(helloAck({...LIMITS,maxBlobChunkBytes:mode === "negotiated chunk" ? 0 : LIMITS.maxBlobChunkBytes}));
    await transport.ready();
    const bytes = new Uint8Array([0, 0]);
    const accepted = parseRelayAcceptedLiveUpdate({
      receipt: { deliveryId: "delivery", updateDigest: createHash("sha256").update(bytes).digest("hex"), journalCursor: 1, acceptingHostEpoch: 1 },
      binding: { workspaceId: "workspace", mainVersionId: "main", objectId: "one", lineageClaimId: "a".repeat(64), currentPath: "one.md", selectorPaths: ["one.md"], restoreFenceGeneration: 0 },
      authority: { principalKind: "owner", principalId: "owner", grantId: null, grantGeneration: null }, receivedAtMs: 0,
    });
    peer.onBlobChunk = () => { transport.close(); throw new Error("A refused upload wrote a chunk."); };
    try {
      for (const id of [1,2]) await expect(upload(transport,
        {id,workspace:"ws-0000000000000001",registrationId:1,deadlineMs:30_000},
        {metadata:{accepted,firstSeen:[]},updateBytes:bytes},
      )).rejects.toThrow("require a positive blob chunk limit");
      expect(peer.received.filter(envelope=>envelope.type === "request" || envelope.type === "blobStart")).toEqual([]);
      peer.onEnvelope = envelope => { if(envelope.type === "request")peer.send({type:"response",id:envelope.id,result:{}}); };
      await expect(transport.sendRequest(request(3,"after.refusal"))).resolves.toMatchObject({result:{}});
    } finally { transport.close(); }
  });
    it.each(["busy", "deadline", "abort", "abort-without-reply"])(
      "keeps the connection after a fully drained upload reaches %s",
      async (mode) => {
        const peer = new FakePeerConnection();
        const transport = client(peer, {
          privateLiveApplication: {
            aggregateBytes: 128 * 1024 * 1024,
            maxUploads: 1,
          },
        });
        peer.acknowledge();
        await transport.ready();
        const bytes = new Uint8Array([0, 0]);
        const accepted = parseRelayAcceptedLiveUpdate({
          receipt: {
            deliveryId: "delivery",
            updateDigest: createHash("sha256").update(bytes).digest("hex"),
            journalCursor: 1,
            acceptingHostEpoch: 1,
          },
          binding: {
            workspaceId: "workspace",
            mainVersionId: "main",
            objectId: "one",
            lineageClaimId: "a".repeat(64),
            currentPath: "one.md",
            selectorPaths: ["one.md"],
            restoreFenceGeneration: 0,
          },
          authority: {
            principalKind: "owner",
            principalId: "owner",
            grantId: null,
            grantGeneration: null,
          },
          receivedAtMs: 0,
        });
        const uploaded = Promise.withResolvers<void>();
        let chunks = 0;
        peer.onBlobChunk = () => {
          if (++chunks === streamCount) setImmediate(uploaded.resolve);
        };
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const signal = new AbortController();
          const pending = upload(
            transport,
            {
              id: 77,
              workspace: "ws-0000000000000001",
              registrationId: 1,
              deadlineMs: 30_000,
            },
            { metadata: { accepted, firstSeen: [] }, updateBytes: bytes },
            signal.signal,
          ).catch((error: unknown) => error);
          await uploaded.promise;
          if (mode === "busy")
            peer.send({
              type: "error",
              id: 1,
              error: {
                code: "OVERLOADED",
                message: "store-busy",
                retry: "afterBackoff",
              },
            });
          else if (mode === "deadline")
            await vi.advanceTimersByTimeAsync(30_000);
          else {
            peer.onEnvelope = (envelope) => {
              if (mode === "abort" && envelope.type === "cancel")
                peer.send({
                  type: "error",
                  id: envelope.id,
                  error: {
                    code: "CANCELLED",
                    message: "cancelled",
                    retry: "no",
                  },
                });
            };
            signal.abort();
          }
          expect(await pending).toBeInstanceOf(EngineClientError);
          peer.onEnvelope = (envelope) => {
            if (envelope.type === "request")
              peer.send({ type: "response", id: envelope.id, result: {} });
          };
          await expect(
            transport.sendRequest(request(2, "after.upload")),
          ).resolves.toMatchObject({ result: {} });
          if (mode.startsWith("abort")) {
            expect(peer.received).toContainEqual({ type: "cancel", id: 1 });
            expect(vi.getTimerCount()).toBe(0);
          }
        } finally {
          transport.close();
          vi.useRealTimers();
        }
      },
    );
    it.each([
      "abort",
      "abort-no-drain",
      "abort-final-response",
      "early-response",
      "early-response-no-drain",
      "final-response-no-drain",
    ])(
      "bounds concurrent uploads and preserves framing after %s",
      async (mode) => {
        const peer = new FakePeerConnection();
        const transport = client(peer, {
          privateLiveApplication: {
            aggregateBytes: 128 * 1024 * 1024,
            maxUploads: 1,
          },
        });
        peer.acknowledge();
        await transport.ready();
        vi.useFakeTimers();
        try {
          const bytes = new Uint8Array([0, 0]);
          const accepted = parseRelayAcceptedLiveUpdate({
            receipt: {
              deliveryId: "delivery",
              updateDigest: createHash("sha256").update(bytes).digest("hex"),
              journalCursor: 1,
              acceptingHostEpoch: 1,
            },
            binding: {
              workspaceId: "workspace",
              mainVersionId: "main",
              objectId: "one",
              lineageClaimId: "a".repeat(64),
              currentPath: "one.md",
              selectorPaths: ["one.md"],
              restoreFenceGeneration: 0,
            },
            authority: {
              principalKind: "owner",
              principalId: "owner",
              grantId: null,
              grantGeneration: null,
            },
            receivedAtMs: 0,
          });
          const reached = Promise.withResolvers<void>();
          let chunks = 0;
          peer.onEnvelope = (envelope) => {
            if (
              mode !== "final-response-no-drain" && mode !== "abort-final-response" &&
              envelope.type === "blobStart"
            ) {
              peer.backpressured = true;
              reached.resolve();
            }
          };
          peer.onBlobChunk = () => {
            chunks++;
            if ((mode === "final-response-no-drain" || mode === "abort-final-response") && chunks === streamCount) {
              peer.backpressured = true;
              reached.resolve();
              peer.send({
                type: "response",
                id: 1,
                result: { status: "applied" },
              });
            }
          };
          const signal = new AbortController();
          const event = {
            metadata: { accepted, firstSeen: [] },
            updateBytes: bytes,
          };
          const pending = upload(
            transport,
            {
              id: 1,
              workspace: "ws-0000000000000001",
              registrationId: 1,
              deadlineMs: 30_000,
            },
            event,
            signal.signal,
          ).catch((error: unknown) => error);
          await reached.promise;
          await expect(
            upload(
              transport,
              {
                id: 2,
                workspace: "ws-0000000000000001",
                registrationId: 1,
                deadlineMs: 30_000,
              },
              event,
            ),
          ).rejects.toThrow("capacity is full");
          if (mode.startsWith("abort")) {
            signal.abort();
            if (mode !== "abort-no-drain") {peer.onEnvelope = null; peer.drain();}
            else await vi.advanceTimersByTimeAsync(30_000);
          }
          else {
            if (mode !== "final-response-no-drain")
              peer.send({
                type: "response",
                id: 1,
                result: { status: "applied" },
              });
            if (mode === "early-response") peer.drain();
            else await vi.advanceTimersByTimeAsync(30_000);
          }
          expect(await pending).toBeInstanceOf(EngineClientError);
          peer.drain();
          expect(chunks).toBe(
            mode === "final-response-no-drain" || mode === "abort" || mode === "abort-final-response" ? streamCount : 0,
          );
          if (mode === "abort" || mode === "abort-final-response") {
            expect(peer.received).toContainEqual({type:"cancel",id:1});
            peer.onEnvelope = envelope => {
              if (envelope.type === "request") peer.send({type:"response",id:envelope.id,result:{}});
            };
            await expect(transport.sendRequest(request(99,"after.cancel"))).resolves.toMatchObject({result:{}});
            expect(vi.getTimerCount()).toBe(0);
            return;
          }
          await expect(
            transport.sendRequest(request(99, "after.partial")),
          ).rejects.toThrow("is closed");
          await expect(
            upload(
              transport,
              {
                id: 3,
                workspace: "ws-0000000000000001",
                registrationId: 1,
                deadlineMs: 30_000,
              },
              event,
            ),
          ).rejects.toThrow("is closed");
        } finally {
          transport.close();
          vi.useRealTimers();
        }
      },
    );
  },
);

describe("private admitted-update upload", () => {
  it("captures a valid maximum-size Yjs update through the real client", async () => {
    const maximum = 20 * 1024 * 1024;
    const rangeCount = 16_385;
    const single = (clientId: number, length: number): Uint8Array => {
      const doc = new Y.Doc();
      doc.clientID = clientId;
      doc.getText("plainText").insert(0, "x".repeat(length));
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    };
    const small = Array.from({ length: rangeCount - 1 }, (_, index) =>
      single(index + 1, 1),
    );
    const encode = (length: number): Uint8Array =>
      Y.mergeUpdates([...small, single(rangeCount, length)]);
    const measured = encode(maximum - 100);
    const finalLength = maximum - (measured.length - (maximum - 100));
    const bytes = encode(finalLength);
    expect(bytes).toHaveLength(maximum);
    const binding = {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "one",
      lineageClaimId: createHash("sha256")
        .update(new Uint8Array([0, 0]))
        .digest("hex"),
      currentPath: "one.md",
      selectorPaths: ["one.md"],
      restoreFenceGeneration: 0,
    };
    const accepted = parseRelayAcceptedLiveUpdate({
      receipt: {
        deliveryId: "delivery",
        updateDigest: createHash("sha256").update(bytes).digest("hex"),
        journalCursor: 1,
        acceptingHostEpoch: 1,
      },
      binding,
      authority: {
        principalKind: "owner",
        principalId: "owner",
        grantId: null,
        grantGeneration: null,
      },
      receivedAtMs: 0,
    });
    // An explicit path retains the exact client transcript for the Rust host test.
    const fixturePath = process.env.DOHC_LIVE_APPLICATION_CLIENT_FIXTURE;
    if (fixturePath) writeFileSync(fixturePath, new Uint8Array());
    class RecordingPeer extends FakePeerConnection {
      override write(buffer: Buffer): boolean {
        if (fixturePath) appendFileSync(fixturePath, buffer);
        return super.write(buffer);
      }
    }
    const peer = new RecordingPeer();
    const transport = client(peer, {
      privateLiveApplication: {
        aggregateBytes: 128 * 1024 * 1024,
        maxUploads: 1,
      },
    });
    peer.acknowledge();
    await transport.ready();
    let completed = 0;
    peer.onBlobChunk = (frame) => {
      if (frame.fin && ++completed === 2)
        peer.send({ type: "response", id: 1, result: { status: "applied" } });
    };
    const firstSeen = Array.from({ length: rangeCount }, (_, index) => ({
      clientId: index + 1,
      startClock: 0,
      endClock: index + 1 === rangeCount ? finalLength : 1,
    }));
    await transport.sendLiveApplication(
      {
        id: 1,
        workspace: "ws-0000000000000001",
        registrationId: 1,
        deadlineMs: 30_000,
      },
      { metadata: { accepted, firstSeen }, updateBytes: bytes },
    );
    expect(completed).toBe(2);
    transport.close();
  }, 30_000);
  it("frames exactly 20 MiB and more than 16,384 ranges under negotiated bounds", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      privateLiveApplication: {
        aggregateBytes: 128 * 1024 * 1024,
        maxUploads: 1,
      },
    });
    peer.acknowledge();
    await transport.ready();
    const bytes = Buffer.alloc(20 * 1024 * 1024, 7);
    const ranges = Array.from({ length: 16_385 }, (_, index) => ({
      clientId: index + 1,
      startClock: 0,
      endClock: 1,
    }));
    const accepted = parseRelayAcceptedLiveUpdate({
      receipt: {
        deliveryId: "delivery-1",
        updateDigest: createHash("sha256").update(bytes).digest("hex"),
        journalCursor: 1,
        acceptingHostEpoch: 1,
      },
      binding: {
        workspaceId: "workspace-1",
        mainVersionId: "main-1",
        objectId: "object-1",
        lineageClaimId: "lineage-1",
        currentPath: "notes/a.md",
        selectorPaths: ["notes/a.md"],
        restoreFenceGeneration: 0,
      },
      authority: {
        principalKind: "owner" as const,
        principalId: "owner-1",
        grantId: null,
        grantGeneration: null,
      },
      receivedAtMs: 0,
    });
    const streams = new Map<
      number,
      { hash: ReturnType<typeof createHash>; length: number; requestId: number }
    >();
    let updateDigest = "";
    let completed = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") {
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(
          LIMITS.maxFrameBytes,
        );
        expect(envelope.params).not.toHaveProperty("firstSeen");
      }
      if (envelope.type === "blobStart")
        streams.set(envelope.streamId, {
          hash: createHash("sha256"),
          length: 0,
          requestId: envelope.requestId,
        });
    };
    peer.onBlobChunk = (frame) => {
      expect(frame.payload.length).toBeLessThanOrEqual(
        LIMITS.maxBlobChunkBytes,
      );
      const stream = streams.get(frame.streamId)!;
      stream.hash.update(frame.payload);
      stream.length += frame.payload.length;
      if (frame.fin) {
        const digest = stream.hash.digest("hex");
        if (stream.length === bytes.length) updateDigest = digest;
        else expect(stream.length).toBe(ranges.length * 16);
        if (++completed === 2)
          peer.send({
            type: "response",
            id: stream.requestId,
            result: { status: "applied" },
          });
      }
    };
    await expect(
      transport.sendLiveApplication(
        {
          id: 71,
          workspace: "ws-0000000000000001",
          registrationId: 1,
          deadlineMs: 30_000,
        },
        { metadata: { accepted, firstSeen: ranges }, updateBytes: bytes },
      ),
    ).resolves.toMatchObject({ id: 71, result: { status: "applied" } });
    expect(updateDigest).toBe(accepted.receipt.updateDigest);
    expect(completed).toBe(2);
    transport.close();
  });
});

describe("request cancellation", () => {
  it("cancels a pending registration locally and keeps the connection usable", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const controller = new AbortController();
    const cancelled = new Error("registration cancelled");
    const registered = Promise.withResolvers<number>();
    const wireCancelled = Promise.withResolvers<number>();
    peer.onEnvelope = envelope => {
      if (envelope.type === "request") registered.resolve(envelope.id);
      if (envelope.type === "cancel") wireCancelled.resolve(envelope.id);
    };
    try {
      const request = transport.sendRequest({ id: 91, method: "liveApplication.register", workspace: "ws-0000000000000001", params: {}, deadlineMs: 30_000 }, controller.signal);
      const rejected = expect(request).rejects.toBe(cancelled);
      const wireId = await registered.promise;
      controller.abort(cancelled);
      await rejected;
      expect(await wireCancelled.promise).toBe(wireId);
      peer.send({ type: "response", id: wireId, result: { registrationId: 7 } });
      peer.onEnvelope = envelope => {
        if (envelope.type === "request") peer.send({ type: "response", id: envelope.id, result: { ok: true } });
      };
      await expect(transport.sendRequest({ id: 92, method: "engine.ping", params: {} })).resolves.toMatchObject({ result: { ok: true } });
    } finally { transport.close(); }
  });

  it("does not send an already cancelled registration", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const controller = new AbortController();
    const cancelled = new Error("already cancelled");
    controller.abort(cancelled);
    try {
      await expect(transport.sendRequest({ id: 93, method: "liveApplication.register", params: {}, deadlineMs: 30_000 }, controller.signal)).rejects.toBe(cancelled);
      expect(peer.received.filter(envelope => envelope.type === "request")).toEqual([]);
    } finally { transport.close(); }
  });
});

describe("private application range ordering", () => {
  it.each([
    ["separated ranges from one client", [{ clientId: 7, startClock: 0, endClock: 3 }, { clientId: 7, startClock: 5, endClock: 10 }], true],
    ["adjacent ranges", [{ clientId: 7, startClock: 0, endClock: 3 }, { clientId: 7, startClock: 3, endClock: 10 }], false],
    ["overlapping ranges", [{ clientId: 7, startClock: 0, endClock: 6 }, { clientId: 7, startClock: 5, endClock: 10 }], false],
    ["reversed clients", [{ clientId: 7, startClock: 0, endClock: 3 }, { clientId: 6, startClock: 5, endClock: 10 }], false],
    ["negative client", [{ clientId: -1, startClock: 0, endClock: 3 }], false],
  ] as const)("handles %s according to the admitted range contract", async (_name, firstSeen, allowed) => {
    const doc = new Y.Doc();
    doc.clientID = 7;
    doc.getText("body").insert(0, "abcdefghij");
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const accepted = parseRelayAcceptedLiveUpdate({
      receipt: { deliveryId: "ranges", updateDigest: createHash("sha256").update(bytes).digest("hex"), journalCursor: 1, acceptingHostEpoch: 1 },
      binding: { workspaceId: "workspace", mainVersionId: "main", objectId: "one", lineageClaimId: "a".repeat(64), currentPath: "one.md", selectorPaths: ["one.md"], restoreFenceGeneration: 0 },
      authority: { principalKind: "owner", principalId: "owner", grantId: null, grantGeneration: null }, receivedAtMs: 0,
    });
    const peer = new FakePeerConnection();
    const transport = client(peer, { privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 } });
    peer.acknowledge();
    await transport.ready();
    const packed: Buffer[] = [];
    let finished = 0;
    let uploadId = 0;
    peer.onEnvelope = envelope => { if (envelope.type === "blobStart") uploadId = envelope.requestId; };
    peer.onBlobChunk = frame => {
      if (frame.streamId === 2) packed.push(Buffer.from(frame.payload));
      if (frame.fin && ++finished === 2) peer.send({ type: "response", id: uploadId, result: { status: "applied" } });
    };
    try {
      const upload = transport.sendLiveApplication({ id: 73, workspace: "ws-0000000000000001", registrationId: 1, deadlineMs: 30_000 }, { metadata: { accepted, firstSeen }, updateBytes: bytes });
      if (allowed) {
        await expect(upload).resolves.toMatchObject({ result: { status: "applied" } });
        const wire = Buffer.concat(packed);
        expect(Array.from({ length: wire.length / 16 }, (_, index) => ({ clientId: Number(wire.readBigUInt64LE(index * 16)), startClock: wire.readUInt32LE(index * 16 + 8), endClock: wire.readUInt32LE(index * 16 + 12) }))).toEqual(firstSeen);
      } else {
        await expect(upload).rejects.toThrow("Invalid live application range.");
        expect(finished).toBe(0);
      }
    } finally { transport.close(); }
  });
});

describe("private baseline upload", () => {
  function baseline(bytes: Uint8Array = new Uint8Array([0, 0])) {
    return {
      bootstrapId: "bootstrap",
      bootstrapMomentId: "moment",
      baselineMomentRelaySequence: 3,
      baselineRegisteredAtMs: 0,
      baselineDigest: createHash("sha256").update(bytes).digest("hex"),
      projectedMarkdownDigest: createHash("sha256").update("").digest("hex"),
      projectedMarkdownByteLength: 0,
      baselineBytes: bytes,
    };
  }
  const uploadRequest = {
    id: 42,
    workspace: "ws-0000000000000001",
    registrationId: 9,
    deadlineMs: 30_000,
  };

  it("captures a genuine maximum-size baseline and immutable metadata before backpressure", async () => {
    const maximum = 20 * 1024 * 1024;
    const encode = (length: number) => {
      const doc = new Y.Doc({ gc: false });
      doc.clientID = 1;
      doc.getMap("meta").set("schemaVersion", 1);
      const paragraph = new Y.XmlElement("paragraph"),
        text = new Y.XmlText();
      paragraph.insert(0, [text]);
      doc.getXmlFragment("body").insert(0, [paragraph]);
      text.insert(0, "x".repeat(length));
      text.delete(0, text.length);
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    };
    const measured = encode(maximum - 100),
      bytes = encode(maximum - 100 + maximum - measured.byteLength);
    expect(bytes.byteLength).toBe(maximum);
    const input = baseline(bytes),
      expected = { ...input };
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: {
          aggregateBytes: 128 * 1024 * 1024,
          maxUploads: 1,
        },
      });
    peer.acknowledge();
    await transport.ready();
    const entered = Promise.withResolvers<void>();
    let requestId = 0,
      streamId = 0,
      length = 0;
    const hash = createHash("sha256");
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") {
        requestId = envelope.id;
        expect(envelope.method).toBe("liveApplication.bootstrap");
        expect(envelope.params).toEqual({
          registrationId: 9,
          baselineStreamId: expect.any(Number),
          baseline: {
            bootstrapId: expected.bootstrapId,
            bootstrapMomentId: expected.bootstrapMomentId,
            baselineMomentRelaySequence: 3,
            baselineRegisteredAtMs: 0,
            baselineDigest: expected.baselineDigest,
            baselineByteLength: maximum,
            projectedMarkdownDigest: expected.projectedMarkdownDigest,
            projectedMarkdownByteLength: 0,
          },
        });
        peer.backpressured = true;
        entered.resolve();
      } else if (envelope.type === "blobStart") {
        expect(envelope).toMatchObject({
          requestId,
          totalBytes: maximum,
          sha256: expected.baselineDigest,
        });
        streamId = envelope.streamId;
      }
    };
    peer.onBlobChunk = (frame) => {
      expect(frame.streamId).toBe(streamId);
      expect(frame.payload.byteLength).toBeLessThanOrEqual(
        LIMITS.maxBlobChunkBytes,
      );
      hash.update(frame.payload);
      length += frame.payload.byteLength;
      if (frame.fin)
        peer.send({
          type: "response",
          id: requestId,
          result: { status: "bootstrapped", ack: { localYDocSequence: 0 } },
        });
    };
    try {
      const pending = transport.sendLiveBootstrap(uploadRequest, input);
      await entered.promise;
      bytes.fill(0);
      input.bootstrapId = "mutated";
      input.baselineMomentRelaySequence = 99;
      peer.drain();
      await expect(pending).resolves.toMatchObject({
        id: 42,
        result: { status: "bootstrapped", ack: { localYDocSequence: 0 } },
      });
      expect(length).toBe(maximum);
      expect(hash.digest("hex")).toBe(expected.baselineDigest);
      expect(
        peer.received.filter((envelope) => envelope.type === "blobStart"),
      ).toHaveLength(1);
    } finally {
      transport.close();
    }
  }, 30_000);

  it.each([
    "digest",
    "source-sequence",
    "timestamp",
    "projection-length",
    "identifier",
  ])(
    "refuses invalid baseline %s before sending or retaining capacity",
    async (field) => {
      const peer = new FakePeerConnection(),
        transport = client(peer, {
          privateLiveApplication: {
            aggregateBytes: 128 * 1024 * 1024,
            maxUploads: 1,
          },
        });
      peer.acknowledge();
      await transport.ready();
      try {
        const input = baseline();
        if (field === "digest") input.baselineDigest = "f".repeat(64);
        if (field === "source-sequence") input.baselineMomentRelaySequence = 0;
        if (field === "timestamp") input.baselineRegisteredAtMs = -1;
        if (field === "projection-length")
          input.projectedMarkdownByteLength = 2_097_153;
        if (field === "identifier") input.bootstrapId = "";
        await expect(
          transport.sendLiveBootstrap(uploadRequest, input),
        ).rejects.toThrow();
        expect(
          peer.received.filter((envelope) => envelope.type === "request"),
        ).toHaveLength(0);
        let id = 0;
        peer.onEnvelope = (envelope) => {
          if (envelope.type === "request") id = envelope.id;
        };
        peer.onBlobChunk = (frame) => {
          if (frame.fin)
            peer.send({
              type: "response",
              id,
              result: { status: "pending", reason: "store-busy" },
            });
        };
        await expect(
          transport.sendLiveBootstrap(uploadRequest, baseline()),
        ).resolves.toMatchObject({ result: { status: "pending" } });
      } finally {
        transport.close();
      }
    },
  );

  it("shares its capacity reservation with admitted-event uploads", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: {
          aggregateBytes: 128 * 1024 * 1024,
          maxUploads: 1,
        },
      });
    peer.acknowledge();
    await transport.ready();
    const input = baseline(),
      entered = Promise.withResolvers<void>(),
      abort = new AbortController();
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "blobStart") {
        peer.backpressured = true;
        entered.resolve();
      }
    };
    const pending = transport
      .sendLiveBootstrap(uploadRequest, input, abort.signal)
      .catch((error) => error);
    try {
      await entered.promise;
      const accepted = parseRelayAcceptedLiveUpdate({
        receipt: {
          deliveryId: "delivery",
          updateDigest: input.baselineDigest,
          journalCursor: 1,
          acceptingHostEpoch: 1,
        },
        binding: {
          workspaceId: "workspace",
          mainVersionId: "main",
          objectId: "one",
          lineageClaimId: input.baselineDigest,
          currentPath: "one.md",
          selectorPaths: ["one.md"],
          restoreFenceGeneration: 0,
        },
        authority: {
          principalKind: "owner",
          principalId: "owner",
          grantId: null,
          grantGeneration: null,
        },
        receivedAtMs: 0,
      });
      await expect(
        transport.sendLiveApplication(uploadRequest, {
          metadata: { accepted, firstSeen: [] },
          updateBytes: input.baselineBytes,
        }),
      ).rejects.toThrow("capacity is full");
      abort.abort();
      peer.drain();
      expect(await pending).toBeInstanceOf(EngineClientError);
    } finally {
      abort.abort();
      transport.close();
      await pending;
    }
  });
});

describe("a request that cannot be framed", () => {
  it("is refused by name, is not a transport failure, and leaves the session up", async () => {
    // A combined conflict resolution is the request that reaches this size in
    // practice. Before this check it died inside `encodeFrame` and surfaced as
    // `transport-error: Failed to send engine request N` — no limit, no size,
    // and a classification that sends a healthy session into the reconnect
    // machinery for a failure no reconnect can fix.
    //
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const requests: Array<Extract<Envelope, { type: "request" }>> = [];
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") requests.push(envelope);
    };

    const refusal = await transport
      .sendRequest({
        id: 1,
        method: "conflicts.resolve",
        params: { local: { mergedText: "x".repeat(LIMITS.maxFrameBytes) } },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(EngineClientError);
    const error = refusal as EngineClientError;
    expect(error.code).toBe("request-too-large");
    expect(error.message).toContain(
      `at most ${LIMITS.maxFrameBytes} encoded bytes`,
    );
    expect(error.message).toMatch(
      /observed \d+ encoded bytes for conflicts\.resolve/,
    );
    // The reconnect machinery must not read this as a daemon that went away.
    expect(isDaemonReconnectError(error)).toBe(false);

    // Nothing was written, and the session is untouched: the next request goes
    // out and is answered.
    expect(requests).toHaveLength(0);
    const answered = transport.sendRequest(request(2, "engine.ping"));
    expect(requests).toHaveLength(1);
    peer.send({ type: "response", id: requests[0]!.id, result: { ok: true } });
    await expect(answered).resolves.toMatchObject({ result: { ok: true } });
    transport.close();
  });
});

describe("R03 frame codec", () => {
  it("round-trips control payloads from zero bytes through the configured boundary", () => {
    const max = 1024;
    for (const payload of [
      Buffer.alloc(0),
      Buffer.from("hello", "utf8"),
      Buffer.alloc(max, 0xa5),
    ]) {
      const decoder = new FrameDecoder(max);
      expect(decoder.push(encodeFrame(1, 0, payload, max))).toEqual([
        { kind: "control", payload },
      ]);
      decoder.finish();
    }

    expect(() => encodeFrame(1, 0, Buffer.alloc(max + 1), max)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "frame-too-large" }),
    );
    const oversized = encodeFrame(1, 0, Buffer.alloc(max + 1), max + 1);
    expect(() => new FrameDecoder(max).push(oversized)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "frame-too-large" }),
    );
  });

  it("decodes a control frame fed one byte at a time", () => {
    const payload = Buffer.from("worst-case chunking", "utf8");
    const encoded = encodeFrame(1, 0, payload, 128);
    const decoder = new FrameDecoder(128);
    const frames = [];
    for (const byte of encoded) frames.push(...decoder.push(Buffer.from([byte])));
    expect(frames).toEqual([{ kind: "control", payload }]);
  });

  it("reports malformed/truncated input with typed errors and stays poisoned", () => {
    const decoder = new FrameDecoder(128);
    const bad = encodeFrame(1, 0, Buffer.from("bad"), 128);
    bad[0] = 0;
    expect(() => decoder.push(bad)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "bad-magic" }),
    );
    expect(() => decoder.push(encodeFrame(1, 0, Buffer.from("good"), 128))).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "bad-magic" }),
    );

    const truncated = new FrameDecoder(128);
    truncated.push(Buffer.from("DOP1"));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "truncated-frame" }),
    );
    expect(() => truncated.push(encodeFrame(1, 0, Buffer.alloc(0), 128))).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "truncated-frame" }),
    );
  });

  it("round-trips ordered multi-chunk BlobChunk frames and preserves FIN", () => {
    const decoder = new FrameDecoder(128, 8);
    const streamId = 0x0001_0203_0405_0607;
    const first = Buffer.from("blob-");
    const second = Buffer.from("bytes");
    const firstFrame = blobChunkFrame(streamId, first, false, 8);
    const finalFrame = blobChunkFrame(streamId, second, true, 8);

    expect(firstFrame[4]).toBe(FrameType.BlobChunk);
    expect(firstFrame[5]).toBe(0);
    expect(finalFrame[5]).toBe(1);
    expect(firstFrame.subarray(12, 20)).toEqual(
      Buffer.from([0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00]),
    );

    expect(
      decoder.push(
        Buffer.concat([firstFrame, finalFrame]),
      ),
    ).toEqual([
      { kind: "blobChunk", streamId, fin: false, payload: first },
      { kind: "blobChunk", streamId, fin: true, payload: second },
    ]);
    decoder.finish();
  });

  it("rejects over-limit BlobChunk bytes while encoding and decoding", () => {
    expect(() => blobChunkFrame(9, Buffer.alloc(9), true, 8)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-too-large",
      }),
    );

    const oversized = blobChunkFrame(9, Buffer.alloc(9), true, 9);
    expect(() => new FrameDecoder(128, 8).push(oversized)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-too-large",
      }),
    );
  });

  it("rejects a short BlobChunk payload with a typed error", () => {
    const header = Buffer.alloc(12);
    header.write("DOP1", 0, "ascii");
    header[4] = 2;
    header.writeUInt32LE(7, 8);
    expect(() => new FrameDecoder(128).push(header)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-missing-stream-id",
      }),
    );
  });

  it("rejects non-byte BlobChunk flags while encoding", () => {
    for (const flags of [Number.NaN, 0.5, 2 ** 32]) {
      expect(() =>
        encodeFrame(
          FrameType.BlobChunk,
          flags,
          { streamId: 1, bytes: Buffer.alloc(0) },
          8,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<EngineFrameError>>({
          code: "invalid-flags",
        }),
      );
    }
  });

  it("rejects a decoded BlobChunk stream id at 2^53", () => {
    const frame = Buffer.alloc(20);
    frame.write("DOP1", 0, "ascii");
    frame[4] = FrameType.BlobChunk;
    frame.writeUInt32LE(8, 8);
    frame.writeBigUInt64LE(2n ** 53n, 12);

    expect(() => new FrameDecoder(128).push(frame)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-stream-id-out-of-range",
      }),
    );
  });
});

describe("EngineClient", () => {
  it("keeps real Duplex.from teardown errors from reaching uncaughtException", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      const explicit = realStreamClient();
      explicit.readable.write(envelopeFrame(helloAck()));
      await explicit.transport.ready();
      explicit.transport.dispose();
      await nextImmediate();

      const timeout = realStreamClient(1);
      await expect(timeout.transport.ready()).rejects.toMatchObject({
        code: "connect-timeout",
      });
      await nextImmediate();

      const exited = realStreamClient();
      exited.readable.write(envelopeFrame(helloAck()));
      await exited.transport.ready();
      exited.transport.notifyProcessExit(17, null);
      await nextImmediate();

      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("sends hello first and rejects requests until helloAck unblocks it", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    expect(peer.received).toEqual([
      {
        type: "hello",
        protocolVersion: 2,
        authToken: "parent-secret",
        capabilities: ["core", "ydoc", "blobs"],
        lastSessionGeneration: null,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
    ]);
    await expect(transport.sendRequest(request(41, "before.ack"))).rejects.toMatchObject({
      code: "handshake-incomplete",
    });
    peer.acknowledge();
    await expect(transport.ready()).resolves.toBe(transport);
    expect(transport.helloAck?.sessionGeneration).toBe(7);
    transport.close();
  });

  it("correlates concurrent out-of-order responses without crossing logical ids", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const requests: Array<Extract<Envelope, { type: "request" }>> = [];
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") requests.push(envelope);
    };

    const first = transport.sendRequest(request(1001, "first"));
    const second = transport.sendRequest(request(1001, "second-adapter-same-id"));
    expect(requests.map(({ id }) => id)).toEqual([1, 2]);
    peer.send({ type: "response", id: requests[1]!.id, result: "second" });
    peer.send({ type: "response", id: requests[0]!.id, result: "first" });

    await expect(first).resolves.toEqual({ id: 1001, result: "first" });
    await expect(second).resolves.toEqual({ id: 1001, result: "second" });
    transport.close();
  });

  it("cancels the wire request behind a caller id", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const envelopes: Envelope[] = [];
    peer.onEnvelope = (envelope) => envelopes.push(envelope);

    const operation = transport.sendRequest(request(4_242, "slow.open"));
    await transport.cancelRequest(4_242);

    expect(envelopes).toMatchObject([
      { type: "request", id: 1, method: "slow.open" },
      { type: "cancel", id: 1 },
    ]);
    peer.send({
      type: "error",
      id: 1,
      error: {
        code: "CANCELLED",
        message: "request cancelled",
        retry: "no",
      },
    });
    await expect(operation).rejects.toMatchObject({
      wireError: { code: "CANCELLED" },
    });
    transport.close();
  });

  it("times out only the expired request and ignores its late reply", async () => {
    vi.useFakeTimers();
    try {
      const peer = new FakePeerConnection();
      const transport = client(peer);
      peer.acknowledge();
      await transport.ready();
      const requests: Array<Extract<Envelope, { type: "request" }>> = [];
      peer.onEnvelope = (envelope) => {
        if (envelope.type === "request") requests.push(envelope);
      };

      const expired = transport.sendRequest({
        ...request(55, "silent.method"),
        deadlineMs: 25,
      });
      const unrelated = transport.sendRequest(request(56, "unrelated.method"));
      // Its own class, and still `transport-error`: the request left and
      // nothing came back, so every caller that rebinds on a dropped socket
      // must keep rebinding here. The class is what lets the one caller that
      // set the deadline — `ydoc.open` — tell its own limit firing apart
      // from a socket that died, which a message match cannot do safely.
      const rejection = expect(expired).rejects.toMatchObject({
        name: "EngineRequestDeadlineError",
        code: "transport-error",
        method: "silent.method",
        deadlineMs: 25,
        message:
          "engine-request-deadline-exceeded: request 1 (silent.method) carries " +
          "a deadline of 25 ms and the daemon did not answer inside it.",
      });

      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersToNextTimerAsync();
      await rejection;
      await expect(expired).rejects.toBeInstanceOf(EngineRequestDeadlineError);
      peer.send({ type: "response", id: requests[0]!.id, result: "late" });
      peer.send({ type: "response", id: requests[1]!.id, result: "unrelated" });
      await expect(unrelated).resolves.toEqual({
        id: 56,
        result: "unrelated",
      });

      const afterTimeout = transport.sendRequest(
        request(57, "after.timeout"),
      );
      peer.send({ type: "response", id: requests[2]!.id, result: "alive" });
      await expect(afterTimeout).resolves.toEqual({ id: 57, result: "alive" });
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts requests still waiting by method, and drops one abandoned at its deadline", async () => {
    vi.useFakeTimers();
    try {
      const peer = new FakePeerConnection();
      const transport = client(peer);
      peer.acknowledge();
      await transport.ready();
      const requests: Array<Extract<Envelope, { type: "request" }>> = [];
      peer.onEnvelope = (envelope) => {
        if (envelope.type === "request") requests.push(envelope);
      };
      const abandoned = transport.sendRequest({ ...request(60, "workspace.open"), deadlineMs: 25 });
      void abandoned.catch(() => undefined);
      const answered = transport.sendRequest(request(61, "workspace.open"));
      const other = transport.sendRequest(request(62, "versions.active"));
      expect(transport.outstandingRequests("workspace.open")).toBe(2);
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersToNextTimerAsync();
      expect(transport.outstandingRequests("workspace.open")).toBe(1);
      peer.send({ type: "response", id: requests[1]!.id, result: null });
      await answered;
      expect(transport.outstandingRequests("workspace.open")).toBe(0);
      expect(transport.outstandingRequests("versions.active")).toBe(1);
      peer.send({ type: "response", id: requests[2]!.id, result: null });
      await other;
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a matching wire error with the generated WireError payload", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(55, "missing.method"));
    peer.send({
      type: "error",
      id: wireId,
      error: {
        code: "METHOD_NOT_FOUND",
        message: "method is unavailable",
        retry: "no",
      },
    });
    await expect(operation).rejects.toBeInstanceOf(EngineRequestError);
    await expect(operation).rejects.toMatchObject({
      requestId: 55,
      wireError: { code: "METHOD_NOT_FOUND" },
    });
    transport.close();
  });

  it("dispatches events to multiple subscribers and honors unsubscribe", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = transport.onEvent(first);
    transport.onEvent(second);
    const event = {
      type: "event" as const,
      seq: 1,
      sessionGeneration: 7,
      name: "workspace.changed",
      payload: { paths: ["note.md"] },
    };
    peer.send(event, 1);
    unsubscribe();
    peer.send({ ...event, seq: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("reassembles BlobChunk frames in order and dispatches only after FIN", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(4, "blob.reassembly")).catch(() => {});
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 27,
      totalBytes: 11,
      sha256: null,
    });

    peer.sendRaw(blobChunkFrame(27, Buffer.from("hello "), false));
    expect(onBlob).not.toHaveBeenCalled();
    peer.sendRaw(blobChunkFrame(27, Buffer.from("world"), true));

    expect(onBlob).toHaveBeenCalledOnce();
    expect(onBlob).toHaveBeenCalledWith({
      requestId: 4,
      streamId: 27,
      totalBytes: 11,
      sha256: null,
      bytes: Buffer.from("hello world"),
    });
    transport.close();
  });

  it("maps a completed blob wire request id back to the caller id", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(9_001, "blob.with.adapter.id"));

    peer.send({
      type: "blobStart",
      requestId: wireId,
      streamId: 26,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(26, Buffer.from("x"), true));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 9_001 }),
    );
    peer.send({ type: "response", id: wireId, result: "done" });
    await expect(operation).resolves.toEqual({ id: 9_001, result: "done" });
    transport.close();
  });

  it("preserves the caller id when the response resolves before the final chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(9_002, "blob.after.response"));

    peer.send({
      type: "blobStart",
      requestId: wireId,
      streamId: 28,
      totalBytes: 1,
      sha256: null,
    });
    peer.send({ type: "response", id: wireId, result: "done" });
    await expect(operation).resolves.toEqual({ id: 9_002, result: "done" });
    peer.sendRaw(blobChunkFrame(28, Buffer.from("x"), true));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 9_002 }),
    );
    transport.close();
  });

  it("rejects blob streams when the session did not negotiate the blobs capability", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(helloAck(LIMITS, ["core"]));
    await transport.ready();
    const pending = transport.sendRequest(request(11, "await.no.capability"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 60,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects blob streams the client did not request even if the ack offers them", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { capabilities: ["core"] });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(15, "await.unrequested"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 62,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects a blobStart that references an unknown request", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(16, "await.unknown.request"));
    peer.send({
      type: "blobStart",
      requestId: 99,
      streamId: 63,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-request" },
    });
  });

  it("caps buffered chunks across all streams", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(17, "await.global.chunks"));
    const oneByte = Buffer.from("x");
    // Two streams at exactly the per-stream cap (4096 each) fill the global cap
    // (8192); a third stream's first chunk then trips the global check while
    // its own per-stream count is zero.
    for (const streamId of [70, 71, 72]) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: null,
        sha256: null,
      });
    }
    for (const streamId of [70, 71]) {
      const flood: Buffer[] = [];
      for (let i = 0; i < 4096; i++) {
        flood.push(blobChunkFrame(streamId, oneByte, false));
      }
      peer.sendRaw(Buffer.concat(flood));
    }
    peer.sendRaw(blobChunkFrame(72, oneByte, false));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("accepts blob chunks larger than the negotiated control-frame limit", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck({
        ...LIMITS,
        maxFrameBytes: 64 * 1024,
        maxBlobChunkBytes: 256 * 1024,
      }),
    );
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(12, "blob.large.chunk")).catch(() => {});
    // Larger than maxFrameBytes (control-frame bound) but within the blob bound.
    const bytes = Buffer.alloc(100_000, 7);
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 61,
      totalBytes: bytes.length,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(61, bytes, true, 256 * 1024));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 61, bytes }),
    );
    transport.close();
  });

  it("preallocates announced blob bytes once without concatenating chunks", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(21, "blob.preallocated")).catch(() => {});

    const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 7);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 60_000) {
      const end = Math.min(bytes.byteLength, offset + 60_000);
      chunks.push(
        blobChunkFrame(62, bytes.subarray(offset, end), end === bytes.byteLength),
      );
    }
    const allocate = vi.spyOn(Buffer, "allocUnsafe");
    const concatenate = vi.spyOn(Buffer, "concat");

    try {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId: 62,
        totalBytes: bytes.byteLength,
        sha256,
      });
      for (const chunk of chunks) peer.sendRaw(chunk);

      // Compare the 2 MiB payload with Buffer.equals: vitest's generic deep
      // equality walks it element by element, which alone takes seconds and
      // made this test flaky against its own timeout.
      expect(onBlob).toHaveBeenCalledTimes(1);
      const delivered = onBlob.mock.calls[0]![0] as { streamId: number; bytes: Buffer };
      expect(delivered.streamId).toBe(62);
      expect(Buffer.from(delivered.bytes).equals(bytes)).toBe(true);
      expect(
        allocate.mock.calls.filter(([size]) => size === bytes.byteLength),
      ).toHaveLength(1);
      expect(
        concatenate.mock.calls.some(([, size]) => size === bytes.byteLength),
      ).toBe(false);
    } finally {
      allocate.mockRestore();
      concatenate.mockRestore();
      transport.close();
    }
  });

  it("aborts decoding the rest of a coalesced buffer when onFrame returns false", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(FrameType.Control, 0, Buffer.from("{}"));
    const seen = vi.fn(() => false);

    decoder.push(Buffer.concat([frame, frame, frame]), seen);

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("accepts matching blob SHA-256 and rejects a digest mismatch", async () => {
    const digest =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const matchingPeer = new FakePeerConnection();
    const matching = client(matchingPeer);
    matchingPeer.acknowledge();
    await matching.ready();
    const onBlob = vi.fn();
    matching.onBlob(onBlob);
    void matching.sendRequest(request(13, "blob.sha.match")).catch(() => {});
    matchingPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 31,
      totalBytes: 5,
      sha256: digest,
    });
    matchingPeer.sendRaw(blobChunkFrame(31, Buffer.from("hello"), true));
    expect(onBlob).toHaveBeenCalledOnce();
    matching.close();

    const mismatchPeer = new FakePeerConnection();
    const mismatch = client(mismatchPeer);
    mismatchPeer.acknowledge();
    await mismatch.ready();
    const pending = mismatch.sendRequest(request(2, "await.bad.blob"));
    mismatchPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 32,
      totalBytes: 5,
      sha256: "0".repeat(64),
    });
    mismatchPeer.sendRaw(blobChunkFrame(32, Buffer.from("hello"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-digest-mismatch" },
    });
  });

  it("retains and concatenates chunks when blob size is unknown", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(22, "blob.unknown.length")).catch(
      () => {},
    );
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 64,
      totalBytes: null,
      sha256:
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    const concatenate = vi.spyOn(Buffer, "concat");

    try {
      peer.sendRaw(blobChunkFrame(64, Buffer.from("hello "), false));
      peer.sendRaw(blobChunkFrame(64, Buffer.from("world"), true));

      expect(onBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 64,
          bytes: Buffer.from("hello world"),
        }),
      );
      expect(concatenate.mock.calls.some(([, size]) => size === 11)).toBe(true);
    } finally {
      concatenate.mockRestore();
      transport.close();
    }
  });

  it("clamps a peer's huge blob chunk limit to the client cap", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobChunkBytes: 4 });
    peer.send(
      helloAck({
        ...LIMITS,
        maxBlobChunkBytes: 0xffff_ffff,
      }),
    );
    await transport.ready();
    const pending = transport.sendRequest(request(3, "await.oversized.chunk"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 33,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(33, Buffer.from("12345"), true, 5));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-chunk-too-large" },
    });
  });

  it("rejects a flood of concurrent never-final blob streams", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(4, "await.stream.flood"));

    for (let streamId = 1; streamId <= 65; streamId += 1) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: null,
        sha256: null,
      });
    }

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "too-many-blob-streams" },
    });
  });

  it("enforces a global buffered blob byte budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 5 });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(5, "await.blob.backpressure"));
    for (const streamId of [34, 35]) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: null,
        sha256: null,
      });
    }
    peer.sendRaw(blobChunkFrame(34, Buffer.from("123"), false));
    peer.sendRaw(blobChunkFrame(35, Buffer.from("456"), false));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("reserves announced destinations against the global blob byte budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 5 });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(25, "await.blob.reservation"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 37,
      totalBytes: 3,
      sha256: null,
    });
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 38,
      totalBytes: 3,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("caps buffered chunk count per stream to bound tiny-chunk floods", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(7, "await.blob.chunkflood"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 51,
      totalBytes: null,
      sha256: null,
    });
    // One coalesced data event carrying 4097 one-byte chunks — under the byte
    // budget (64MB default) but past the per-stream chunk cap. The inline decode
    // path must halt mid-buffer rather than materialize the whole batch first.
    const oneByte = Buffer.from("x");
    const flood: Buffer[] = [];
    for (let i = 0; i <= 4096; i++) {
      flood.push(blobChunkFrame(51, oneByte, false));
    }
    peer.sendRaw(Buffer.concat(flood));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("drops a failed request's blob streams so a late FIN cannot dispatch", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    const failing = transport.sendRequest(request(18, "await.request.error"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 80,
      totalBytes: 11,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(80, Buffer.from("hello "), false));
    peer.send({
      type: "error",
      id: 1,
      error: { code: "INTERNAL", message: "nope", retry: "no" },
    });
    await expect(failing).rejects.toMatchObject({ code: "wire-error" });

    const witness = transport.sendRequest(request(19, "await.late.fin"));
    peer.sendRaw(blobChunkFrame(80, Buffer.from("world"), true));

    expect(onBlob).not.toHaveBeenCalled();
    await expect(witness).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-stream" },
    });
  });

  it("frees a cancelled request's mid-stream blob allocation", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 6 });
    peer.acknowledge();
    await transport.ready();
    const cancelled = transport.sendRequest(request(23, "blob.cancelled"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 82,
      totalBytes: 6,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(82, Buffer.from("abc"), false));
    await transport.cancelRequest(23);
    peer.send({
      type: "error",
      id: 1,
      error: { code: "CANCELLED", message: "cancelled", retry: "no" },
    });
    await expect(cancelled).rejects.toMatchObject({
      wireError: { code: "CANCELLED" },
    });

    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(24, "blob.after.cancel")).catch(() => {});
    peer.send({
      type: "blobStart",
      requestId: 2,
      streamId: 83,
      totalBytes: 6,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(83, Buffer.from("abcdef"), true));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 83, bytes: Buffer.from("abcdef") }),
    );
    transport.close();
  });

  it("refuses a configured frame limit the engine cannot honor", () => {
    // The engine clamps a requested limit up to 1 MiB; a client that asked
    // for less would otherwise have its receive cap raised by the ack.
    expect(() => client(new FakePeerConnection(), { maxFrameBytes: 128 * 1024 })).toThrow(
      /engine cannot honor less/,
    );
  });

  it("adopts the engine's clamped answer to a lowered frame limit", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxFrameBytes: 2 * 1024 * 1024 });
    peer.send(helloAck({ ...LIMITS, maxFrameBytes: 2 * 1024 * 1024 }));
    await transport.ready();
    const hello = peer.received.find((envelope) => envelope.type === "hello");
    expect(hello).toMatchObject({ maxFrameBytes: 2 * 1024 * 1024 });
    transport.close();
  });

  it("fails the handshake on malformed helloAck capabilities", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck(LIMITS, "not-blobs" as unknown as string[]),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
  });

  it("clamps the local chunk cap to the blob budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      maxBlobBytes: 5,
      maxBlobChunkBytes: 1024 * 1024,
    });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(20, "await.clamped.cap"));
    // 10 bytes exceeds the blob budget (5), so the decode-level bound must trip
    // even though the requested chunk cap was 1 MiB.
    peer.sendRaw(blobChunkFrame(81, Buffer.alloc(10), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-chunk-too-large" },
    });
  });

  it("rejects a duplicate blobStart for a still-active stream", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(6, "await.live.duplicate"));
    const start = {
      type: "blobStart" as const,
      requestId: 1,
      streamId: 36,
      totalBytes: 0,
      sha256: null,
    };
    peer.send(start);
    peer.send(start);
    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "duplicate-blob-stream" },
    });
  });

  it("accepts unique blob stream ids announced out of order", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(6, "await.out.of.order")).catch(() => {});
    // A higher id announced before a lower one is valid: ids are unique, not
    // ordered. Neither should tear down the session.
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 10,
      totalBytes: 1,
      sha256: null,
    });
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 9,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(10, Buffer.from("a"), true));
    peer.sendRaw(blobChunkFrame(9, Buffer.from("b"), true));

    expect(onBlob).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("rejects invalid and over-limit blobStart totalBytes", async () => {
    // 1.5 is a JSON-representable non-integer (unlike NaN, which serializes to
    // null), so it exercises the invalid-integer guard through the real wire.
    for (const [streamId, totalBytes, code] of [
      [40, -1, "invalid-blob-start"],
      [41, 1.5, "invalid-blob-start"],
      [46, 6, "blob-too-large"],
    ] as const) {
      const peer = new FakePeerConnection();
      const transport = client(peer, { maxBlobBytes: 5 });
      peer.acknowledge();
      await transport.ready();
      const pending = transport.sendRequest(request(8, "await.invalid.start"));
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes,
        sha256: null,
      });
      await expect(pending).rejects.toMatchObject({
        code: "protocol-error",
        cause: { code },
      });
    }
  });

  it("rejects FIN before the announced blob size is reached", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(9, "await.short.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 49,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(49, Buffer.from("1234"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-size-mismatch" },
    });
  });

  it("rejects empty non-final chunks and accepts an empty final chunk", async () => {
    const emptyPeer = new FakePeerConnection();
    const empty = client(emptyPeer);
    emptyPeer.acknowledge();
    await empty.ready();
    const pending = empty.sendRequest(request(10, "await.empty.chunk"));
    emptyPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 50,
      totalBytes: null,
      sha256: null,
    });
    emptyPeer.sendRaw(blobChunkFrame(50, Buffer.alloc(0), false));
    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "empty-blob-chunk" },
    });

    const finalPeer = new FakePeerConnection();
    const final = client(finalPeer);
    finalPeer.acknowledge();
    await final.ready();
    const onBlob = vi.fn();
    final.onBlob(onBlob);
    void final.sendRequest(request(14, "blob.empty.final")).catch(() => {});
    finalPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 51,
      totalBytes: 0,
      sha256: null,
    });
    finalPeer.sendRaw(blobChunkFrame(51, Buffer.alloc(0), true));
    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: Buffer.alloc(0) }),
    );
    final.close();
  });

  it("rejects a BlobChunk arriving before helloAck", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.sendRaw(blobChunkFrame(52, Buffer.alloc(0), true));

    await expect(transport.ready()).rejects.toMatchObject({
      code: "protocol-error",
    });
  });

  it("terminally rejects a BlobChunk stream over its announced total", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(5, "await.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 28,
      totalBytes: 4,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(28, Buffer.from("12345"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-too-large" },
    });
  });

  it("terminally rejects a BlobChunk over the negotiated chunk limit", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck({
        ...LIMITS,
        maxBlobChunkBytes: 4,
      }),
    );
    await transport.ready();
    const pending = transport.sendRequest(request(6, "await.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 30,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(30, Buffer.from("12345"), true, 5));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-chunk-too-large" },
    });
  });

  it("terminally rejects a BlobChunk for an unknown stream id", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(6, "await.blob"));
    peer.sendRaw(blobChunkFrame(404, Buffer.from("orphan"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-stream" },
    });
  });

  it("terminally rejects duplicate FIN for a completed BlobChunk stream", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    transport.onBlob(() => undefined);
    void transport.sendRequest(request(7, "blob.then.finish")).catch(() => {});
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 29,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(29, Buffer.from("x"), true));
    const pending = transport.sendRequest(request(8, "after.blob"));
    // The completed stream is gone; a late FIN is an unknown stream (fail-closed
    // teardown), with no per-id completed set retained.
    peer.sendRaw(blobChunkFrame(29, Buffer.alloc(0), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-stream" },
    });
  });

  it("does not resurrect or dispatch after a pre-ready error in the same chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    peer.sendRaw(
      Buffer.concat([
        envelopeFrame({
          type: "error",
          error: {
            code: "AUTH_FAILED",
            message: "bad token",
            retry: "no",
          },
        }),
        envelopeFrame(helloAck()),
        envelopeFrame(event()),
      ]),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
    expect(onEvent).not.toHaveBeenCalled();
    await expect(transport.sendRequest(request(1, "after.failure"))).rejects.toMatchObject(
      { code: "handshake-failed", message: expect.stringContaining("is closed") },
    );
  });

  it("does not dispatch after a ready connection error in the same chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const pending = transport.sendRequest(request(2, "interrupted"));

    peer.sendRaw(
      Buffer.concat([
        envelopeFrame({
          type: "error",
          error: {
            code: "INTERNAL",
            message: "connection failed",
            retry: "no",
          },
        }),
        envelopeFrame(helloAck()),
        envelopeFrame(event()),
      ]),
    );

    await expect(pending).rejects.toMatchObject({ code: "wire-error" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("unwraps a bounded response and event batch in order", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const operation = transport.sendRequest(request(81, "batched"));

    peer.send({
      type: "batch",
      envelopes: [
        { type: "response", id: wireId, result: "done" },
        event(2),
      ],
    });

    await expect(operation).resolves.toEqual({ id: 81, result: "done" });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(event(2));
    transport.close();
  });

  it("terminally rejects batches over maxBatchLen", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(82, "pending"));
    const envelopes = Array.from(
      { length: LIMITS.maxBatchLen + 1 },
      (_, index): Envelope => event(index + 1),
    );

    peer.send({ type: "batch", envelopes });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
    await expect(transport.sendRequest(request(83, "after.batch"))).rejects.toMatchObject(
      { code: "protocol-error", message: expect.stringContaining("is closed") },
    );
  });

  it("terminally rejects nested batches", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(84, "pending"));

    peer.send({
      type: "batch",
      envelopes: [{ type: "batch", envelopes: [] }],
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
    await expect(transport.sendRequest(request(85, "after.batch"))).rejects.toMatchObject(
      { code: "protocol-error", message: expect.stringContaining("is closed") },
    );
  });

  it("rejects helloAck frame limits below the negotiation floor", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck({
        ...LIMITS,
        maxFrameBytes: 64 * 1024 - 1,
      }),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
    await expect(transport.sendRequest(request(86, "after.ack"))).rejects.toMatchObject(
      { code: "handshake-failed", message: expect.stringContaining("is closed") },
    );
  });

  it("rejects an over-limit control frame co-chunked after helloAck", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const ack = helloAck({
      ...LIMITS,
      maxFrameBytes: 64 * 1024,
    });
    const oversizedEvent: Envelope = {
      ...event(),
      payload: { padding: "x".repeat(64 * 1024) },
    };

    peer.sendRaw(
      Buffer.concat([
        envelopeFrame(ack),
        envelopeFrame(oversizedEvent),
      ]),
    );

    await expect(transport.ready()).resolves.toBe(transport);
    expect(onEvent).not.toHaveBeenCalled();
    await expect(transport.sendRequest(request(87, "after.frame"))).rejects.toMatchObject(
      { code: "protocol-error", message: expect.stringContaining("is closed") },
    );
  });

  it("rejects in-flight work when the peer closes or the client is disposed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inFlight = transport.sendRequest(request(9, "slow"));
    peer.closeFromPeer();
    await expect(inFlight).rejects.toMatchObject({
      code: "transport-error",
    });

    const secondPeer = new FakePeerConnection();
    const second = client(secondPeer);
    secondPeer.acknowledge();
    await second.ready();
    const pending = second.sendRequest(request(10, "slow"));
    second.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
  });

  // AUDIT-KILLREC. A client that died because the daemon crashed and a client
  // the desktop deliberately closed are not the same condition: the first is a
  // relaunching daemon that callers must retry through (isTransportError gates
  // every rebind path), the second is a shutdown they must not. Reporting a
  // bare "closed" for both made a hard daemon kill abandon a recoverable
  // restart and permanently kill the editor's Y.Doc session.
  it("keeps reporting the transport failure that closed it, not a bare closed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    peer.closeFromPeer();

    await expect(
      transport.sendRequest(request(200, "after.daemon.death")),
    ).rejects.toMatchObject({ code: "transport-error" });
  });

  // The supervisor's wedge kill, on the real client. A wedged daemon never
  // exits on its own, so the supervisor kills it — and once this client is
  // closed, `notifyProcessExit` returns early, so the exit that follows can no
  // longer re-cause these rejections. Whatever is recorded here is final.
  it("reports a wedge kill as a transport failure so callers retry the replacement", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inFlight = transport.sendRequest(request(300, "wedged.work"));

    transport.closeUnresponsive();

    await expect(inFlight).rejects.toMatchObject({ code: "transport-error" });
    // And the later process exit cannot upgrade it, which is why the cause
    // above has to be right the first time.
    transport.notifyProcessExit(null, "SIGTERM");
    await expect(
      transport.sendRequest(request(301, "after.kill")),
    ).rejects.toMatchObject({ code: "transport-error" });
  });

  // The wedge detector's one production input. A daemon draining a large
  // backlog answers no probe — the probe cannot overtake its output queue — so
  // this counter is the only thing that tells the supervisor it is alive. If it
  // never advanced, every busy daemon would be killed as wedged.
  it("counts every frame it receives, which is what proves a busy daemon alive", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    const beforeWork = transport.inboundActivity();
    const pending = transport.sendRequest(request(400, "bulk.work"));
    const sent = peer.received.at(-1);
    peer.send({
      type: "response",
      id: (sent as { id: number }).id,
      result: "bulk",
    });
    await pending;

    // Traffic for an ordinary caller, not a probe: exactly the frames that
    // arrive while a probe waits its turn behind them.
    expect(transport.inboundActivity()).toBeGreaterThan(beforeWork);
  });

  // A wedge kill cannot be left on the 2-second timer that a deliberate close
  // uses. The supervisor reports the terminal failure immediately afterwards,
  // and the desktop answers that report with a modal; the event loop stops
  // there, so a deferred kill would wait for the user to dismiss it while the
  // wedged child kept running.
  it("forces termination for a wedge kill and defers it for a deliberate close", async () => {
    const forced: Array<boolean | undefined> = [];
    const wedged = new FakePeerConnection();
    const killedNow = new EngineClient(
      wedged,
      {
        authToken: "parent-secret",
        protocolVersion: 2,
        capabilities: ["core"],
        connectTimeoutMs: 5_000,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
      (force) => forced.push(force),
    );
    wedged.acknowledge();
    await killedNow.ready();
    killedNow.closeUnresponsive();

    const shutdown = new FakePeerConnection();
    const closedNormally = new EngineClient(
      shutdown,
      {
        authToken: "parent-secret",
        protocolVersion: 2,
        capabilities: ["core"],
        connectTimeoutMs: 5_000,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
      (force) => forced.push(force),
    );
    shutdown.acknowledge();
    await closedNormally.ready();
    closedNormally.close();

    // Only the wedge kill forces it. A deliberate close still gets the stdin
    // EOF and the grace period the Rust host needs to drain its actors.
    expect(forced).toEqual([true, false]);
  });

  it("still reports a deliberate close as closed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    transport.close();

    await expect(
      transport.sendRequest(request(201, "after.shutdown")),
    ).rejects.toMatchObject({ code: "closed" });
  });

  it("turns malformed peer bytes into a terminal typed client failure", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    peer.sendRaw(Buffer.alloc(12));
    await expect(transport.sendRequest(request(1, "after.bad.frame"))).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("is closed"),
    });
  });
});
