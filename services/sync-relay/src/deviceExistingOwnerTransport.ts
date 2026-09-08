import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { EngineClient, FrameDecoder, FrameType, encodeFrame, type Frame } from "@dohc/workspace-engine-client/daemon";
import { DeviceCreditWindow } from "@dohc/service-http";
import { deviceLiveHostReceive, type DeviceControlLimits, type DeviceLiveHostStart } from "@dohc/live-session-contract/device-control";
import { parseAdmittedLiveUpdateMetadata, type LiveUpdateStructRange } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { DeviceEngineConnection } from "./deviceEngineConnection.js";
import { configRecord } from "./deviceLiveHostConfig.js";

export interface ExistingOwnerSession {
  readonly nativeSessionId: string;
  /** Includes workspace attachment, renderer sender, session and lineage generation. */
  assertCurrent(): void;
  /** Resolves only after the renderer has queued new edits and flushed the old queue. */
  prepareHandoff(signal: AbortSignal): Promise<void>;
  finishHandoff(adopted: boolean): Promise<void>;
  remoteApplied(update: Uint8Array): Promise<void>;
}

export interface ExistingOwnerDeviceConfig {
  client: EngineClient;
  workspaces: readonly { workspaceId: string; workspaceHandle: string }[];
  ownerFor(binding: LiveObjectBinding): ExistingOwnerSession;
  maxQueuedBytes: number;
  maxFrameBytes: number;
  maxUploads: number;
  maxRegistrations: number;
  aggregateBytes: number;
  maxAdoptionBytes: number;
  maxAdoptionEvents: number;
  requestDeadlineMs: number;
}

interface Attachment {
  id: number; size: number; digest: string; bytes: Buffer; offset: number; started: boolean; finished: boolean;
}
interface Operation {
  id: number; method: string; workspace: string; params: Record<string, unknown>; signal: AbortController;
  timer: ReturnType<typeof setTimeout>; streams: Attachment[]; charge: number;
}
interface Registration { nativeId: number; binding: LiveObjectBinding; owner: ExistingOwnerSession; adopted: boolean; outboxId?: string; handoffTimer?: ReturnType<typeof setTimeout> }

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid device owner integer.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512) throw new Error("Invalid device owner identifier.");
  return value;
}

/** Curated remote host facade. It never forwards an arbitrary daemon method. */
export function startExistingOwnerDeviceTransport(options: {
  config: ExistingOwnerDeviceConfig; start: DeviceLiveHostStart; ws: WebSocket; limits: DeviceControlLimits; stop(): void;
}) {
  const { config, start, ws, limits } = options;
  for (const value of [config.maxQueuedBytes,config.maxUploads,config.maxRegistrations,config.aggregateBytes,config.maxAdoptionBytes,config.maxAdoptionEvents,config.requestDeadlineMs]) integer(value,1);
  integer(config.maxFrameBytes,1_048_576,16_777_216);
  if (config.maxAdoptionBytes * 3 + config.maxFrameBytes > config.aggregateBytes || config.maxQueuedBytes < Math.max(limits.maxPayloadBytes + 16,config.maxFrameBytes + 36)) throw new Error("Invalid existing owner transport budget.");
  const workspaces = new Map(config.workspaces.map(row => [row.workspaceHandle, row.workspaceId]));
  if (!workspaces.size || workspaces.size !== config.workspaces.length || new Set(workspaces.values()).size !== workspaces.size) throw new Error("Invalid existing owner workspaces.");
  const retired = new AbortController(), operations = new Map<number,Operation>(), registrations = new Map<number,Registration>();
  const decoder = new FrameDecoder(config.maxFrameBytes,256*1024);
  const receive = deviceLiveHostReceive(limits,{ maxPayloadBytes: limits.maxPayloadBytes,maxPendingBytes: config.maxQueuedBytes });
  const credit = new DeviceCreditWindow(receive.maxPendingBytes,receive.maxPayloadBytes);
  let received = 0, charged = 0, lastId = 0, lastStream = 0, ready = false, attached = false, closed = false, requestId = 0;
  const next = () => integer(++requestId,1);
  const stop = () => { if (closed) return; closed = true; retired.abort(new Error("Owner device connection retired."));
    for (const operation of operations.values()) { clearTimeout(operation.timer); operation.signal.abort(retired.signal.reason); }
    operations.clear(); connection.close();
    for (const registration of registrations.values()) { clearTimeout(registration.handoffTimer); void registration.owner.finishHandoff(false).catch(() => undefined); }
    registrations.clear(); options.stop(); };
  const connection = new DeviceEngineConnection(ws,limits,start.receive,config.maxQueuedBytes,stop);
  const check = () => { if (closed || retired.signal.aborted) throw new Error("Owner device connection retired."); };
  const send = (value: unknown): Promise<void> => new Promise((resolve,reject) => {
    check();
    const drained = () => { connection.offDrain(drained); connection.offClose(gone); resolve(); };
    const gone = () => { connection.offDrain(drained); connection.offClose(gone); reject(new Error("Owner device connection retired.")); };
    connection.onDrain(drained); connection.onClose(gone);
    try { if (connection.write(encodeFrame(FrameType.Control,0,Buffer.from(JSON.stringify(value)),config.maxFrameBytes))) drained(); }
    catch (error) { connection.offDrain(drained); connection.offClose(gone); reject(error); }
  });
  const registrationFor = (operation: Operation): Registration => {
    const registration = registrations.get(integer(operation.params.registrationId,1));
    if (!registration || workspaces.get(operation.workspace) !== registration.binding.workspaceId) throw new Error("Owner registration is unavailable.");
    return registration;
  };
  async function execute(operation: Operation): Promise<void> {
    let result: unknown;
    let owner: ExistingOwnerSession | undefined;
    try {
      check();
      const signal = AbortSignal.any([retired.signal,operation.signal.signal]);
      const request = { id: next(),workspace: operation.workspace,deadlineMs: config.requestDeadlineMs };
      if (operation.method === "liveApplication.hosts") {
        if (operation.workspace || Object.keys(operation.params).length) throw new Error("Invalid owner discovery.");
        result = { relayNamespace: start.relayNamespace,host: start.host,workspaces: config.workspaces,ownerSessions: { maxBytes: config.maxAdoptionBytes,maxEvents: config.maxAdoptionEvents } };
      } else if (operation.method === "liveApplication.register") {
        const params = configRecord(operation.params,["binding"]), binding = parseLiveObjectBinding(params.binding);
        if (workspaces.get(operation.workspace) !== binding.workspaceId) throw new Error("Owner workspace mismatch.");
        const existing = [...registrations.values()].find(row => isDeepStrictEqual(row.binding,binding));
        if (existing) { owner = existing.owner; owner.assertCurrent(); await send({type: "response",id: operation.id,result: {registrationId: existing.nativeId}}); return; }
        if (registrations.size >= config.maxRegistrations) throw new Error("Owner registration capacity exceeded.");
        owner = config.ownerFor(binding); owner.assertCurrent();
        const response = await config.client.sendRequest({ ...request,method: operation.method,params: { binding: { ...binding,selectorPaths: [...binding.selectorPaths] } } },signal);
        owner.assertCurrent();
        const nativeId = integer(configRecord(response.result,["registrationId"]).registrationId,1);
        registrations.set(nativeId,{ nativeId,binding,owner,adopted: false }); result = { registrationId: nativeId };
      } else {
        const registration = registrationFor(operation); owner = registration.owner; owner.assertCurrent();
        const native = { ...request,registrationId: registration.nativeId,sessionId: owner.nativeSessionId };
        if (operation.method === "liveApplication.ownerState") {
          configRecord(operation.params,["registrationId"]);
          if (registration.handoffTimer) throw new Error("Owner handoff is already active.");
          registration.handoffTimer = setTimeout(stop,config.requestDeadlineMs); registration.handoffTimer.unref();
          await owner.prepareHandoff(signal); owner.assertCurrent();
          const response = await config.client.sendRequest({ ...request,method: operation.method,params: { registrationId: registration.nativeId,sessionId: owner.nativeSessionId } },signal);
          owner.assertCurrent(); const state = configRecord(response.result,["adoptionId","expectedLocalSequence","throughCursor","outboxId"]);
          result = {adoptionId: state.adoptionId,expectedLocalSequence: state.expectedLocalSequence,
            throughCursor: state.throughCursor === null && state.outboxId === null ? 0 : state.throughCursor,sessionId: String(registration.nativeId)};
        } else if (operation.method === "liveApplication.ownerOutbox") {
          configRecord(operation.params,["registrationId"]);
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const response = await config.client.sendRequest({...request,method: "liveApplication.ownerState",params: {registrationId: registration.nativeId,sessionId: owner.nativeSessionId}},signal);
          owner.assertCurrent();
          const state = configRecord(response.result,["adoptionId","expectedLocalSequence","throughCursor","outboxId"]);
          registration.outboxId = state.outboxId === null ? undefined : string(state.outboxId);
          result = {outboxId: registration.outboxId ?? null};
        } else if (operation.method === "liveApplication.readOwnerOutbox" || operation.method === "liveApplication.acknowledgeOwnerOutbox") {
          if (!registration.adopted || !registration.outboxId) throw new Error("Owner outbox is unavailable.");
          const reading = operation.method === "liveApplication.readOwnerOutbox";
          const params = configRecord(operation.params,reading ? ["registrationId"] : ["registrationId","receipts"],reading ? ["cursor"] : []);
          const response = await config.client.sendRequest({...request,method: reading ? "ydoc.ownerOutbox.readPending" : "ydoc.ownerOutbox.acknowledge",
            params: {outboxId: registration.outboxId,...(reading ? (params.cursor === undefined ? {} : {cursor: params.cursor as never}) : {receipts: params.receipts as never})}},signal);
          owner.assertCurrent(); result = response.result;
        } else if (operation.method === "liveApplication.adoptOwner") {
          if (!registration.handoffTimer) throw new Error("Owner handoff was not prepared.");
          if (operation.params.sessionId !== String(registration.nativeId)) throw new Error("Owner session mismatch.");
          const response = await config.client.forwardLiveOwnerAdoption(native,operation.streams[0]!.bytes,config.maxAdoptionBytes,signal);
          owner.assertCurrent();
          const adopted = configRecord(response.result,["status","adoption"]);
          if (adopted.status !== "adopted") throw new Error("Owner adoption did not commit.");
          registration.adopted = true; clearTimeout(registration.handoffTimer); registration.handoffTimer = undefined; result = response.result;
        } else if (operation.method === "liveApplication.apply") {
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const update = operation.streams[0]!.bytes, packed = operation.streams[1]!.bytes, firstSeen: LiveUpdateStructRange[] = [];
          for (let offset = 0; offset < packed.length; offset += 16) firstSeen.push({ clientId: Number(packed.readBigUInt64LE(offset)),startClock: packed.readUInt32LE(offset+8),endClock: packed.readUInt32LE(offset+12) });
          const metadata = parseAdmittedLiveUpdateMetadata({ accepted: operation.params.accepted,firstSeen });
          const response = await config.client.sendLiveApplication(native,{ metadata,updateBytes: update },signal);
          owner.assertCurrent();
          if ((response.result as { status?: unknown }).status === "applied") await owner.remoteApplied(update);
          owner.assertCurrent(); result = response.result;
        } else if (operation.method === "liveApplication.settle") {
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const params = configRecord(operation.params,["registrationId","terminalReceipt"]);
          result = (await config.client.sendRequest({ ...request,method: operation.method,params: { registrationId: registration.nativeId,terminalReceipt: params.terminalReceipt as never } },signal)).result;
          owner.assertCurrent();
        } else throw new Error("Owner device method is unavailable.");
      }
      check(); if (operation.signal.signal.aborted) throw operation.signal.signal.reason;
      await send({ type: "response",id: operation.id,result });
      if (operation.method === "liveApplication.adoptOwner") await owner!.finishHandoff(true);
    } catch {
      if (owner) {try {owner.assertCurrent();} catch {stop();}}
      if (owner && ["liveApplication.ownerState","liveApplication.adoptOwner"].includes(operation.method)) {
        const registration = registrations.get(Number(operation.params.registrationId));
        clearTimeout(registration?.handoffTimer); if (registration) registration.handoffTimer = undefined;
        await owner.finishHandoff(false).catch(() => undefined);
      }
      if (!closed) await send({ type: "error",id: operation.id,error: { code: "FORBIDDEN",message: "owner-device-operation-refused",retryability: "no" } }).catch(stop);
    } finally { operations.delete(operation.id); charged -= operation.charge; clearTimeout(operation.timer); }
  }
  function attachment(id: unknown,size: unknown,digest: unknown): Attachment {
    const streamId = integer(id,lastStream+1), length = integer(size,0,config.maxAdoptionBytes), hash = string(digest);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid owner stream digest.");
    lastStream = streamId;
    return { id: streamId,size: length,digest: hash,bytes: Buffer.alloc(length),offset: 0,started: false,finished: false };
  }
  function frame(frame: Frame): void {
    check();
    if (frame.kind === "blobChunk") {
      const operation = [...operations.values()].find(row => row.streams.some(stream => stream.id === frame.streamId));
      const stream = operation?.streams.find(row => row.id === frame.streamId);
      if (!operation || !stream || !stream.started || stream.finished || stream.offset + frame.payload.length > stream.size || (!frame.payload.length && !frame.fin)) throw new Error("Invalid owner stream chunk.");
      frame.payload.copy(stream.bytes,stream.offset); stream.offset += frame.payload.length;
      if (frame.fin) {
        if (stream.offset !== stream.size || createHash("sha256").update(stream.bytes).digest("hex") !== stream.digest) throw new Error("Owner stream digest mismatch.");
        stream.finished = true;
        if (operation.streams.every(row => row.finished)) void execute(operation);
      } else if (stream.offset === stream.size) throw new Error("Owner stream has no terminal flag.");
      return;
    }
    const value = JSON.parse(frame.payload.toString("utf8")) as Record<string,unknown>;
    if (!ready) {
      const hello = configRecord(value,["type","protocolVersion","authToken","capabilities","maxFrameBytes","lastSessionGeneration"]);
      if (hello.type !== "hello" || hello.protocolVersion !== 2 || hello.authToken !== start.authToken || !Array.isArray(hello.capabilities) || !hello.capabilities.includes("blobs")) throw new Error("Invalid owner handshake.");
      ready = true;
      void send({ type: "helloAck",protocolVersion: 2,sessionGeneration: 1,capabilities: ["blobs"],limits: { maxFrameBytes: Math.min(integer(hello.maxFrameBytes,1_048_576),config.maxFrameBytes),maxBlobChunkBytes: 256*1024,maxStringBytes: 1_048_576,maxCollectionLen: 100_000,maxBatchLen: 1,maxJsonDepth: 32 } }).catch(stop);
      return;
    }
    if (value.type === "cancel") { const operation = operations.get(integer(value.id,1)); operation?.signal.abort(new Error("Owner operation cancelled.")); return; }
    if (value.type === "blobStart") {
      const operation = operations.get(integer(value.requestId,1)), stream = operation?.streams.find(row => row.id === value.streamId);
      if (!stream || stream.started || value.totalBytes !== stream.size || value.sha256 !== stream.digest) throw new Error("Invalid owner stream start.");
      stream.started = true; return;
    }
    if (value.type !== "request" || operations.size >= config.maxUploads) throw new Error("Owner operation capacity exceeded.");
    const id = integer(value.id,lastId+1), method = string(value.method), workspace = value.workspace == null ? "" : string(value.workspace);
    if (!["liveApplication.hosts","liveApplication.register","liveApplication.ownerState","liveApplication.ownerOutbox","liveApplication.readOwnerOutbox","liveApplication.acknowledgeOwnerOutbox","liveApplication.adoptOwner","liveApplication.apply","liveApplication.settle"].includes(method) || (method !== "liveApplication.hosts" && !workspaces.has(workspace)) || value.idempotencyKey != null) throw new Error("Owner method is unavailable.");
    const params = value.params as Record<string,unknown>;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid owner params.");
    const bytes = method === "liveApplication.adoptOwner" ? integer(params.byteLength,1,config.maxAdoptionBytes) : method === "liveApplication.apply" ? integer(params.updateByteLength,2,20_971_520) + integer(params.rangeCount,0)*16 : 0;
    const charge = bytes * 3 + config.maxFrameBytes;
    if (!Number.isSafeInteger(charge) || charged + charge > config.aggregateBytes) throw new Error("Owner operation capacity exceeded.");
    charged += charge; lastId = id;
    const signal = new AbortController(), timer = setTimeout(stop,Math.min(integer(value.deadlineMs ?? config.requestDeadlineMs,1),config.requestDeadlineMs)); timer.unref();
    const operation: Operation = { id,method,workspace,params,signal,timer,streams: [],charge };
    operations.set(id,operation);
    if (method === "liveApplication.adoptOwner") operation.streams = [attachment(params.streamId,params.byteLength,params.digest)];
    else if (method === "liveApplication.apply") {
      const accepted = configRecord(params.accepted,["receipt","binding","authority","receivedAtMs"]);
      const receipt = configRecord(accepted.receipt,["deliveryId","updateDigest","journalCursor","acceptingHostEpoch"]);
      // The sender allocates the update stream first and the range stream second.
      operation.streams = [attachment(params.updateStreamId,params.updateByteLength,receipt.updateDigest),attachment(params.rangeStreamId,integer(params.rangeCount)*16,params.rangeDigest)];
    } else void execute(operation);
  }
  const startup = (async () => {
    await config.client.ready();
    for (const workspace of config.workspaces) {
      check(); await config.client.sendRequest({ id: next(),method: "liveApplication.provisionOwner",workspace: workspace.workspaceHandle,
        params: { relayNamespace: start.relayNamespace,host: start.host },deadlineMs: config.requestDeadlineMs },retired.signal);
    }
    check(); attached = true; connection.control(Buffer.from(JSON.stringify({ type: "liveHost.transport",version: 1,receive })));
  })().catch(stop);
  return {
    receive(bytes: Buffer) { try { check(); if (!attached) throw new Error("Early owner bytes."); credit.receive(bytes.length); decoder.push(bytes,frame); received += bytes.length+16; credit.acknowledge(received); connection.acknowledge(received); } catch { stop(); } },
    credit(total: number) { try { connection.credit(total); } catch { stop(); } },
    async close() { stop(); await startup; },
  };
}
